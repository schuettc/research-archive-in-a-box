import base64
import hashlib
import io
import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Any, cast

import pytest
from aws_durable_execution_sdk_python import DurableContext
from aws_durable_execution_sdk_python.config import WaitForCallbackConfig
from aws_durable_execution_sdk_python.exceptions import (
    CallbackTimeoutError,
    StepError,
    WaitForConditionError,
)
from aws_durable_execution_sdk_python.waits import WaitForConditionConfig
from botocore.exceptions import ClientError

from archive_backend import ingest, submissions
from archive_backend.embeddings import Bedrock
from archive_backend.ingest import Clients, Env
from archive_contract.config import ArchiveConfig
from cruise.diagnose import diagnose
from cruise.rules import Context, Outcome, Registry

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"
SID = "sub-1"
STAGING = "staging"
CURATORS = "arn:aws:sns:us-east-1:1:curators"
ALERTS = "arn:aws:sns:us-east-1:1:alerts"
CONFIG = "/research-archive/test/archive-config"
ACTIVE = "/research-archive/test/catalog-active"
ARCHIVE = "archive"
DERIVED = "derived"
DAY = 86400
ENV = Env(
    submissions_table="submissions",
    reviews_table="reviews",
    settings_table="settings",
    staging_bucket=STAGING,
    curator_topic_arn=CURATORS,
    alert_topic_arn=ALERTS,
    archive_config_parameter=CONFIG,
    archive_bucket=ARCHIVE,
    derived_bucket=DERIVED,
    active_catalog_parameter=ACTIVE,
    catalog_table_a="catalog-a",
    catalog_table_b="catalog-b",
    site_domain="d111.cloudfront.net",
    lifecycle_function="lifecycle",
)


def _package(
    themes: list[str] | None = None, broken: bool = False, title: str | None = None
) -> dict[str, bytes]:
    """The sample package's files; with themes or a title, its manifest and checksum line
    rewritten."""
    files = {
        str(p.relative_to(SAMPLE)): p.read_bytes()
        for p in sorted(SAMPLE.rglob("*"))
        if p.is_file() and "_build" not in p.relative_to(SAMPLE).parts
    }
    if themes is not None or title is not None:
        manifest = json.loads(files["datapackage.json"])
        if themes is not None:
            manifest["archive:themes"] = themes
        if title is not None:
            manifest["title"] = title
        text = json.dumps(manifest, indent=2).encode()
        old = hashlib.sha256(files["datapackage.json"]).hexdigest()
        files["datapackage.json"] = text
        files["checksums.sha256"] = (
            files["checksums.sha256"]
            .decode()
            .replace(old, hashlib.sha256(text).hexdigest())
            .encode()
        )
    if broken:
        files["data/logger.csv"] += b"2024-06-02T00:00:00,S1,9.0,0.20,ok,C,TL-100,3.5,30\n"
    return files


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.published: dict[tuple[str, str], bytes] = {}
        self.tags: dict[str, str] = {}
        self.pending: dict[str, str] = {}
        self.copies: list[tuple[str, str]] = []
        self.copy_calls: list[dict[str, Any]] = []
        self.fail_copy = False
        self.sizes: dict[str, int] = {}
        self.downloads: list[str] = []

    def get_object_tagging(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        assert Bucket == STAGING
        assert Key in self.objects, Key
        tag = self.tags.get(Key)
        return {"TagSet": [{"Key": "GuardDutyMalwareScanStatus", "Value": tag}] if tag else []}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if Bucket != STAGING:
            return {"Body": io.BytesIO(self.published[(Bucket, Key)])}
        self.downloads.append(Key)
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, *, Bucket: str, Key: str, Body: Any, **_: Any) -> dict[str, Any]:
        body = Body.read() if hasattr(Body, "read") else Body
        if Bucket != STAGING:
            assert Bucket in (ARCHIVE, DERIVED)
            self.published[(Bucket, Key)] = body
        else:
            self.objects[Key] = body
        return {}

    def head_object(self, *, Bucket: str, Key: str, **extra: Any) -> dict[str, Any]:
        if Bucket == STAGING and Key in self.objects:
            body = self.objects[Key]
            size = self.sizes.get(Key, len(body))
        elif (Bucket, Key) in self.published:
            body = self.published[(Bucket, Key)]
            size = len(body)
        else:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        head: dict[str, Any] = {"Metadata": {}, "ContentLength": size}
        # S3 answers with the checksum only when asked for it.
        if extra.get("ChecksumMode") == "ENABLED":
            head["ChecksumSHA256"] = self._sha256(body)
        return head

    @staticmethod
    def _sha256(body: bytes) -> str:
        return base64.b64encode(hashlib.sha256(body).digest()).decode()

    def copy_object(
        self, *, Bucket: str, Key: str, CopySource: dict[str, str], **extra: Any
    ) -> dict[str, Any]:
        if self.fail_copy:
            raise RuntimeError("copy refused")
        if Bucket == ARCHIVE:
            # The publish's copy into the archive bucket, which S3 answers with the SHA-256 of
            # what it stored.
            assert CopySource["Bucket"] == STAGING
            body = self.objects[CopySource["Key"]]
            self.published[(Bucket, Key)] = body
            return {"CopyObjectResult": {"ChecksumSHA256": self._sha256(body)}}
        assert CopySource["Bucket"] == STAGING
        assert Bucket == STAGING
        body = self.objects[CopySource["Key"]]
        self.objects[Key] = body
        self.copies.append((CopySource["Key"], Key))
        self.copy_calls.append(extra)
        # S3 copies the source's tags unless told to replace them.
        tag = self.tags.get(CopySource["Key"])
        if extra.get("TaggingDirective") == "REPLACE" or tag is None:
            self.tags.pop(Key, None)
        else:
            self.tags[Key] = tag
        # And answers with the copy's checksum only when asked to compute one.
        if extra.get("ChecksumAlgorithm") == "SHA256":
            return {"CopyObjectResult": {"ChecksumSHA256": self._sha256(body)}}
        return {}

    def get_paginator(self, name: str) -> "FakeS3":
        assert name == "list_objects_v2"
        return self

    def paginate(self, *, Bucket: str, Prefix: str) -> Iterator[dict[str, Any]]:
        if Bucket == STAGING:
            keys = sorted(k for k in self.objects if k.startswith(Prefix))
        else:
            keys = sorted(k for b, k in self.published if b == Bucket and k.startswith(Prefix))
        for start in range(0, len(keys), 3):
            yield {"Contents": [{"Key": k} for k in keys[start : start + 3]]}

    def delete_objects(self, *, Bucket: str, Delete: dict[str, Any]) -> dict[str, Any]:
        for entry in Delete["Objects"]:
            if Bucket == STAGING:
                self.objects.pop(entry["Key"], None)
            else:
                self.published.pop((Bucket, entry["Key"]), None)
        return {}

    def keys(self, prefix: str) -> list[str]:
        return sorted(k for k in self.objects if k.startswith(prefix))


class FakeSubmissions:
    """The Submissions table, understanding the `SET ... REMOVE ...` updates ingest writes."""

    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {}

    def get_item(self, *, Key: dict[str, Any]) -> dict[str, Any]:
        item = self.items.get(Key["submissionId"])
        return {"Item": json.loads(json.dumps(item))} if item is not None else {}

    def update_item(self, *, Key: dict[str, Any], UpdateExpression: str, **kwargs: Any) -> Any:
        item = self.items[Key["submissionId"]]
        names = kwargs.get("ExpressionAttributeNames", {})
        values = kwargs.get("ExpressionAttributeValues", {})
        sets, _, removes = UpdateExpression.partition(" REMOVE ")
        if sets.startswith("REMOVE "):
            sets, removes = "", sets[len("REMOVE ") :]
        if sets:
            assert sets.startswith("SET ")
            for assignment in sets[4:].split(","):
                name, value = (part.strip() for part in assignment.split("="))
                item[names[name]] = values[value]
        for name in filter(None, (part.strip() for part in removes.split(","))):
            item.pop(names[name], None)
        return {}


class FakeReviews:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def put_item(self, *, Item: dict[str, Any], **_: Any) -> Any:
        self.events.append(Item)
        return {}


class FakeSettings:
    def __init__(self) -> None:
        self.policy: dict[str, Any] | None = None

    def get_item(self, *, Key: dict[str, Any]) -> dict[str, Any]:
        assert Key == {"name": "review-policy"}
        if self.policy is None:
            return {}
        return {"Item": {"name": "review-policy", "policy": json.dumps(self.policy)}}


class FakeSNS:
    def __init__(self) -> None:
        self.published: list[dict[str, Any]] = []

    def publish(self, **kwargs: Any) -> dict[str, str]:
        # SNS refuses a subject of 100 characters or more, or one with a control character.
        subject = kwargs.get("Subject", "")
        if len(subject) >= 100 or any(ord(ch) < 32 for ch in subject):
            raise RuntimeError("InvalidParameter: Subject")
        self.published.append(kwargs)
        return {"MessageId": "m"}

    def to(self, topic: str) -> list[dict[str, Any]]:
        return [p for p in self.published if p["TopicArn"] == topic]


class FakeLambda:
    def __init__(self) -> None:
        self.invokes: list[dict[str, Any]] = []
        self.fail = False

    def invoke(self, **kwargs: Any) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("invoke refused")
        self.invokes.append(kwargs)
        return {"StatusCode": 202}


class FakeDynamoDB:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str, str], dict[str, Any]] = {}

    def get_item(self, *, TableName: str, Key: dict[str, Any]) -> dict[str, Any]:
        item = self.items.get((TableName, Key["PK"]["S"], Key["SK"]["S"]))
        return {"Item": item} if item else {}

    def update_item(
        self, *, TableName: str, Key: dict[str, Any], ExpressionAttributeValues: Any, **_: Any
    ) -> dict[str, Any]:
        # The version claim on a dataset item none of these runs has published before.
        key = (TableName, Key["PK"]["S"], Key["SK"]["S"])
        assert key not in self.items
        self.items[key] = {**Key, "claimedBy": ExpressionAttributeValues[":sid"]}
        return {}

    def put_item(
        self, *, TableName: str, Item: dict[str, Any], ExpressionAttributeValues: Any, **_: Any
    ) -> dict[str, Any]:
        # The dataset item going live, written by the submission that claimed it.
        key = (TableName, Item["PK"]["S"], Item["SK"]["S"])
        assert self.items[key]["claimedBy"] == ExpressionAttributeValues[":sid"]
        self.items[key] = Item
        return {}

    def batch_write_item(self, *, RequestItems: dict[str, Any]) -> dict[str, Any]:
        for table, requests in RequestItems.items():
            for request in requests:
                item = request["PutRequest"]["Item"]
                self.items[(table, item["PK"]["S"], item["SK"]["S"])] = item
        return {}

    def scan(self, *, TableName: str) -> dict[str, Any]:
        return {"Items": [item for (table, _, _), item in self.items.items() if table == TableName]}


class FakeSSM:
    def get_parameter(self, *, Name: str) -> dict[str, Any]:
        if Name == ACTIVE:
            return {"Parameter": {"Value": "A"}}
        assert Name == CONFIG
        return {"Parameter": {"Value": json.dumps({"publisher": "Test", "profiles": ["core"]})}}


class Raw(str):
    """A callback result sent as this text, not as JSON."""


Script = list[Any]
"""Each callback wait's outcome in order: a payload, a `Raw` text, "timeout", or a callable
returning one."""


class FakeContext:
    """Runs steps once, recording each operation's name and result for a replay."""

    def __init__(
        self, world: "World", script: Script, before: dict[str, Callable[[], object]] | None = None
    ) -> None:
        self.world = world
        self.script = list(script)
        # What happens just before the step of each name runs, once.
        self.before = dict(before or {})
        self.log: list[tuple[str, str | None, Any]] = []
        self.timeouts: list[tuple[str | None, int]] = []
        self.polls: list[int] = []

    def step(self, func: Callable[[Any], Any], name: str | None = None) -> Any:
        if name in self.before:
            self.before.pop(name)()
        try:
            result = func(None)
        except Exception as error:
            # The SDK raises StepError once a step's retries are spent.
            self.log.append(("step", name, StepError(str(error))))
            raise StepError(str(error)) from error
        self.log.append(("step", name, result))
        return result

    def wait(self, duration: Any, name: str | None = None) -> None:
        self.log.append(("wait", name, duration.to_seconds()))

    def wait_for_condition(
        self,
        check: Callable[[Any, Any], Any],
        config: WaitForConditionConfig[Any],
        name: str | None = None,
    ) -> Any:
        state = config.initial_state
        attempt = 0
        while True:
            attempt += 1
            assert attempt < 10000, "the wait never ends"
            try:
                state = check(state, None)
                decision = config.wait_strategy(state, attempt)
            except Exception as error:
                # The SDK fails the operation on an error in the check or the strategy.
                self.log.append(("condition", name, WaitForConditionError(str(error))))
                raise WaitForConditionError(str(error)) from error
            if not decision.should_continue:
                self.log.append(("condition", name, state))
                return state
            self.polls.append(decision.delay_seconds)
            self.world.s3.tags.update(self.world.s3.pending)
            self.world.s3.pending = {}

    def wait_for_callback(
        self,
        submitter: Callable[[str, Any], None],
        name: str | None = None,
        config: WaitForCallbackConfig | None = None,
    ) -> Any:
        assert config is not None and config.timeout_seconds > 0
        self.timeouts.append((name, config.timeout_seconds))
        callback = f"cb-{len(self.timeouts)}"
        submitter(callback, None)
        assert self.world.item["callbackId"] == callback
        entry = self.script.pop(0)
        if callable(entry):
            entry = entry()
        if entry == "timeout":
            self.world.now += timedelta(seconds=config.timeout_seconds)
            self.log.append(("callback", name, "timeout"))
            raise CallbackTimeoutError("timed out")
        self.world.now += timedelta(hours=1)
        result = entry if isinstance(entry, Raw) else json.dumps(entry)
        self.log.append(("callback", name, result))
        return result


class ReplayContext:
    """Replays a finished run from its log: no step runs again, and the names must match."""

    def __init__(self, log: list[tuple[str, str | None, Any]]) -> None:
        self.log = list(log)

    def _next(self, kind: str, name: str | None) -> Any:
        logged_kind, logged_name, result = self.log.pop(0)
        assert (logged_kind, logged_name) == (kind, name)
        if isinstance(result, Exception):
            raise result
        return result

    def step(self, func: Callable[[Any], Any], name: str | None = None) -> Any:
        return self._next("step", name)

    def wait(self, duration: Any, name: str | None = None) -> None:
        self._next("wait", name)

    def wait_for_condition(self, check: Any, config: Any, name: str | None = None) -> Any:
        return self._next("condition", name)

    def wait_for_callback(self, submitter: Any, name: str | None = None, config: Any = None) -> Any:
        result = self._next("callback", name)
        if result == "timeout":
            raise CallbackTimeoutError("timed out")
        return result


class World:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.s3 = FakeS3()
        self.sns = FakeSNS()
        self.submissions = FakeSubmissions()
        self.reviews = FakeReviews()
        self.settings = FakeSettings()
        self.lambda_ = FakeLambda()
        self.now = datetime(2026, 11, 1, tzinfo=UTC)
        self.clients = Clients(
            s3=cast(ingest.S3, self.s3),
            sns=cast(ingest.SNS, self.sns),
            ssm=cast(ingest.SSM, FakeSSM()),
            dynamodb=cast(ingest.DynamoDB, FakeDynamoDB()),
            submissions=cast(submissions.Table, self.submissions),
            reviews=cast(submissions.Table, self.reviews),
            settings=cast(submissions.Table, self.settings),
            bedrock=cast(Bedrock, None),
            lambda_=self.lambda_,
        )
        monkeypatch.setattr(ingest, "clients", lambda env: self.clients)
        monkeypatch.setattr(ingest, "_clock", lambda: self.now)
        for name, value in {
            "SUBMISSIONS_TABLE": ENV.submissions_table,
            "REVIEWS_TABLE": ENV.reviews_table,
            "SETTINGS_TABLE": ENV.settings_table,
            "STAGING_BUCKET": STAGING,
            "CURATOR_TOPIC_ARN": CURATORS,
            "ALERT_TOPIC_ARN": ALERTS,
            "ARCHIVE_CONFIG_PARAMETER": CONFIG,
            "ARCHIVE_BUCKET": ENV.archive_bucket,
            "DERIVED_BUCKET": ENV.derived_bucket,
            "ACTIVE_CATALOG_PARAMETER": ENV.active_catalog_parameter,
            "CATALOG_TABLE_A": ENV.catalog_table_a,
            "CATALOG_TABLE_B": ENV.catalog_table_b,
            "SITE_DOMAIN": ENV.site_domain,
            "LIFECYCLE_FUNCTION": ENV.lifecycle_function,
        }.items():
            monkeypatch.setenv(name, value)
        self.submissions.items[SID] = {
            "submissionId": SID,
            "submitter": "alice",
            "status": "checking",
            "round": 1,
            "files": {},
            "newVersion": False,
            "approvals": [],
            "stale": False,
        }
        self.upload(1, _package())

    @property
    def item(self) -> dict[str, Any]:
        return self.submissions.items[SID]

    def upload(
        self,
        round: int,
        files: dict[str, bytes],
        scan: str = "NO_THREATS_FOUND",
        late: bool = False,
    ) -> None:
        """What the API and S3 hold after a round's upload, and GuardDuty's tags on it."""
        entries = []
        for path, body in files.items():
            key = f"incoming/{SID}/{round}/{path}"
            self.s3.objects[key] = body
            (self.s3.pending if late else self.s3.tags)[key] = scan
            entries.append(
                {"path": path, "size": len(body), "sha256": hashlib.sha256(body).hexdigest()}
            )
        self.item["files"][str(round)] = entries

    def resubmit(self, round: int, files: dict[str, bytes]) -> Callable[[], dict[str, Any]]:
        def send() -> dict[str, Any]:
            self.upload(round, files)
            self.item.update(round=round, status="checking")
            return {"kind": "resubmit", "round": round}

        return send

    def run(
        self, script: Script, before: dict[str, Callable[[], object]] | None = None
    ) -> tuple[dict[str, Any], FakeContext]:
        context = FakeContext(self, script, before)
        result = ingest.run({"submissionId": SID}, cast(DurableContext, context))
        assert context.script == [], "every scripted callback was used"
        return result, context

    def types(self) -> list[str]:
        return [e["type"] for e in self.reviews.events]


def _decision(decision: str, by: str = "carol", note: str | None = None) -> dict[str, Any]:
    return {"kind": "decision", "decision": decision, "by": by, "note": note}


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> World:
    return World(monkeypatch)


REVIEWED = ["scanned", "checked", "held", "entered-review"]


def test_approve_publishes_after_the_scan_check_hold_and_one_review(world: World) -> None:
    world.s3.tags.clear()
    world.upload(1, _package(), late=True)

    result, context = world.run([_decision("approve")])

    assert result["status"] == "published"
    assert world.item["status"] == "published"
    assert world.types() == [*REVIEWED, "published"]
    assert context.polls == [30]
    report = json.loads(world.s3.objects[f"reports/{SID}/1.json"])
    assert report["quality"]["errors"] == 0
    assert world.item["reportKey"] == f"reports/{SID}/1.json"
    assert sorted(held for _, held in world.s3.copies) == sorted(
        f"held/{SID}/{e['path']}" for e in world.item["files"]["1"]
    )
    assert world.s3.keys(f"held/{SID}/") == []
    dataset_id = world.item["datasetId"]
    assert result["datasetId"] == dataset_id and result["version"] == 1
    assert (ARCHIVE, f"open/{dataset_id}/1/datapackage.json") in world.s3.published
    assert (DERIVED, f"site/datasets/{dataset_id}/index.html") in world.s3.published
    assert world.item["rule"] is None
    assert world.item["approvals"] == ["carol"]
    assert "callbackId" not in world.item
    checked = world.reviews.events[1]
    assert (checked["errors"], checked["blocked"], checked["actor"]) == (0, False, "pipeline")
    entered = world.reviews.events[3]
    assert (entered["rule"], entered["outcome"], entered["audience"]) == (None, "one", "all")
    [message] = world.sns.to(CURATORS)
    assert message["MessageAttributes"]["audience"] == {"DataType": "String", "StringValue": "all"}
    assert world.sns.to(ALERTS) == []


def test_a_long_title_with_a_line_break_still_reaches_the_curators(world: World) -> None:
    title = "Stream temperature\n" + "at three invented sites " * 6
    assert len(title) >= 150 and "\n" in title
    world.s3.objects = {}
    world.upload(1, _package(title=title))

    result, _ = world.run([_decision("approve")])

    assert result["status"] == "published"
    [message] = world.sns.to(CURATORS)
    assert message["Subject"] == " ".join(f"Review: {title}".split())[:99]


def test_reject_ends_rejected_and_deletes_the_held_copy(world: World) -> None:
    result, _ = world.run([_decision("reject", note="Out of scope")])

    assert result["status"] == "rejected"
    assert world.item["status"] == "rejected"
    assert world.types() == [*REVIEWED, "rejected"]
    rejected = world.reviews.events[-1]
    assert (rejected["actor"], rejected["note"]) == ("carol", "Out of scope")
    assert world.s3.keys(f"held/{SID}/") == []
    assert "callbackId" not in world.item


def test_request_changes_then_approve_publishes_round_two(world: World) -> None:
    def changes() -> dict[str, Any]:
        assert world.item["status"] == "in-review"
        return _decision("request-changes", note="Add units")

    def resubmit() -> dict[str, Any]:
        assert world.item["status"] == "needs-changes"
        return world.resubmit(2, _package())()

    result, context = world.run([changes, resubmit, _decision("approve", by="dave")])

    assert result["status"] == "published"
    assert world.item["status"] == "published"
    assert world.item["round"] == 2
    assert world.types() == [*REVIEWED, *REVIEWED, "published"]
    assert [e["round"] for e in world.reviews.events] == [1, 1, 1, 1, 2, 2, 2, 2, 2]
    assert [t for _, t in context.timeouts][1] == 30 * DAY
    assert f"reports/{SID}/2.json" in world.s3.objects
    assert world.item["approvals"] == ["dave"]


def test_zips_left_under_held_are_no_part_of_the_next_round(world: World) -> None:
    left = f"held/{SID}/.zips/_zips/all/package.zip"

    def changes() -> dict[str, Any]:
        # As a publish that built its zips leaves held/: a zip beside the held files, here one
        # that alone weighs more than the archive takes.
        world.s3.objects[left] = b"PK"
        world.s3.sizes[left] = 20 * 1024**3
        return _decision("request-changes", note="Add units")

    def approve() -> dict[str, Any]:
        # The round was checked and held without the zip: the hold step replaced held/ whole.
        assert world.item["status"] == "in-review"
        assert world.s3.keys(f"held/{SID}/") == sorted(f"held/{SID}/{p}" for p in _package())
        # The fake keeps a size apart from its object; the zip this publish builds is its own.
        del world.s3.sizes[left]
        return _decision("approve", by="dave")

    result, _ = world.run([changes, world.resubmit(2, _package()), approve])

    assert result["status"] == "published"
    checked = [e for e in world.reviews.events if e["type"] == "checked"]
    assert [e["blocked"] for e in checked] == [False, False]
    assert left not in world.s3.downloads


def test_a_blocking_error_returns_the_round_without_review(world: World) -> None:
    world.s3.objects = {}
    world.upload(1, _package(broken=True))

    def resubmit() -> dict[str, Any]:
        assert world.item["status"] == "needs-changes"
        assert world.item["callbackId"] == "cb-1"
        return world.resubmit(2, _package())()

    result, context = world.run([resubmit, _decision("approve")])

    assert result["status"] == "published"
    assert world.types() == ["scanned", "checked", *REVIEWED, "published"]
    first = world.reviews.events[1]
    assert first["blocked"] is True and first["errors"] > 0
    report = json.loads(world.s3.objects[f"reports/{SID}/1.json"])
    assert any(f["severity"] == "error" for f in report["findings"])
    assert world.s3.copies and all("/2/" in source for source, _ in world.s3.copies)
    assert context.timeouts[0] == ("resubmit-1", 30 * DAY)


def test_a_threat_tag_blocks_the_round_with_a_scan_finding(world: World) -> None:
    world.s3.tags[f"incoming/{SID}/1/data/logger.csv"] = "THREATS_FOUND"

    result, _ = world.run(["timeout"])

    assert result["status"] == "abandoned"
    assert world.types() == ["scanned", "checked", "abandoned"]
    assert world.reviews.events[0]["threats"] == {"data/logger.csv": "THREATS_FOUND"}
    report = json.loads(world.s3.objects[f"reports/{SID}/1.json"])
    assert [(f["ruleId"], f["severity"], f["target"]) for f in report["findings"]] == [
        ("scan.THREATS_FOUND", "error", {"path": "data/logger.csv"})
    ]
    assert world.s3.copies == []


def test_a_stored_file_of_another_size_than_declared_blocks_the_round_unread(
    world: World,
) -> None:
    # The upload link signs only the SHA-256, so a client may declare a size it does not send.
    world.s3.sizes[f"incoming/{SID}/1/data/logger.csv"] = 7

    result, _ = world.run(["timeout"])

    assert result["status"] == "abandoned"
    report = json.loads(world.s3.objects[f"reports/{SID}/1.json"])
    declared = next(e["size"] for e in world.item["files"]["1"] if e["path"] == "data/logger.csv")
    assert [
        (f["ruleId"], f["severity"], f["target"], f["message"]) for f in report["findings"]
    ] == [
        (
            "upload.size",
            "error",
            {"path": "data/logger.csv"},
            f"data/logger.csv is 7 bytes as uploaded, not the {declared:,} bytes the submission"
            " declared.",
        )
    ]
    assert world.reviews.events[1]["blocked"] is True
    assert world.s3.downloads == [] and world.s3.copies == []


LOGGER = f"incoming/{SID}/1/data/logger.csv"


def _other(body: bytes) -> bytes:
    """Other bytes of the same length."""
    return body[:-2] + b"0\n"


def test_a_stored_file_with_another_sha256_than_declared_blocks_the_round_unread(
    world: World,
) -> None:
    world.s3.objects[LOGGER] = _other(world.s3.objects[LOGGER])

    result, _ = world.run(["timeout"])

    assert result["status"] == "abandoned"
    report = json.loads(world.s3.objects[f"reports/{SID}/1.json"])
    assert [
        (f["ruleId"], f["severity"], f["target"], f["message"]) for f in report["findings"]
    ] == [
        (
            "upload.checksum",
            "error",
            {"path": "data/logger.csv"},
            "data/logger.csv as uploaded has another SHA-256 than the submission declared.",
        )
    ]
    assert world.reviews.events[1]["blocked"] is True
    assert world.s3.downloads == [] and world.s3.copies == []


def test_a_file_that_changes_between_check_and_hold_ends_the_submission_failed(
    world: World,
) -> None:
    def change() -> None:
        world.s3.objects[LOGGER] = _other(world.s3.objects[LOGGER])

    result, _ = world.run([], before={"hold-1": change})

    assert result["status"] == "failed"
    assert world.types() == ["scanned", "checked", "failed"]
    assert "data/logger.csv" in world.reviews.events[-1]["error"]
    assert world.s3.keys(f"held/{SID}/") == []
    [alert] = world.sns.to(ALERTS)
    assert SID in alert["Subject"]


def test_a_file_with_no_clean_scan_result_at_hold_ends_the_submission_failed(
    world: World,
) -> None:
    result, _ = world.run([], before={"hold-1": lambda: world.s3.tags.pop(LOGGER)})

    assert result["status"] == "failed"
    assert "scan" in world.reviews.events[-1]["error"]
    assert world.s3.keys(f"held/{SID}/") == []


def test_hold_copies_with_the_sha256_and_leaves_the_scan_result_on_each_copy(
    world: World,
) -> None:
    held: dict[str, str | None] = {}

    def look() -> None:
        held.update({key: world.s3.tags.get(key) for key in world.s3.keys(f"held/{SID}/")})

    world.run([_decision("reject")], before={"policy-1": look})

    assert len(held) == len(_package())
    assert set(held.values()) == {"NO_THREATS_FOUND"}
    assert all(
        call["ChecksumAlgorithm"] == "SHA256" and "TaggingDirective" not in call
        for call in world.s3.copy_calls
    )


def test_stored_files_totalling_more_than_the_limit_block_the_round_unread(world: World) -> None:
    for entry in world.item["files"]["1"][:2]:
        entry["size"] = 5 * 1024**3
        world.s3.sizes[f"incoming/{SID}/1/{entry['path']}"] = 5 * 1024**3

    result, _ = world.run(["timeout"])

    assert result["status"] == "abandoned"
    report = json.loads(world.s3.objects[f"reports/{SID}/1.json"])
    [finding] = report["findings"]
    assert (finding["ruleId"], finding["severity"]) == ("upload.total", "error")
    assert "more than the 9 GiB (9,663,676,416 bytes) this archive takes" in finding["message"]
    assert world.s3.downloads == []


def test_a_scan_that_never_finishes_ends_failed_after_a_day(world: World) -> None:
    world.s3.tags.clear()

    result, context = world.run([])

    assert result["status"] == "failed"
    assert world.item["status"] == "failed"
    assert world.types() == ["failed"]
    assert sum(context.polls) == DAY
    [alert] = world.sns.to(ALERTS)
    assert "never scanned" in alert["Message"]
    assert "never scanned" in world.reviews.events[-1]["error"]


def test_a_scan_ends_by_the_360th_day(world: World) -> None:
    def late_resubmit() -> dict[str, Any]:
        world.now += timedelta(days=359, hours=18)
        send = world.resubmit(2, _package())()
        world.s3.tags = {k: v for k, v in world.s3.tags.items() if "/2/" not in k}
        return send

    result, context = world.run([_decision("request-changes"), late_resubmit])

    assert result["status"] == "failed"
    assert world.types() == [*REVIEWED, "failed"]
    # The cap counts from the start: six hours left, less an hour for each callback.
    assert sum(context.polls) == 4 * 3600
    assert "never scanned" in world.sns.to(ALERTS)[0]["Message"]


def test_a_skip_rule_publishes_without_review(world: World) -> None:
    world.settings.policy = {"rules": [{"submitters": ["alice"], "outcome": "skip"}]}

    result, context = world.run([])

    assert result["status"] == "published"
    assert world.types() == ["scanned", "checked", "held", "published"]
    assert world.item["rule"] == 0
    assert world.reviews.events[-1]["rule"] == 0
    assert context.timeouts == []
    assert world.sns.published == []


def test_two_curators_wait_after_the_first_approval_and_publish_after_the_second(
    world: World,
) -> None:
    world.settings.policy = {
        "rules": [
            {"kind": "new-version", "outcome": "skip"},
            {"themes": ["soils"], "outcome": "two"},
        ],
        "reviewers": {"soils": ["rev-1", "rev-2"]},
    }
    world.s3.objects = {}
    world.upload(1, _package(themes=["soils", "water"]))

    def second() -> dict[str, Any]:
        assert world.item["approvals"] == ["carol"]
        assert world.item["status"] == "in-review"
        return _decision("approve", by="dave")

    result, context = world.run([_decision("approve"), second])

    assert result["status"] == "published"
    assert world.types() == [*REVIEWED, "published"]
    assert world.item["approvals"] == ["carol", "dave"]
    assert world.item["rule"] == 1
    assert [n for n, _ in context.timeouts] == ["review-1-1", "review-1-2"]
    [message] = world.sns.to(CURATORS)
    assert message["MessageAttributes"]["audience"]["StringValue"] == "rev-1"


def test_a_reminder_then_the_stale_mark_then_a_decision(world: World) -> None:
    world.settings.policy = {"reminders": [3], "staleDays": 5, "reviewers": {"soils": ["rev-1"]}}
    world.s3.objects = {}
    world.upload(1, _package(themes=["soils"]))

    result, context = world.run(["timeout", "timeout", "timeout", _decision("approve")])

    assert result["status"] == "published"
    assert world.types() == [*REVIEWED, "reminded", "stale", "published"]
    assert [t for _, t in context.timeouts] == [3 * DAY, 2 * DAY, 5 * DAY, 5 * DAY]
    assert world.item["stale"] is True
    audiences = [m["MessageAttributes"]["audience"]["StringValue"] for m in world.sns.to(CURATORS)]
    assert audiences == ["rev-1", "rev-1", "rev-1"]
    [alert] = world.sns.to(ALERTS)
    assert SID in alert["Message"]


def test_no_resubmit_within_thirty_days_ends_abandoned(world: World) -> None:
    result, context = world.run([_decision("request-changes"), "timeout"])

    assert result["status"] == "abandoned"
    assert world.item["status"] == "abandoned"
    assert world.types() == [*REVIEWED, "abandoned"]
    assert context.timeouts[-1] == ("resubmit-1", 30 * DAY)
    assert world.s3.keys(f"held/{SID}/") == []
    assert "callbackId" not in world.item


def test_a_failing_step_ends_failed_with_an_admin_alert(world: World) -> None:
    world.s3.fail_copy = True

    result, _ = world.run([])

    assert result["status"] == "failed"
    assert world.item["status"] == "failed"
    assert world.types() == ["scanned", "checked", "failed"]
    assert "copy refused" in world.reviews.events[-1]["error"]
    [alert] = world.sns.to(ALERTS)
    assert SID in alert["Subject"]


def test_each_long_step_starts_in_an_invocation_of_its_own(world: World) -> None:
    """A wait ends the invocation, so the step after it has the function's whole time limit."""
    _, context = world.run([_decision("approve")])

    log = [(kind, name) for kind, name, _ in context.log]
    for long in ("hold-1", "publish-1-zips", "publish-1-copy"):
        at = log.index(("step", long))
        assert log[at - 1] == ("wait", f"{long}-own-invocation")
    assert {result for kind, _, result in context.log if kind == "wait"} == {1}


def test_a_replay_repeats_no_step_and_names_each_operation_once(world: World) -> None:
    world.settings.policy = {"reminders": [3], "staleDays": 5}
    first, context = world.run(
        [
            "timeout",
            _decision("request-changes"),
            world.resubmit(2, _package()),
            _decision("request-changes"),
            "timeout",
        ]
    )
    names = [name for _, name, _ in context.log]
    assert len(names) == len(set(names))
    events, messages = len(world.reviews.events), len(world.sns.published)

    replayed = ingest.run({"submissionId": SID}, cast(DurableContext, ReplayContext(context.log)))

    assert replayed == first
    assert (len(world.reviews.events), len(world.sns.published)) == (events, messages)


@pytest.mark.parametrize("sent", [Raw("{not json"), Raw('"approve"'), ["approve"]])
def test_a_malformed_callback_ends_failed_with_an_admin_alert(world: World, sent: Any) -> None:
    result, _ = world.run([sent])

    assert result["status"] == "failed"
    assert world.item["status"] == "failed"
    assert world.types() == [*REVIEWED, "failed"]
    [alert] = world.sns.to(ALERTS)
    assert SID in alert["Subject"]


def test_a_submission_still_open_at_360_days_ends_expired(world: World) -> None:
    def late_changes() -> dict[str, Any]:
        world.now += timedelta(days=350)
        return _decision("request-changes")

    result, context = world.run([late_changes, "timeout"])

    assert result["status"] == "expired"
    assert world.item["status"] == "expired"
    assert world.types() == [*REVIEWED, "expired"]
    name, timeout = context.timeouts[-1]
    assert name == "resubmit-1"
    assert 9 * DAY < timeout <= 10 * DAY
    assert world.s3.keys(f"held/{SID}/") == []
    assert "callbackId" not in world.item


def test_a_wait_past_the_cap_ends_expired_before_it_starts(world: World) -> None:
    def very_late_changes() -> dict[str, Any]:
        world.now += timedelta(days=361)
        return _decision("request-changes")

    result, context = world.run([very_late_changes])

    assert result["status"] == "expired"
    assert world.types() == [*REVIEWED, "expired"]
    assert [n for n, _ in context.timeouts] == ["review-1-1"]


def test_a_failed_check_is_an_error_in_the_stored_report(monkeypatch: pytest.MonkeyPatch) -> None:
    registry = Registry()

    @registry.rule("values.broken", question="trust", scope="table", severity="warning")
    def broken(ctx: Context) -> Outcome:
        raise RuntimeError("no such thing")

    monkeypatch.setattr("archive_backend.ingest.diagnose", partial(diagnose, registry=registry))

    report, findings = ingest.diagnosed(SAMPLE, ArchiveConfig(publisher="x"), 1)

    assert [f["ruleId"] for f in report["findings"] if f["severity"] == "error"] == [
        "values.check-failed"
    ]
    assert report["quality"]["errors"] == 1
    assert [f.rule_id for f in findings] == ["values.check-failed"]
