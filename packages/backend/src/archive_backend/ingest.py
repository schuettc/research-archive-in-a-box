"""The ingest: one durable execution per submission, named by its id, from submit to its end.

Each round is scanned (GuardDuty's tag on every file), checked (`cruise.diagnose` under the
archive config), held (copied to `held/<id>/`, which never expires) and matched against the
review policy, read once. A round under review waits on a curator's callback, reminding and
marking stale on the policy's days; a blocked round or a request for changes waits 30 days on
the contributor's resubmit callback. Every wait is capped to end by 360 days after the start,
so a submission still open then ends itself as `expired` before the platform's one-year
execution timeout ends it without a word. Every call that reads the clock, the network or a random
value runs inside a named step, every status change writes its event in the same step, and a
step that fails after its retries ends the submission as `failed` with an admin alert.

Publish is a series of steps, each safe to repeat: claim the dataset's next version in the
active catalog (`claimedBy` on the dataset item, which leaves `currentVersion` alone), fill in
the manifest and regenerate its README and checksums, copy the files to the archive bucket (the
manifest last), put the catalog items the reindex would build into the active table (the
dataset item last, which moves `currentVersion` and drops the claim), write the dataset page,
rewrite the catalog file search reads and the sitemap, and finish. Readers get the version
before until the catalog step ends; a publish that fails before then releases its claim and
removes what it wrote of the version, so the live dataset is as it was. With the DOI module
on, after the page the version's DOI is registered with DataCite, its address written to
`archive:identifier`, and the catalog items and pages rewritten to show it; a DataCite failure
after the step's retries alerts and the publish finishes without a DOI.
"""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import string
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, cast, get_args

import boto3
from aws_durable_execution_sdk_python import (
    DurableContext,
    StepContext,
    durable_execution,
    durable_step,
)
from aws_durable_execution_sdk_python.config import Duration, WaitForCallbackConfig
from aws_durable_execution_sdk_python.exceptions import (
    CallbackTimeoutError,
    DurableOperationError,
)
from aws_durable_execution_sdk_python.waits import (
    WaitForConditionConfig,
    WaitForConditionDecision,
)
from botocore.exceptions import ClientError

from archive_backend import doi, pages, zips
from archive_backend.catalog_file import write_catalog_file
from archive_backend.config import read_archive_config
from archive_backend.embeddings import Bedrock, with_embedding
from archive_backend.lifecycle import home_prefix
from archive_backend.reindex import PREFIXES, catalog_items, dataset_item, withdrawal_of
from archive_backend.reindex import _sk as version_key
from archive_backend.sitemap import write_sitemap
from archive_backend.submissions import Table, put_event, stored_policy
from archive_contract import SubmissionFacts, match, reminder_schedule
from archive_contract.config import ArchiveConfig
from archive_contract.exports.readme import render_readme
from archive_contract.findings import Finding, Target
from archive_contract.manifest import AccessLevel, Manifest
from cruise.diagnose import diagnose

DAY = 86400
RESUBMIT_DAYS = 30
EXPIRY_DAYS = 360
SCAN_TAG = "GuardDutyMalwareScanStatus"
CLEAN = "NO_THREATS_FOUND"
MANIFEST = "datapackage.json"
THEMES = "archive:themes"
PIPELINE = "pipeline"
ALL = "all"
MAX_SCAN_DELAY = 3600
SCAN_LIMIT = DAY
DELETE_BATCH = 1000
README = "README.md"
CHECKSUMS = "checksums.sha256"
CATALOG_BATCH = 25
CATALOG_TRIES = 5
REFUSED = "ConditionalCheckFailedException"
SUFFIX = 6
SLUG_LENGTH = 60
CHUNK = 1024 * 1024


class S3(Protocol):
    def get_object_tagging(self, **kwargs: Any) -> dict[str, Any]: ...
    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def head_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def put_object(self, **kwargs: Any) -> Any: ...
    def copy_object(self, **kwargs: Any) -> Any: ...
    def get_paginator(self, name: str) -> Any: ...
    def delete_objects(self, **kwargs: Any) -> Any: ...


class SNS(Protocol):
    def publish(self, **kwargs: Any) -> Any: ...


class SSM(Protocol):
    def get_parameter(self, **kwargs: Any) -> dict[str, Any]: ...


class DynamoDB(Protocol):
    """The low-level client, for the catalog tables' DynamoDB JSON items."""

    def get_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def update_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def put_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def delete_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def query(self, **kwargs: Any) -> dict[str, Any]: ...
    def batch_write_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def scan(self, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Clients:
    s3: S3
    sns: SNS
    ssm: SSM
    dynamodb: DynamoDB
    submissions: Table
    reviews: Table
    settings: Table
    bedrock: Bedrock


@dataclass(frozen=True)
class Env:
    submissions_table: str
    reviews_table: str
    settings_table: str
    staging_bucket: str
    curator_topic_arn: str
    alert_topic_arn: str
    archive_config_parameter: str
    archive_bucket: str
    derived_bucket: str
    active_catalog_parameter: str
    catalog_table_a: str
    catalog_table_b: str
    site_domain: str

    @classmethod
    def from_environ(cls) -> Env:
        return cls(
            submissions_table=os.environ["SUBMISSIONS_TABLE"],
            reviews_table=os.environ["REVIEWS_TABLE"],
            settings_table=os.environ["SETTINGS_TABLE"],
            staging_bucket=os.environ["STAGING_BUCKET"],
            curator_topic_arn=os.environ["CURATOR_TOPIC_ARN"],
            alert_topic_arn=os.environ["ALERT_TOPIC_ARN"],
            archive_config_parameter=os.environ["ARCHIVE_CONFIG_PARAMETER"],
            archive_bucket=os.environ["ARCHIVE_BUCKET"],
            derived_bucket=os.environ["DERIVED_BUCKET"],
            active_catalog_parameter=os.environ["ACTIVE_CATALOG_PARAMETER"],
            catalog_table_a=os.environ["CATALOG_TABLE_A"],
            catalog_table_b=os.environ["CATALOG_TABLE_B"],
            site_domain=os.environ["SITE_DOMAIN"],
        )


def clients(env: Env) -> Clients:
    dynamodb = boto3.resource("dynamodb")

    def table(name: str) -> Table:
        return cast(Table, dynamodb.Table(name))

    return Clients(
        s3=cast(S3, boto3.client("s3")),
        sns=cast(SNS, boto3.client("sns")),
        ssm=cast(SSM, boto3.client("ssm")),
        dynamodb=cast(DynamoDB, boto3.client("dynamodb")),
        submissions=table(env.submissions_table),
        reviews=table(env.reviews_table),
        settings=table(env.settings_table),
        bedrock=cast(Bedrock, boto3.client("bedrock-runtime")),
    )


def _clock() -> datetime:
    return datetime.now(UTC)


class BadCallback(Exception):
    """A callback result the pipeline can't act on."""


class Expired(Exception):
    """The submission reached its 360 days still open."""


class NeverScanned(Exception):
    """GuardDuty never tagged every file of a round within the scan's time limit."""


class PublishConflict(Exception):
    """The dataset a submission publishes no longer is what it was when it was created."""


def _set(c: Clients, sid: str, fields: dict[str, Any], remove: tuple[str, ...] = ()) -> None:
    """Set and remove attributes on a submission."""
    names = {f"#f{i}": name for i, name in enumerate(fields)}
    names.update({f"#r{i}": name for i, name in enumerate(remove)})
    parts = []
    if fields:
        parts.append("SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(fields))))
    if remove:
        parts.append("REMOVE " + ", ".join(f"#r{i}" for i in range(len(remove))))
    update: dict[str, Any] = {
        "Key": {"submissionId": sid},
        "UpdateExpression": " ".join(parts),
        "ExpressionAttributeNames": names,
    }
    if fields:
        update["ExpressionAttributeValues"] = {
            f":f{i}": value for i, value in enumerate(fields.values())
        }
    c.submissions.update_item(**update)


def _submission(c: Clients, sid: str) -> dict[str, Any]:
    item = c.submissions.get_item(Key={"submissionId": sid}).get("Item")
    if item is None:
        raise KeyError(f"no submission {sid}")
    return cast(dict[str, Any], item)


def _incoming(sid: str, round: int, path: str) -> str:
    return f"incoming/{sid}/{round}/{path}"


def _delete_prefix(c: Clients, env: Env, prefix: str, bucket: str | None = None) -> None:
    """Delete every object under the prefix, in the staging bucket unless another is named."""
    bucket = bucket or env.staging_bucket
    keys: list[str] = []
    for page in c.s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        keys.extend(item["Key"] for item in page.get("Contents", []))
    for i in range(0, len(keys), DELETE_BATCH):
        c.s3.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": k} for k in keys[i : i + DELETE_BATCH]], "Quiet": True},
        )


def _subject(text: str) -> str:
    """SNS refuses a subject of 100 characters or more, or one with a line break."""
    return " ".join(text.split())[:99]


def _notify(c: Clients, env: Env, audience: str, subject: str, message: str) -> None:
    """A message on the curators' topic, for one named reviewer or `all` curators."""
    c.sns.publish(
        TopicArn=env.curator_topic_arn,
        Subject=_subject(subject),
        Message=message,
        MessageAttributes={"audience": {"DataType": "String", "StringValue": audience}},
    )


def _alert(c: Clients, env: Env, subject: str, message: str) -> None:
    c.sns.publish(TopicArn=env.alert_topic_arn, Subject=_subject(subject), Message=message)


def _payload(result: Any) -> dict[str, Any]:
    """A callback's result: the SDK passes the sent JSON through as text."""
    if isinstance(result, bytes | str):
        try:
            result = json.loads(result)
        except ValueError as error:
            raise BadCallback(f"callback result is not JSON: {error}") from error
    if not isinstance(result, dict):
        raise BadCallback(f"callback result is not an object: {result!r}")
    return result


@durable_step
def _start(_: StepContext, c: Clients, sid: str) -> dict[str, Any]:
    return {"round": int(_submission(c, sid)["round"]), "startedAt": _clock().isoformat()}


@durable_step
def _left(_: StepContext, started: str) -> int:
    """Seconds until the submission's 360 days are up."""
    end = datetime.fromisoformat(started) + timedelta(days=EXPIRY_DAYS)
    return int((end - _clock()).total_seconds())


@durable_step
def _files(_: StepContext, c: Clients, sid: str, round: int) -> list[str]:
    files = (_submission(c, sid).get("files") or {}).get(str(round)) or []
    return [str(f["path"]) for f in files]


@durable_step
def _scanned(_: StepContext, c: Clients, sid: str, round: int, tags: dict[str, str]) -> None:
    threats = {path: status for path, status in sorted(tags.items()) if status != CLEAN}
    put_event(c.reviews, sid, "scanned", PIPELINE, round, files=len(tags), threats=threats)


def _scan_findings(tags: dict[str, str]) -> list[Finding]:
    return [
        Finding(
            rule_id=f"scan.{status}",
            severity="error",
            message=f"The malware scan of {path} ended {status}.",
            target=Target(path=path),
        )
        for path, status in sorted(tags.items())
        if status != CLEAN
    ]


def _download(c: Clients, env: Env, sid: str, round: int, paths: list[str], into: Path) -> None:
    for path in paths:
        target = into / path
        target.parent.mkdir(parents=True, exist_ok=True)
        body = c.s3.get_object(Bucket=env.staging_bucket, Key=_incoming(sid, round, path))["Body"]
        with target.open("wb") as stream:
            shutil.copyfileobj(body, stream)


def _facts(manifest: dict[str, Any]) -> dict[str, Any]:
    access = manifest.get("archive:access")
    themes = manifest.get(THEMES)
    return {
        "title": str(manifest.get("title") or ""),
        "access": access if access in get_args(AccessLevel) else "public",
        "themes": [t for t in themes if isinstance(t, str)] if isinstance(themes, list) else [],
    }


def report_key(sid: str, round: int) -> str:
    """Where a round's findings report is kept in the staging bucket."""
    return f"reports/{sid}/{round}.json"


def diagnosed(
    folder: Path, config: ArchiveConfig, round: int
) -> tuple[dict[str, Any], list[Finding]]:
    """A round's findings report from the package at `folder`, under the archive config.

    The pipeline's check and a curator's edit to a held round write the same report."""
    result = diagnose(folder, config.load_profiles(), config.required)
    report: dict[str, Any] = {
        "round": round,
        "validation": result.validation.dump(),
        "quality": result.quality.dump() if result.quality else None,
        "findings": [f.dump() for f in result.findings],
    }
    return report, result.findings


def put_report(s3: Any, bucket: str, sid: str, round: int, report: dict[str, Any]) -> str:
    """Write (or replace) the round's findings report; its key."""
    key = report_key(sid, round)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(report, indent=2, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    return key


@durable_step
def _check(
    _: StepContext,
    c: Clients,
    env: Env,
    sid: str,
    round: int,
    paths: list[str],
    tags: dict[str, str],
) -> dict[str, Any]:
    """Diagnose the round (unless the scan blocked it), store the report, block on an error."""
    report: dict[str, Any] = {"round": round, "validation": None, "quality": None}
    findings = _scan_findings(tags)
    facts = _facts({})
    if not findings:
        config = read_archive_config(c.ssm, env.archive_config_parameter)
        with tempfile.TemporaryDirectory(prefix="ingest-") as tmp:
            folder = Path(tmp)
            _download(c, env, sid, round, paths, folder)
            report, findings = diagnosed(folder, config, round)
            try:
                manifest = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                manifest = {}
        facts = _facts(manifest if isinstance(manifest, dict) else {})
    else:
        report["findings"] = [f.dump() for f in findings]
    counts = {s: sum(1 for f in findings if f.severity == s) for s in ("error", "warning", "note")}
    key = put_report(c.s3, env.staging_bucket, sid, round, report)
    blocked = counts["error"] > 0
    if blocked:
        _set(c, sid, {"reportKey": key, "status": "needs-changes"}, remove=("callbackId",))
    else:
        _set(c, sid, {"reportKey": key})
    put_event(
        c.reviews,
        sid,
        "checked",
        PIPELINE,
        round,
        errors=counts["error"],
        warnings=counts["warning"],
        notes=counts["note"],
        reportKey=key,
        blocked=blocked,
    )
    return {"blocked": blocked, **facts}


@durable_step
def _hold(_: StepContext, c: Clients, env: Env, sid: str, round: int, paths: list[str]) -> None:
    """Replace `held/<id>/` with this round's files."""
    held = f"held/{sid}/"
    _delete_prefix(c, env, held)
    for path in paths:
        c.s3.copy_object(
            Bucket=env.staging_bucket,
            Key=held + path,
            CopySource={"Bucket": env.staging_bucket, "Key": _incoming(sid, round, path)},
        )
    put_event(c.reviews, sid, "held", PIPELINE, round, files=len(paths))


@durable_step
def _policy(
    _: StepContext, c: Clients, env: Env, sid: str, round: int, checked: dict[str, Any]
) -> dict[str, Any]:
    """Read the policy once, record the rule that matched, and enter review unless skipped."""
    item = _submission(c, sid)
    policy = stored_policy(c.settings)
    themes: list[str] = checked["themes"]
    facts = SubmissionFacts(
        submitter=str(item["submitter"]),
        submitter_is_curator=bool(item.get("submitterIsCurator")),
        kind="new-version" if item.get("newVersion") else "new-dataset",
        access=checked["access"],
        themes=tuple(themes),
    )
    outcome, rule = match(policy, facts)
    named = policy.reviewers.get(themes[0]) if themes else None
    audience = named[0] if named else ALL
    entered = _clock().isoformat()
    if outcome == "skip":
        _set(c, sid, {"rule": rule})
    else:
        _set(
            c,
            sid,
            {"rule": rule, "status": "in-review", "stale": False, "approvals": []},
            remove=("callbackId",),
        )
        put_event(
            c.reviews,
            sid,
            "entered-review",
            PIPELINE,
            round,
            rule=rule,
            outcome=outcome,
            audience=audience,
        )
        _notify(
            c,
            env,
            audience,
            f"Review: {checked['title'] or sid}",
            f"Submission {sid} round {round} is waiting for review"
            f" ({'two curators' if outcome == 'two' else 'one curator'}).",
        )
    return {
        "outcome": outcome,
        "rule": rule,
        "audience": audience,
        "enteredAt": entered,
        "reminders": reminder_schedule(policy),
        "staleDays": policy.stale_days,
    }


@durable_step
def _elapsed(_: StepContext, entered: str) -> int:
    return int((_clock() - datetime.fromisoformat(entered)).total_seconds())


@durable_step
def _remind(
    _: StepContext, c: Clients, env: Env, sid: str, round: int, day: int, audience: str
) -> None:
    put_event(c.reviews, sid, "reminded", PIPELINE, round, day=day, audience=audience)
    _notify(
        c,
        env,
        audience,
        f"Reminder: submission {sid} waits for review",
        f"Submission {sid} round {round} has waited {day} days for review.",
    )


@durable_step
def _stale(
    _: StepContext, c: Clients, env: Env, sid: str, round: int, days: int, audience: str
) -> None:
    _set(c, sid, {"stale": True})
    put_event(c.reviews, sid, "stale", PIPELINE, round, days=days, audience=audience)
    text = f"Submission {sid} round {round} has waited {days} days for review and is stale."
    _notify(c, env, audience, f"Stale: submission {sid} waits for review", text)
    _alert(c, env, f"Stale review: submission {sid}", text)


@durable_step
def _approve(_: StepContext, c: Clients, sid: str, by: str) -> list[str]:
    approvals = [str(a) for a in _submission(c, sid).get("approvals") or []]
    if by not in approvals:
        approvals.append(by)
    _set(c, sid, {"approvals": approvals})
    return approvals


@durable_step
def _reject(_: StepContext, c: Clients, env: Env, sid: str, round: int, by: str, note: Any) -> None:
    _delete_prefix(c, env, f"held/{sid}/")
    _set(c, sid, {"status": "rejected"}, remove=("callbackId",))
    put_event(c.reviews, sid, "rejected", by, round, note=note)


@durable_step
def _changes(_: StepContext, c: Clients, sid: str) -> None:
    # The API wrote the `decided` event before it sent this decision.
    _set(c, sid, {"status": "needs-changes"}, remove=("callbackId",))


@durable_step
def _abandon(_: StepContext, c: Clients, env: Env, sid: str, round: int) -> None:
    _delete_prefix(c, env, f"held/{sid}/")
    _set(c, sid, {"status": "abandoned"}, remove=("callbackId",))
    put_event(c.reviews, sid, "abandoned", PIPELINE, round, days=RESUBMIT_DAYS)


@durable_step
def _expire(_: StepContext, c: Clients, env: Env, sid: str) -> int:
    round = int(_submission(c, sid)["round"])
    _delete_prefix(c, env, f"held/{sid}/")
    _set(c, sid, {"status": "expired"}, remove=("callbackId",))
    put_event(c.reviews, sid, "expired", PIPELINE, round, days=EXPIRY_DAYS)
    return round


def _held(sid: str, path: str = "") -> str:
    return f"held/{sid}/{path}"


def _read(c: Clients, bucket: str, key: str) -> bytes:
    body: bytes = c.s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    return body


def _slug(title: str) -> str:
    """The title in lower-case words joined by hyphens, plus six random lower-case letters."""
    words = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    words = words[:SLUG_LENGTH].rstrip("-") or "dataset"
    return f"{words}-{''.join(secrets.choice(string.ascii_lowercase) for _ in range(SUFFIX))}"


def _meta_key(dataset_id: str) -> dict[str, Any]:
    return {"PK": {"S": f"DATASET#{dataset_id}"}, "SK": {"S": "META"}}


def _meta(c: Clients, table: str, dataset_id: str) -> dict[str, Any] | None:
    key = _meta_key(dataset_id)
    item: dict[str, Any] | None = c.dynamodb.get_item(TableName=table, Key=key).get("Item")
    return item


def _refused(error: ClientError) -> bool:
    return bool(error.response["Error"]["Code"] == REFUSED)


def _claim(
    c: Clients, table: str, dataset_id: str, version: int, sid: str, holder: str | None = None
) -> None:
    """Claim the version on the dataset item, so no other publish takes the same one; with a
    `holder`, take the claim over from that submission.

    The claim is `claimedBy` alone: `currentVersion` moves in the catalog step, whose put of the
    whole dataset item also drops the claim. A first version's claim is an item with no
    `currentVersion`, which every reader takes as no dataset.
    """
    values = {":sid": {"S": sid}}
    if version == 1:
        live = "attribute_not_exists(currentVersion)"
    else:
        live = "currentVersion = :prev"
        values[":prev"] = {"N": str(version - 1)}
    if holder is None:
        free = "attribute_not_exists(claimedBy)"
    else:
        free = "claimedBy = :holder"
        values[":holder"] = {"S": holder}
    try:
        c.dynamodb.update_item(
            TableName=table,
            Key=_meta_key(dataset_id),
            UpdateExpression="SET claimedBy = :sid",
            ConditionExpression=f"{live} AND {free}",
            ExpressionAttributeValues=values,
        )
    except ClientError as error:
        if not _refused(error):
            raise
        raise PublishConflict(
            f"version {version} of dataset {dataset_id} was taken by another publish"
        ) from None


def _live_version(meta: dict[str, Any] | None) -> int | None:
    """The dataset's live version; None for no item and for a first version's claim."""
    if meta is None or "currentVersion" not in meta:
        return None
    return int(meta["currentVersion"]["N"])


def _clear_version(c: Clients, env: Env, table: str, dataset_id: str, version: int) -> None:
    """Remove what a publish left of a version that never went live: its version and file items
    in the catalog and its folder in the archive bucket. Only ever called by the holder of the
    claim on that version, which is what says the version is not live. The bucket is versioned,
    so each delete adds a delete marker and the stored bytes stay."""
    query: dict[str, Any] = {
        "TableName": table,
        "KeyConditionExpression": "PK = :pk AND begins_with(SK, :sk)",
        "ExpressionAttributeValues": {
            ":pk": {"S": f"DATASET#{dataset_id}"},
            ":sk": {"S": version_key(version)},
        },
        "ProjectionExpression": "PK, SK",
    }
    keys: list[dict[str, Any]] = []
    while True:
        page = c.dynamodb.query(**query)
        keys.extend({"PK": item["PK"], "SK": item["SK"]} for item in page.get("Items", []))
        last = page.get("LastEvaluatedKey")
        if not last:
            break
        query["ExclusiveStartKey"] = last
    _write(c, table, [{"DeleteRequest": {"Key": key}} for key in keys])
    for prefix in PREFIXES:
        _delete_prefix(c, env, f"{prefix}/{dataset_id}/{version}/", env.archive_bucket)


def _active_table(c: Clients, env: Env) -> str:
    active = c.ssm.get_parameter(Name=env.active_catalog_parameter)["Parameter"]["Value"]
    return env.catalog_table_a if active == "A" else env.catalog_table_b


def _release(c: Clients, env: Env, sid: str, item: dict[str, Any]) -> None:
    """Give up the submission's claim, if it holds one, after removing what it wrote of the
    claimed version; a first version's claim-only item is deleted. A submission that holds no
    claim (it never claimed, or its version went live) changes nothing."""
    dataset_id = item.get("datasetId")
    if not dataset_id:
        return
    dataset_id = str(dataset_id)
    table = _active_table(c, env)
    meta = _meta(c, table, dataset_id)
    if meta is None or meta.get("claimedBy") != {"S": sid}:
        return
    live = _live_version(meta)
    _clear_version(c, env, table, dataset_id, (live or 0) + 1)
    held: dict[str, Any] = {
        "TableName": table,
        "Key": _meta_key(dataset_id),
        "ExpressionAttributeValues": {":sid": {"S": sid}},
    }
    try:
        if live is None:
            c.dynamodb.delete_item(
                ConditionExpression="claimedBy = :sid AND attribute_not_exists(currentVersion)",
                **held,
            )
        else:
            c.dynamodb.update_item(
                UpdateExpression="REMOVE claimedBy",
                ConditionExpression="claimedBy = :sid AND attribute_exists(currentVersion)",
                **held,
            )
    except ClientError as error:
        # Refused: the claim is no longer this submission's, so there is nothing to release.
        if not _refused(error):
            raise


@durable_step
def _version(_: StepContext, c: Clients, env: Env, sid: str) -> dict[str, Any]:
    """The dataset id (minted from the title when none was given) and its next version, read
    from the active catalog table and claimed there. A claim left by a submission that failed
    is taken over, and what that publish left of the version is removed."""
    item = _submission(c, sid)
    table = _active_table(c, env)
    dataset_id = item.get("datasetId")
    if not dataset_id:
        manifest = json.loads(_read(c, env.staging_bucket, _held(sid, MANIFEST)))
        dataset_id = _slug(str(manifest.get("title") or ""))
        # Kept before the claim, so a retry of this step claims the same id.
        _set(c, sid, {"datasetId": dataset_id})
    dataset_id = str(dataset_id)
    meta = _meta(c, table, dataset_id)
    live = _live_version(meta)
    if bool(item.get("newVersion")) != (live is not None):
        state = "is not" if live is None else "already is"
        raise PublishConflict(f"dataset {dataset_id} {state} in the catalog")
    version = (live or 0) + 1
    holder = (meta or {}).get("claimedBy", {}).get("S")
    # A claim that is already this submission's is this step's own, from a try that failed.
    if holder != sid:
        if holder is not None:
            other = c.submissions.get_item(Key={"submissionId": holder}).get("Item") or {}
            if other.get("status") != "failed":
                raise PublishConflict(
                    f"dataset {dataset_id} is being published by submission {holder}"
                )
        _claim(c, table, dataset_id, version, sid, holder)
    if holder is not None:
        # Taken over, or this step's retry of a takeover: the failed publish's leftovers go
        # before this one copies anything.
        _clear_version(c, env, table, dataset_id, version)
    _set(c, sid, {"datasetId": dataset_id, "status": "publishing"})
    return {"datasetId": dataset_id, "version": version, "table": table}


def _checksum_lines(text: str, changed: dict[str, bytes]) -> str:
    listed: dict[str, str] = {}
    for line in text.splitlines():
        digest, _, path = line.partition(" ")
        if line.strip():
            listed[path.lstrip(" *")] = digest
    for path, body in changed.items():
        listed[path] = hashlib.sha256(body).hexdigest()
    listed.pop(CHECKSUMS, None)
    return "".join(f"{listed[path]}  {path}\n" for path in sorted(listed))


@durable_step
def _fill(_: StepContext, c: Clients, env: Env, sid: str, target: dict[str, Any]) -> dict[str, Any]:
    """Fill in the held manifest, regenerate its README and rewrite its checksums."""
    dataset_id, version = target["datasetId"], int(target["version"])
    raw = json.loads(_read(c, env.staging_bucket, _held(sid, MANIFEST)))
    raw["id"] = dataset_id
    raw["version"] = str(version)
    raw["archive:published"] = _clock().strftime("%Y-%m-%dT%H:%M:%SZ")
    config = read_archive_config(c.ssm, env.archive_config_parameter)
    raw["archive:publisher"] = config.publisher
    raw["archive:identifier"] = pages.identifier(env.site_domain, dataset_id, version)
    manifest = Manifest.model_validate(raw)
    changed = {
        MANIFEST: (json.dumps(raw, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
        README: render_readme(manifest).encode("utf-8"),
    }
    # The check passed only with a matching checksums.sha256, so it is there.
    listed = _read(c, env.staging_bucket, _held(sid, CHECKSUMS)).decode("utf-8")
    changed[CHECKSUMS] = _checksum_lines(listed, changed).encode("utf-8")
    for path, body in changed.items():
        c.s3.put_object(Bucket=env.staging_bucket, Key=_held(sid, path), Body=body)
    held = _held(sid)
    files: list[str] = []
    for page in c.s3.get_paginator("list_objects_v2").paginate(
        Bucket=env.staging_bucket, Prefix=held
    ):
        files.extend(item["Key"][len(held) :] for item in page.get("Contents", []))
    withdrawn = withdrawal_of(_meta(c, target["table"], dataset_id)) is not None
    embargo = manifest.embargo_until.isoformat() if manifest.embargo_until else None
    return {
        "prefix": home_prefix(manifest.access, withdrawn, embargo, _clock().date()),
        "files": sorted(files),
        "published": raw["archive:published"],
        "dois": config.doi is not None,
    }


def _root(filled: dict[str, Any], target: dict[str, Any]) -> str:
    return f"{filled['prefix']}/{target['datasetId']}/{target['version']}/"


@durable_step
def _copy(
    _: StepContext,
    c: Clients,
    env: Env,
    sid: str,
    target: dict[str, Any],
    filled: dict[str, Any],
) -> int:
    """One checksummed PUT per file into the archive bucket, the manifest last."""
    paths = sorted(filled["files"], key=lambda p: (p == MANIFEST, p))
    root = _root(filled, target)
    for path in paths:
        with tempfile.TemporaryFile() as stream:
            body = c.s3.get_object(Bucket=env.staging_bucket, Key=_held(sid, path))["Body"]
            digest = hashlib.sha256()
            while chunk := body.read(CHUNK):
                digest.update(chunk)
                stream.write(chunk)
            stream.seek(0)
            put: dict[str, Any] = {
                "Bucket": env.archive_bucket,
                "Key": root + path,
                "Body": stream,
                "ChecksumSHA256": base64.b64encode(digest.digest()).decode("ascii"),
            }
            kind = mimetypes.guess_type(path)[0]
            if kind:
                put["ContentType"] = kind
            c.s3.put_object(**put)
    return len(paths)


def _write(c: Clients, table: str, requests: list[dict[str, Any]]) -> None:
    """Batch-write the put and delete requests, sending again whatever DynamoDB left out."""
    for i in range(0, len(requests), CATALOG_BATCH):
        left: dict[str, Any] = {table: requests[i : i + CATALOG_BATCH]}
        attempt = 0
        while left:
            if attempt:
                time.sleep(min(0.05 * 2**attempt, 5))
            left = c.dynamodb.batch_write_item(RequestItems=left).get("UnprocessedItems", {})
            attempt += 1


def _write_items(c: Clients, table: str, items: list[dict[str, Any]]) -> None:
    _write(c, table, [{"PutRequest": {"Item": item}} for item in items])


@durable_step
def _catalog(
    _: StepContext,
    c: Clients,
    env: Env,
    sid: str,
    target: dict[str, Any],
    filled: dict[str, Any],
) -> int:
    """The version, file and dataset items, built as the reindex builds them. The dataset item
    goes last and alone, in the one write that moves `currentVersion` and drops the claim: it
    is refused unless this submission holds the claim, or the version is already live (this
    step's own retry, and the DOI path's second run, which keeps a later publish's claim)."""
    dataset_id, version, prefix = target["datasetId"], int(target["version"]), filled["prefix"]
    table = target["table"]
    text = _read(c, env.archive_bucket, _root(filled, target) + MANIFEST).decode("utf-8")
    manifest = json.loads(text)
    items = catalog_items(prefix, dataset_id, version, text)
    _write_items(c, table, items)
    infrastructure = read_archive_config(c.ssm, env.archive_config_parameter).infrastructure
    embedding: dict[str, Any] | None = None
    if infrastructure is not None and infrastructure.modules.embeddings is not None:
        # Set before the put, so no later write can drop it.
        embedding = with_embedding({}, manifest, c.bedrock)
    lost = PublishConflict(
        f"the claim on dataset {dataset_id} was lost before version {version} went live"
    )
    for _try in range(CATALOG_TRIES):
        meta = _meta(c, table, dataset_id) or {}
        # A new version of a withdrawn dataset stays withdrawn: the put replaces the dataset item.
        item = dataset_item(dataset_id, [(prefix, version, manifest)], withdrawal_of(meta))
        item |= embedding or {}
        values: dict[str, Any] = {":sid": {"S": sid}, ":v": {"N": str(version)}}
        held, withdrawn = meta.get("claimedBy"), meta.get("withdrawn")
        if held is not None and held != {"S": sid}:
            # A later publish claimed after this version went live: its claim stays.
            item["claimedBy"] = values[":held"] = held
            live = "currentVersion = :v AND claimedBy = :held"
        else:
            live = "currentVersion = :v AND attribute_not_exists(claimedBy)"
        # A withdrawal that landed since the read above must not be written over.
        if withdrawn is None:
            same = "attribute_not_exists(withdrawn)"
        else:
            same = "withdrawn = :withdrawn"
            values[":withdrawn"] = withdrawn
        try:
            c.dynamodb.put_item(
                TableName=table,
                Item=item,
                ConditionExpression=f"(claimedBy = :sid OR ({live})) AND {same}",
                ExpressionAttributeValues=values,
            )
        except ClientError as error:
            if not _refused(error):
                raise
            if (_meta(c, table, dataset_id) or {}).get("withdrawn") == withdrawn:
                raise lost from None
            continue
        return len(items) + 1
    raise lost


@durable_step
def _page(
    _: StepContext, c: Clients, env: Env, target: dict[str, Any], filled: dict[str, Any]
) -> str:
    dataset_id, version = target["datasetId"], int(target["version"])
    root = _root(filled, target)
    text = _read(c, env.archive_bucket, root + MANIFEST).decode("utf-8")
    zips.write_zips(c.s3, env.archive_bucket, root, json.loads(text))
    manifest = Manifest.model_validate_json(text)
    brand = pages.page_brand(read_archive_config(c.ssm, env.archive_config_parameter))
    withdrawn = withdrawal_of(_meta(c, target["table"], dataset_id))
    key = ""
    for versioned in (False, True):
        html = pages.render_page(
            manifest,
            dataset_id=dataset_id,
            version=version,
            domain=env.site_domain,
            files=filled["files"],
            versioned=versioned,
            brand=brand,
            withdrawn=withdrawn,
            today=_clock().date(),
        )
        written = pages.write_page(
            cast(Any, c.s3), env.derived_bucket, html, dataset_id, version if versioned else None
        )
        key = key or written
    return key


@durable_step
def _catalog_file(_: StepContext, c: Clients, env: Env, target: dict[str, Any]) -> int:
    """Rewrite `site/catalog.json` from the active table, after the page, so search lists it."""
    return write_catalog_file(
        target["table"], env.derived_bucket, dynamodb=c.dynamodb, s3=cast(Any, c.s3)
    )


@durable_step
def _sitemap(_: StepContext, c: Clients, env: Env, target: dict[str, Any]) -> int:
    """Rewrite `site/sitemap.xml` from the active table, beside the catalog file."""
    return write_sitemap(
        target["table"], env.derived_bucket, env.site_domain, dynamodb=c.dynamodb, s3=c.s3
    )


@durable_step
def _doi(
    _: StepContext, c: Clients, env: Env, target: dict[str, Any], filled: dict[str, Any]
) -> dict[str, str]:
    """Register the version's DOI: `{"address"}`, or `{"taken"}` naming a DOI that already
    points elsewhere, which no retry would mend."""
    config = read_archive_config(c.ssm, env.archive_config_parameter)
    if config.doi is None:
        return {"taken": "the DOI module was switched off during the publish"}
    dataset_id, version = target["datasetId"], int(target["version"])
    text = _read(c, env.archive_bucket, _root(filled, target) + MANIFEST).decode("utf-8")
    try:
        found = doi.register(
            doi.client(c.ssm, config.doi),
            config.doi,
            Manifest.model_validate_json(text),
            publisher=config.publisher,
            dataset_id=dataset_id,
            version=version,
            url=pages.identifier(env.site_domain, dataset_id, version),
        )
    except doi.DoiTaken as taken:
        return {"taken": str(taken)}
    return {"address": found}


@durable_step
def _doi_identifier(
    _: StepContext,
    c: Clients,
    env: Env,
    target: dict[str, Any],
    filled: dict[str, Any],
    address: str,
) -> None:
    doi.write_identifier(c.s3, env.archive_bucket, _root(filled, target), address)


def _stage(env: Env) -> str:
    """The stage's name, from its parameter `/research-archive/<stage>/archive-config`."""
    return env.archive_config_parameter.strip("/").split("/")[1]


@durable_step
def _doi_alert(
    _: StepContext, c: Clients, env: Env, target: dict[str, Any], error: str, registered: bool
) -> None:
    dataset_id, version = target["datasetId"], int(target["version"])
    if registered:
        subject = f"DOI not written: {dataset_id} v{version}"
        message = (
            f"Version {version} of {dataset_id} is published and its DOI registered, but the "
            f"DOI isn't shown on the version yet: {error}\n\n"
            f"Run just reindex {_stage(env)} --dois to write it."
        )
    else:
        subject = f"DOI not registered: {dataset_id} v{version}"
        message = (
            f"Version {version} of {dataset_id} is published without a DOI: {error}\n\n"
            f"Run just reindex {_stage(env)} --dois once DataCite answers."
        )
    _alert(c, env, subject, message)


def _register_doi(
    context: DurableContext,
    c: Clients,
    env: Env,
    sid: str,
    target: dict[str, Any],
    filled: dict[str, Any],
    name: Callable[[str], str],
) -> None:
    """Register the DOI and show it; any failure alerts and leaves the version published.
    Registering and writing repeat safely, so `just reindex <stage> --dois` mends either."""
    try:
        found = context.step(_doi(c, env, target, filled), name=name("doi"))
    except Exception as error:
        # The step's last failure after its retries; never SuspendExecution, a BaseException.
        found = {"taken": str(error) or type(error).__name__}
    if "address" not in found:
        context.step(_doi_alert(c, env, target, found["taken"], False), name=name("doi-alert"))
        return
    address = found["address"]
    try:
        context.step(_doi_identifier(c, env, target, filled, address), name=name("doi-identifier"))
        context.step(_catalog(c, env, sid, target, filled), name=name("doi-catalog"))
        context.step(_page(c, env, target, filled), name=name("doi-page"))
    except Exception as error:
        failed = str(error) or type(error).__name__
        context.step(_doi_alert(c, env, target, failed, True), name=name("doi-alert"))


@durable_step
def _finish(
    _: StepContext,
    c: Clients,
    env: Env,
    sid: str,
    round: int,
    rule: int | None,
    target: dict[str, Any],
) -> None:
    _delete_prefix(c, env, _held(sid))
    _set(c, sid, {"status": "published"}, remove=("callbackId",))
    put_event(
        c.reviews,
        sid,
        "published",
        PIPELINE,
        round,
        rule=rule,
        datasetId=target["datasetId"],
        version=int(target["version"]),
    )


def publish(
    context: DurableContext, c: Clients, env: Env, sid: str, round: int, rule: int | None
) -> dict[str, Any]:
    """The held round published as the dataset's next version, one named step at a time."""

    def name(part: str) -> str:
        return f"publish-{round}-{part}"

    target = context.step(_version(c, env, sid), name=name("version"))
    filled = context.step(_fill(c, env, sid, target), name=name("fill"))
    context.step(_copy(c, env, sid, target, filled), name=name("copy"))
    context.step(_catalog(c, env, sid, target, filled), name=name("catalog"))
    context.step(_page(c, env, target, filled), name=name("page"))
    if filled.get("dois"):
        _register_doi(context, c, env, sid, target, filled, name)
    context.step(_catalog_file(c, env, target), name=name("catalog-file"))
    context.step(_sitemap(c, env, target), name=name("sitemap"))
    context.step(_finish(c, env, sid, round, rule, target), name=name("finish"))
    return {"datasetId": target["datasetId"], "version": int(target["version"])}


@durable_step
def _fail(_: StepContext, c: Clients, env: Env, sid: str, error: str) -> None:
    """End the submission as `failed`, release its claim on a version that never went live,
    removing what it wrote of that version, and alert the admins."""
    item = _submission(c, sid)
    round = int(item.get("round") or 1)
    _set(c, sid, {"status": "failed"}, remove=("callbackId",))
    # After the status: a later publish may take over the claim of a submission that failed.
    _release(c, env, sid, item)
    put_event(c.reviews, sid, "failed", PIPELINE, round, error=error[:1000])
    _alert(
        c,
        env,
        f"Ingest failed: submission {sid}",
        f"Submission {sid} round {round} failed: {error}",
    )


def _store_callback(c: Clients, sid: str) -> Any:
    def submitter(callback_id: str, _: object) -> None:
        _set(c, sid, {"callbackId": callback_id})

    return submitter


def _wait(
    context: DurableContext, c: Clients, sid: str, name: str, timeout: int, started: str
) -> Any:
    """A callback wait capped to end by the 360th day; `Expired` when the cap ended it."""
    left = context.step(_left(started), name=f"{name}-deadline")
    if left <= 0:
        raise Expired(name)
    try:
        return context.wait_for_callback(
            _store_callback(c, sid),
            name=name,
            config=WaitForCallbackConfig(timeout=Duration.from_seconds(min(timeout, left))),
        )
    except CallbackTimeoutError:
        if left <= timeout:
            raise Expired(name) from None
        raise


def _scan_delay(attempt: int) -> int:
    return min(30 << (attempt - 1), MAX_SCAN_DELAY)


def _scan(
    context: DurableContext,
    c: Clients,
    env: Env,
    sid: str,
    round: int,
    paths: list[str],
    started: str,
) -> dict[str, str]:
    """Wait until GuardDuty has tagged every file of the round, backing off up to an hour.

    The wait gives up after a day, or by the 360th day if that comes first, raising
    `NeverScanned`, so the submission ends `failed` with an alert instead of polling unseen.
    """
    limit = min(SCAN_LIMIT, context.step(_left(started), name=f"scan-{round}-deadline"))

    def check(state: dict[str, Any], _: object) -> dict[str, Any]:
        tags: dict[str, str] = {}
        for path in paths:
            tagging = c.s3.get_object_tagging(
                Bucket=env.staging_bucket, Key=_incoming(sid, round, path)
            )
            value = next((t["Value"] for t in tagging["TagSet"] if t["Key"] == SCAN_TAG), None)
            if value:
                tags[path] = str(value)
        return {"tags": tags}

    def strategy(state: dict[str, Any], attempt: int) -> WaitForConditionDecision:
        if len(state["tags"]) == len(paths):
            return WaitForConditionDecision.stop_polling()
        # The delays so far, worked out from the attempt, since a strategy can't read the clock.
        waited = sum(_scan_delay(n) for n in range(1, attempt))
        if waited >= limit:
            missing = sorted(set(paths) - set(state["tags"]))
            raise NeverScanned(
                f"{len(missing)} file(s) of round {round} were never scanned after"
                f" {waited // 3600} hours: {', '.join(missing[:10])}"
            )
        delay = min(_scan_delay(attempt), limit - waited)
        return WaitForConditionDecision.continue_waiting(Duration.from_seconds(delay))

    done: dict[str, Any] = context.wait_for_condition(
        check,
        WaitForConditionConfig(wait_strategy=strategy, initial_state={"tags": {}}),
        name=f"scan-{round}",
    )
    return cast(dict[str, str], done["tags"])


def _review(
    context: DurableContext,
    c: Clients,
    env: Env,
    sid: str,
    round: int,
    policy: dict[str, Any],
    started: str,
) -> str:
    """Wait for decisions until one ends the review: `approved`, `rejected` or `changes`."""
    reminders: list[int] = policy["reminders"]
    stale_days: int = policy["staleDays"]
    audience: str = policy["audience"]
    needed = 2 if policy["outcome"] == "two" else 1
    sent = 0
    stale = False
    n = 0
    while True:
        n += 1
        elapsed = context.step(_elapsed(policy["enteredAt"]), name=f"review-clock-{round}-{n}")
        if stale:
            timeout = stale_days * DAY
        else:
            mark = ([d * DAY for d in reminders[sent:]] + [stale_days * DAY])[0]
            timeout = mark - elapsed
        try:
            if timeout <= 0:
                raise CallbackTimeoutError("the mark was already due")
            result = _wait(context, c, sid, f"review-{round}-{n}", timeout, started)
        except CallbackTimeoutError:
            if stale:
                continue
            if sent < len(reminders):
                day = reminders[sent]
                sent += 1
                context.step(
                    _remind(c, env, sid, round, day, audience), name=f"remind-{round}-{sent}"
                )
            else:
                stale = True
                context.step(
                    _stale(c, env, sid, round, stale_days, audience), name=f"stale-{round}"
                )
            continue
        payload = _payload(result)
        decision, by = payload.get("decision"), str(payload.get("by"))
        if payload.get("kind") != "decision":
            raise BadCallback(f"expected a decision, got {payload!r}")
        if decision == "approve":
            approvals = context.step(_approve(c, sid, by), name=f"approve-{round}-{n}")
            if len(set(approvals)) >= needed:
                return "approved"
        elif decision == "reject":
            context.step(
                _reject(c, env, sid, round, by, payload.get("note")), name=f"reject-{round}"
            )
            return "rejected"
        elif decision == "request-changes":
            context.step(_changes(c, sid), name=f"changes-{round}")
            return "changes"
        else:
            raise BadCallback(f"unknown decision {decision!r}")


def _resubmit(
    context: DurableContext, c: Clients, env: Env, sid: str, round: int, started: str
) -> int | None:
    """Wait 30 days for the next round; None when none arrives and the submission is abandoned."""
    try:
        result = _wait(context, c, sid, f"resubmit-{round}", RESUBMIT_DAYS * DAY, started)
    except CallbackTimeoutError:
        context.step(_abandon(c, env, sid, round), name=f"abandon-{round}")
        return None
    payload = _payload(result)
    next_round = payload.get("round")
    if payload.get("kind") != "resubmit" or not isinstance(next_round, int) or next_round <= round:
        raise BadCallback(f"expected a resubmit after round {round}, got {payload!r}")
    return next_round


def _ingest(context: DurableContext, c: Clients, env: Env, sid: str) -> dict[str, Any]:
    begun = context.step(_start(c, sid), name="start")
    round: int = begun["round"]
    started: str = begun["startedAt"]
    try:
        return _rounds(context, c, env, sid, round, started)
    except Expired:
        round = context.step(_expire(c, env, sid), name="expire")
        return {"submissionId": sid, "status": "expired", "round": round}


def _rounds(
    context: DurableContext, c: Clients, env: Env, sid: str, round: int, started: str
) -> dict[str, Any]:
    while True:
        paths = context.step(_files(c, sid, round), name=f"files-{round}")
        tags = _scan(context, c, env, sid, round, paths, started)
        context.step(_scanned(c, sid, round, tags), name=f"scanned-{round}")
        checked = context.step(_check(c, env, sid, round, paths, tags), name=f"check-{round}")
        if not checked["blocked"]:
            context.step(_hold(c, env, sid, round, paths), name=f"hold-{round}")
            policy = context.step(_policy(c, env, sid, round, checked), name=f"policy-{round}")
            outcome = "approved"
            if policy["outcome"] != "skip":
                outcome = _review(context, c, env, sid, round, policy, started)
            if outcome == "approved":
                published = publish(context, c, env, sid, round, policy["rule"])
                return {"submissionId": sid, "status": "published", "round": round, **published}
            if outcome == "rejected":
                return {"submissionId": sid, "status": "rejected", "round": round}
        next_round = _resubmit(context, c, env, sid, round, started)
        if next_round is None:
            return {"submissionId": sid, "status": "abandoned", "round": round}
        round = next_round


def run(event: dict[str, Any], context: DurableContext) -> dict[str, Any]:
    """The submission's whole path; a failed step or a bad callback ends it as `failed`."""
    sid = str(event["submissionId"])
    env = Env.from_environ()
    c = clients(env)
    try:
        return _ingest(context, c, env, sid)
    except (DurableOperationError, BadCallback) as error:
        context.step(_fail(c, env, sid, str(error) or type(error).__name__), name="fail")
        return {"submissionId": sid, "status": "failed"}


handler = durable_execution(run)
