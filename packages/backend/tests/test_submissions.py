import base64
import hashlib
import io
import json
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs, urlparse

import boto3
import pytest
from botocore.config import Config
from botocore.exceptions import ClientError

from archive_backend import submissions
from archive_backend.submissions import Clients, Env
from archive_contract.validate import validate_package

STAGING = "staging"
ALIAS = "arn:aws:lambda:us-east-1:1:function:ingest:live"
PARAMETER = "/research-archive/test/catalog-active"
CONFIG = "/research-archive/test/archive-config"
SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"
DIGEST = hashlib.sha256(b"a,b\n").hexdigest()
ENV = Env(
    submissions_table="submissions",
    reviews_table="reviews",
    settings_table="settings",
    staging_bucket=STAGING,
    ingest_alias_arn=ALIAS,
    active_catalog_parameter=PARAMETER,
    catalog_tables={"A": "catalog-a", "B": "catalog-b"},
    user_pool_id="pool",
    archive_config_parameter=CONFIG,
)


def _failed(operation: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "no"}}, operation
    )


class FakeTable:
    """A table of plain items, understanding only the expressions the API writes."""

    def __init__(self, key: tuple[str, ...]) -> None:
        self.key = key
        self.items: dict[tuple[Any, ...], dict[str, Any]] = {}

    def _id(self, item: dict[str, Any]) -> tuple[Any, ...]:
        return tuple(item[k] for k in self.key)

    def _check(self, current: dict[str, Any] | None, kwargs: dict[str, Any]) -> None:
        condition = kwargs.get("ConditionExpression")
        if condition is None:
            return
        if condition.startswith("attribute_not_exists("):
            if current is not None:
                raise _failed("PutItem")
            return
        name, value = (part.strip() for part in condition.split("="))
        field = kwargs["ExpressionAttributeNames"][name]
        if current is None or current.get(field) != kwargs["ExpressionAttributeValues"][value]:
            raise _failed("UpdateItem")

    def get_item(self, *, Key: dict[str, Any]) -> dict[str, Any]:
        item = self.items.get(self._id(Key))
        return {"Item": dict(item)} if item is not None else {}

    def put_item(self, *, Item: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        self._check(self.items.get(self._id(Item)), kwargs)
        self.items[self._id(Item)] = dict(Item)
        return {}

    def update_item(self, *, Key: dict[str, Any], UpdateExpression: str, **kwargs: Any) -> Any:
        current = self.items.get(self._id(Key))
        self._check(current, kwargs)
        assert current is not None
        if UpdateExpression.startswith("REMOVE "):
            for name in UpdateExpression[7:].split(","):
                current.pop(kwargs["ExpressionAttributeNames"][name.strip()], None)
            return {}
        assert UpdateExpression.startswith("SET ")
        for assignment in UpdateExpression[4:].split(","):
            name, value = (part.strip() for part in assignment.split("="))
            field = kwargs["ExpressionAttributeNames"][name]
            current[field] = kwargs["ExpressionAttributeValues"][value]
        return {}

    def query(self, **kwargs: Any) -> dict[str, Any]:
        name, value = (part.strip() for part in kwargs["KeyConditionExpression"].split("="))
        field = kwargs["ExpressionAttributeNames"][name]
        wanted = kwargs["ExpressionAttributeValues"][value]
        found = [dict(i) for i in self.items.values() if i.get(field) == wanted]
        sort = {"bySubmitter": "createdAt", "byStatus": "createdAt"}.get(
            kwargs.get("IndexName", ""), self.key[-1]
        )
        return {"Items": sorted(found, key=lambda i: str(i.get(sort, "")))}


class FakeS3:
    def __init__(self) -> None:
        self.presigned: list[dict[str, Any]] = []
        self.uploaded: set[str] = set()
        self.objects: dict[str, bytes] = {}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        assert Bucket == STAGING
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, **_: Any) -> dict[str, Any]:
        assert Bucket == STAGING
        self.objects[Key] = Body
        return {}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        assert Bucket == STAGING
        if Key not in self.uploaded:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        return {}

    def upload_all(self) -> None:
        """Every file each presigned PUT so far was for, as a client's PUTs leave them."""
        self.uploaded.update(p["Key"] for p in self.presigned if p["method"] == "put_object")

    def generate_presigned_url(self, method: str, Params: dict[str, Any], ExpiresIn: int) -> str:
        self.presigned.append({"method": method, "expires": ExpiresIn, **Params})
        return f"https://{Params['Bucket']}.s3/{Params['Key']}?signed"


class FakeLambda:
    def __init__(self) -> None:
        self.invocations: list[dict[str, Any]] = []
        self.callbacks: list[dict[str, Any]] = []
        # What the pipeline does as a callback lands, before the API's call returns.
        self.on_callback: Callable[[], None] = lambda: None

    def invoke(self, **kwargs: Any) -> dict[str, Any]:
        self.invocations.append(kwargs)
        return {"StatusCode": 202}

    def send_durable_execution_callback_success(self, **kwargs: Any) -> dict[str, Any]:
        self.callbacks.append({**kwargs, "Result": json.loads(kwargs["Result"])})
        self.on_callback()
        return {}


class FakeSSM:
    def __init__(self) -> None:
        self.config: dict[str, Any] = {"publisher": "P", "profiles": ["ecology"]}

    def get_parameter(self, *, Name: str) -> dict[str, Any]:
        if Name == CONFIG:
            return {"Parameter": {"Value": json.dumps(self.config)}}
        assert Name == PARAMETER
        return {"Parameter": {"Value": "B"}}


class World:
    def __init__(self) -> None:
        self.s3 = FakeS3()
        self.lambda_ = FakeLambda()
        self.ssm = FakeSSM()
        self.submissions = FakeTable(("submissionId",))
        self.reviews = FakeTable(("submissionId", "eventKey"))
        self.settings = FakeTable(("name",))
        self.catalog = {"catalog-a": FakeTable(("PK", "SK")), "catalog-b": FakeTable(("PK", "SK"))}
        self.clients = Clients(
            s3=cast(submissions.S3, self.s3),
            lambda_=self.lambda_,
            ssm=cast(submissions.SSM, self.ssm),
            submissions=cast(submissions.Table, self.submissions),
            reviews=cast(submissions.Table, self.reviews),
            settings=cast(submissions.Table, self.settings),
            table=lambda name: cast(submissions.Table, self.catalog[name]),
            cognito=cast(submissions.Cognito, None),
        )

    def call(
        self,
        method: str,
        resource: str,
        user: str,
        groups: str,
        body: Any = None,
        sid: str | None = None,
        query: dict[str, str] | None = None,
        raw: str | None = None,
    ) -> tuple[int, Any]:
        event = {
            "httpMethod": method,
            "resource": resource,
            "pathParameters": {"id": sid} if sid else None,
            "queryStringParameters": query,
            "body": raw if raw is not None else json.dumps(body) if body is not None else None,
            "requestContext": {"authorizer": {"claims": {"sub": user, "cognito:groups": groups}}},
        }
        response = submissions.handle(event, self.clients, ENV)
        return response["statusCode"], json.loads(response["body"])

    def create(self, user: str = "alice", **extra: Any) -> str:
        status, body = self.call(
            "POST",
            "/api/submissions",
            user,
            "contributor",
            {"files": [{"path": "data/a.csv", "size": 4, "sha256": DIGEST}], **extra},
        )
        assert status == 201, body
        sid: str = body["submissionId"]
        return sid

    def events(self, sid: str) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = self.reviews.query(
            KeyConditionExpression="#k = :k",
            ExpressionAttributeNames={"#k": "submissionId"},
            ExpressionAttributeValues={":k": sid},
        )["Items"]
        return found


@pytest.fixture
def world() -> World:
    return World()


ROUTES = [
    ("POST", "/api/submissions", "curator,admin"),
    ("GET", "/api/submissions", "admin"),
    ("GET", "/api/submissions/policy", "contributor,curator"),
    ("PUT", "/api/submissions/policy", "contributor,curator"),
    ("POST", "/api/submissions/{id}/uploads", "contributor"),
    ("POST", "/api/submissions/{id}/submit", "contributor"),
    ("GET", "/api/submissions/{id}", "contributor"),
    ("POST", "/api/submissions/{id}/decision", "contributor,admin"),
    ("GET", "/api/submissions/{id}/files", "contributor,admin"),
    ("GET", "/api/people", "contributor"),
    ("GET", "/api/curators", "contributor,curator"),
    ("POST", "/api/checks", "curator,admin"),
    ("POST", "/api/submissions/{id}/edits", "contributor,admin"),
]


@pytest.mark.parametrize(("method", "resource", "groups"), ROUTES)
def test_each_route_refuses_the_wrong_role(
    world: World, method: str, resource: str, groups: str
) -> None:
    sid = world.create("alice")
    status, body = world.call(method, resource, "mallory", groups, {}, sid=sid)
    assert status == 403, body


def test_create_records_the_submission_and_returns_checksummed_urls(world: World) -> None:
    sid = world.create("alice")

    item = world.submissions.items[(sid,)]
    assert item["submitter"] == "alice"
    assert item["status"] == "draft"
    assert item["round"] == 1
    assert item["newVersion"] is False
    assert item["files"] == {"1": [{"path": "data/a.csv", "size": 4, "sha256": DIGEST}]}
    checksum = base64.b64encode(bytes.fromhex(DIGEST)).decode()
    assert world.s3.presigned == [
        {
            "method": "put_object",
            "expires": 3600,
            "Bucket": STAGING,
            "Key": f"incoming/{sid}/1/data/a.csv",
            "ChecksumSHA256": checksum,
        }
    ]
    assert [e["type"] for e in world.events(sid)] == ["created"]
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT[^#]+#[0-9a-f-]{36}", world.events(sid)[0]["eventKey"])


def test_a_real_presigned_put_signs_the_checksum_header() -> None:
    s3 = boto3.client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id="x",
        aws_secret_access_key="y",
        config=submissions.S3_CONFIG,
    )
    assert isinstance(submissions.S3_CONFIG, Config)
    upload = submissions.presigned_put(
        cast(submissions.S3, s3), STAGING, "incoming/s/1/a.csv", DIGEST
    )
    query = parse_qs(urlparse(upload["url"]).query)
    assert "x-amz-checksum-sha256" in query["X-Amz-SignedHeaders"][0].split(";")
    assert upload["headers"] == {
        "x-amz-checksum-sha256": base64.b64encode(bytes.fromhex(DIGEST)).decode()
    }


@pytest.mark.parametrize(
    "file",
    [
        {"path": "../escape.csv", "size": 4, "sha256": DIGEST},
        {"path": "/abs.csv", "size": 4, "sha256": DIGEST},
        {"path": "data//a.csv", "size": 4, "sha256": DIGEST},
        {"path": "data/a.csv", "size": -1, "sha256": DIGEST},
        {"path": "data/a.csv", "size": 4, "sha256": "not-hex"},
    ],
)
def test_create_refuses_a_bad_file(world: World, file: dict[str, Any]) -> None:
    status, body = world.call("POST", "/api/submissions", "alice", "contributor", {"files": [file]})
    assert status == 400, body
    assert world.submissions.items == {}


@pytest.mark.parametrize("path", [".DS_Store", "data/.DS_Store", ".git/config"])
def test_create_refuses_a_hidden_path_and_says_why(world: World, path: str) -> None:
    file = {"path": path, "size": 4, "sha256": DIGEST}
    status, body = world.call("POST", "/api/submissions", "alice", "contributor", {"files": [file]})

    assert status == 400, body
    assert body["error"] == (
        f"hidden path: {path!r}; a package never holds a file or folder whose name "
        "starts with a dot"
    )
    assert world.submissions.items == {}


def test_uploads_refuses_a_hidden_path(world: World) -> None:
    sid = world.create("alice")
    world.s3.presigned.clear()
    files = [{"path": "data/.DS_Store", "size": 4, "sha256": DIGEST}]

    status, body = world.call(
        "POST", "/api/submissions/{id}/uploads", "alice", "contributor", {"files": files}, sid=sid
    )

    assert status == 400, body
    assert body["error"] == (
        "hidden path: 'data/.DS_Store'; a package never holds a file or folder whose name "
        "starts with a dot"
    )
    assert world.s3.presigned == []


def _publish(world: World, dataset_id: str, submitter: str) -> None:
    # The catalog's dataset item carries no submitter; ownership is a published submission.
    world.catalog["catalog-b"].items[(f"DATASET#{dataset_id}", "META")] = {
        "PK": f"DATASET#{dataset_id}",
        "SK": "META",
        "currentVersion": 1,
    }
    world.submissions.items[(f"published-{dataset_id}",)] = {
        "submissionId": f"published-{dataset_id}",
        "submitter": submitter,
        "status": "published",
        "createdAt": "2026-01-01T00:00:00Z",
        "datasetId": dataset_id,
    }


FILES = [{"path": "a.csv", "size": 4, "sha256": DIGEST}]


def test_a_new_version_is_allowed_to_the_submitter_who_published_it(world: World) -> None:
    _publish(world, "rain", "alice")

    own = world.create("alice", datasetId="rain")

    assert world.submissions.items[(own,)]["newVersion"] is True


def test_a_new_version_is_refused_to_a_stranger(world: World) -> None:
    _publish(world, "rain", "alice")
    # bob's own submission of rain that never published gives no ownership.
    world.submissions.items[("bob-draft",)] = {
        "submissionId": "bob-draft",
        "submitter": "bob",
        "status": "rejected",
        "createdAt": "2026-01-02T00:00:00Z",
        "datasetId": "rain",
    }

    status, body = world.call(
        "POST", "/api/submissions", "bob", "contributor", {"files": FILES, "datasetId": "rain"}
    )

    assert status == 403, body


def test_a_curator_may_always_version_a_dataset(world: World) -> None:
    _publish(world, "rain", "alice")

    status, body = world.call(
        "POST",
        "/api/submissions",
        "carol",
        "contributor,curator",
        {"files": FILES, "datasetId": "rain"},
    )

    assert status == 201, body
    assert world.submissions.items[(body["submissionId"],)]["newVersion"] is True


def test_create_records_whether_the_submitter_is_a_curator(world: World) -> None:
    plain = world.create("alice")
    status, body = world.call(
        "POST", "/api/submissions", "carol", "contributor,curator", {"files": FILES}
    )

    assert status == 201, body
    assert world.submissions.items[(plain,)]["submitterIsCurator"] is False
    assert world.submissions.items[(body["submissionId"],)]["submitterIsCurator"] is True


@pytest.mark.parametrize("dataset_id", ["rain.v2", "rain/2", "", "a" * 201, 7])
def test_create_refuses_a_dataset_id_the_site_could_not_route(
    world: World, dataset_id: object
) -> None:
    # The site function routes /datasets/<id> only for an id with no '.' or '/'.
    status, body = world.call(
        "POST",
        "/api/submissions",
        "alice",
        "contributor",
        {"files": FILES, "datasetId": dataset_id},
    )

    assert status == 400, body
    assert world.submissions.items == {}


def test_an_unknown_dataset_id_is_a_new_dataset(world: World) -> None:
    fresh = world.create("bob", datasetId="snow")

    assert world.submissions.items[(fresh,)]["newVersion"] is False
    assert world.submissions.items[(fresh,)]["datasetId"] == "snow"


def test_submit_starts_the_execution_named_by_the_submission(world: World) -> None:
    sid = world.create("alice")
    world.s3.upload_all()

    status, body = world.call(
        "POST", "/api/submissions/{id}/submit", "alice", "contributor", sid=sid
    )

    assert status == 202, body
    assert world.lambda_.invocations == [
        {
            "FunctionName": ALIAS,
            "InvocationType": "Event",
            "DurableExecutionName": sid,
            "Payload": json.dumps({"submissionId": sid}).encode(),
        }
    ]
    assert world.submissions.items[(sid,)]["status"] == "checking"
    assert [e["type"] for e in world.events(sid)] == ["created", "submitted"]
    again, _ = world.call("POST", "/api/submissions/{id}/submit", "alice", "contributor", sid=sid)
    assert again == 409
    assert len(world.lambda_.invocations) == 1


def test_submit_refuses_a_round_whose_files_are_not_all_uploaded(world: World) -> None:
    status, body = world.call(
        "POST",
        "/api/submissions",
        "alice",
        "contributor",
        {
            "files": [
                {"path": "data/a.csv", "size": 4, "sha256": DIGEST},
                {"path": "data/b.csv", "size": 4, "sha256": DIGEST},
            ]
        },
    )
    assert status == 201, body
    sid = body["submissionId"]
    world.s3.uploaded.add(f"incoming/{sid}/1/data/a.csv")

    status, body = world.call(
        "POST", "/api/submissions/{id}/submit", "alice", "contributor", sid=sid
    )

    assert status == 409
    assert "data/b.csv" in body["error"] and "data/a.csv" not in body["error"]
    assert world.lambda_.invocations == []
    assert world.submissions.items[(sid,)]["status"] == "draft"
    assert [e["type"] for e in world.events(sid)] == ["created"]


def test_resubmit_completes_the_stored_callback(world: World) -> None:
    sid = world.create("alice")
    world.submissions.items[(sid,)].update(status="needs-changes", callbackId="cb-resubmit")

    status, body = world.call(
        "POST",
        "/api/submissions/{id}/uploads",
        "alice",
        "contributor",
        {"files": [{"path": "data/a.csv", "size": 5, "sha256": DIGEST}]},
        sid=sid,
    )
    assert status == 200, body
    assert body["round"] == 2
    assert world.s3.presigned[-1]["Key"] == f"incoming/{sid}/2/data/a.csv"
    world.s3.upload_all()

    status, body = world.call(
        "POST", "/api/submissions/{id}/submit", "alice", "contributor", sid=sid
    )

    assert status == 202, body
    assert world.lambda_.invocations == []
    assert world.lambda_.callbacks == [
        {"CallbackId": "cb-resubmit", "Result": {"kind": "resubmit", "round": 2}}
    ]
    assert world.submissions.items[(sid,)]["round"] == 2
    assert [e["type"] for e in world.events(sid)] == ["created", "resubmitted"]


def test_a_round_1_draft_gets_new_links_for_its_submitter_only(world: World) -> None:
    sid = world.create("alice")
    world.s3.presigned.clear()
    files = [{"path": "data/a.csv", "size": 4, "sha256": DIGEST}]

    stranger, body = world.call(
        "POST", "/api/submissions/{id}/uploads", "bob", "contributor", {"files": files}, sid=sid
    )
    assert stranger == 403, body
    assert world.s3.presigned == []

    status, body = world.call(
        "POST", "/api/submissions/{id}/uploads", "alice", "contributor", {"files": files}, sid=sid
    )

    assert status == 200, body
    assert body["round"] == 1
    assert [u["path"] for u in body["uploads"]] == ["data/a.csv"]
    assert world.s3.presigned[-1]["Key"] == f"incoming/{sid}/1/data/a.csv"
    item = world.submissions.items[(sid,)]
    assert (item["status"], item["round"]) == ("draft", 1)


def _in_review(world: World, submitter: str = "alice") -> str:
    sid = world.create(submitter)
    world.submissions.items[(sid,)].update(status="in-review", callbackId="cb-review")
    return sid


def test_a_decision_writes_its_event_then_completes_the_callback(world: World) -> None:
    sid = _in_review(world)

    status, body = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "carol",
        "curator",
        {"decision": "request-changes", "note": "Add units"},
        sid=sid,
    )

    assert status == 202, body
    decided = world.events(sid)[-1]
    assert decided["type"] == "decided"
    assert decided["actor"] == "carol"
    assert decided["decision"] == "request-changes"
    assert decided["note"] == "Add units"
    assert "selfReview" not in decided
    assert world.lambda_.callbacks == [
        {
            "CallbackId": "cb-review",
            "Result": {
                "kind": "decision",
                "decision": "request-changes",
                "by": "carol",
                "note": "Add units",
            },
        }
    ]


def test_a_curator_deciding_their_own_submission_is_recorded(world: World) -> None:
    sid = _in_review(world, submitter="carol")

    status, _ = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "carol",
        "curator",
        {"decision": "approve"},
        sid=sid,
    )

    assert status == 202
    assert world.events(sid)[-1]["selfReview"] is True


def test_a_second_approval_from_the_same_curator_is_refused(world: World) -> None:
    sid = _in_review(world)
    world.submissions.items[(sid,)]["approvals"] = ["carol"]

    status, body = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "carol",
        "curator",
        {"decision": "approve"},
        sid=sid,
    )

    assert status == 409, body
    assert world.lambda_.callbacks == []
    assert [e["type"] for e in world.events(sid)] == ["created"]
    other, _ = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "dave",
        "curator",
        {"decision": "approve"},
        sid=sid,
    )
    assert other == 202


def test_the_policy_round_trips_and_an_invalid_policy_is_refused(world: World) -> None:
    status, body = world.call("GET", "/api/submissions/policy", "root", "admin")
    assert status == 200
    assert body == {
        "required": True,
        "rules": [],
        "reviewers": {},
        "reminders": [],
        "staleDays": 14,
    }

    policy = {
        "required": True,
        "rules": [{"submitters": ["curators"], "outcome": "skip"}],
        "reviewers": {"climate": ["carol"]},
        "reminders": [3, 7],
        "staleDays": 10,
    }
    status, body = world.call("PUT", "/api/submissions/policy", "root", "admin", policy)
    assert status == 200, body
    status, body = world.call("GET", "/api/submissions/policy", "root", "admin")
    assert body["rules"] == [{"submitters": ["curators"], "outcome": "skip"}]
    assert body["staleDays"] == 10

    status, _ = world.call(
        "PUT", "/api/submissions/policy", "root", "admin", {"reminders": [20], "staleDays": 14}
    )
    assert status == 400
    _, body = world.call("GET", "/api/submissions/policy", "root", "admin")
    assert body["staleDays"] == 10


def test_lists_and_reads_follow_the_caller(world: World) -> None:
    mine = world.create("alice")
    world.create("bob")
    world.submissions.items[(mine,)].update(status="in-review")

    _, own = world.call("GET", "/api/submissions", "alice", "contributor")
    assert [s["submissionId"] for s in own["submissions"]] == [mine]
    _, queue = world.call(
        "GET", "/api/submissions", "carol", "curator", query={"status": "in-review"}
    )
    assert [s["submissionId"] for s in queue["submissions"]] == [mine]

    status, body = world.call("GET", "/api/submissions/{id}", "carol", "curator", sid=mine)
    assert status == 200
    assert body["submission"]["submissionId"] == mine
    assert [e["type"] for e in body["events"]] == ["created"]
    stranger, _ = world.call("GET", "/api/submissions/{id}", "bob", "contributor", sid=mine)
    assert stranger == 403


SECOND = hashlib.sha256(b"c\n").hexdigest()


def _held(world: World, status: str) -> str:
    """A submission in its second round, with round 1's file no longer listed."""
    sid = world.create("alice")
    world.submissions.items[(sid,)].update(
        status=status,
        round=2,
        files={
            "1": [{"path": "data/old.csv", "size": 9, "sha256": DIGEST}],
            "2": [
                {"path": "data/a.csv", "size": 4, "sha256": DIGEST},
                {"path": "README.md", "size": 2, "sha256": SECOND},
            ],
        },
    )
    world.s3.presigned.clear()
    return sid


@pytest.mark.parametrize("status", ["in-review", "publishing"])
def test_a_curator_gets_a_five_minute_link_to_each_held_file(world: World, status: str) -> None:
    sid = _held(world, status)

    code, body = world.call("GET", "/api/submissions/{id}/files", "carol", "curator", sid=sid)

    assert code == 200, body
    assert body == {
        "round": 2,
        "files": [
            {
                "path": "data/a.csv",
                "size": 4,
                "sha256": DIGEST,
                "url": f"https://{STAGING}.s3/held/{sid}/data/a.csv?signed",
            },
            {
                "path": "README.md",
                "size": 2,
                "sha256": SECOND,
                "url": f"https://{STAGING}.s3/held/{sid}/README.md?signed",
            },
        ],
    }
    # Only the round's listed paths are signed, each for five minutes.
    assert world.s3.presigned == [
        {"method": "get_object", "expires": 300, "Bucket": STAGING, "Key": f"held/{sid}/{path}"}
        for path in ("data/a.csv", "README.md")
    ]


def test_the_files_route_is_refused_to_the_submitter_who_is_no_curator(world: World) -> None:
    sid = _held(world, "in-review")

    code, _ = world.call("GET", "/api/submissions/{id}/files", "alice", "contributor", sid=sid)

    assert code == 403
    assert world.s3.presigned == []


def test_the_files_route_answers_404_for_an_unknown_submission(world: World) -> None:
    code, _ = world.call("GET", "/api/submissions/{id}/files", "carol", "curator", sid="nope")

    assert code == 404


@pytest.mark.parametrize(
    "status", [s for s in submissions.STATUSES if s not in ("in-review", "publishing")]
)
def test_the_files_route_answers_409_while_nothing_is_held(world: World, status: str) -> None:
    sid = _held(world, status)

    code, _ = world.call("GET", "/api/submissions/{id}/files", "carol", "curator", sid=sid)

    assert code == 409
    assert world.s3.presigned == []


def test_answers_say_whether_the_pipeline_waits_and_never_carry_the_callback(
    world: World,
) -> None:
    sid = world.create("alice")

    def answers() -> list[dict[str, Any]]:
        _, read = world.call("GET", "/api/submissions/{id}", "alice", "contributor", sid=sid)
        _, mine = world.call("GET", "/api/submissions", "alice", "contributor")
        status = str(world.submissions.items[(sid,)]["status"])
        _, queue = world.call(
            "GET", "/api/submissions", "carol", "curator", query={"status": status}
        )
        return [read["submission"], *mine["submissions"], *queue["submissions"]]

    assert [a["waiting"] for a in answers()] == [False, False, False]
    world.submissions.items[(sid,)].update(status="needs-changes", callbackId="cb-secret")

    seen = answers()

    assert [a["waiting"] for a in seen] == [True, True, True]
    assert all("callbackId" not in a for a in seen)
    assert "cb-secret" not in json.dumps(seen)


def test_the_read_answer_keeps_each_event_s_details(world: World) -> None:
    sid = _in_review(world)
    submissions.put_event(
        world.clients.reviews,
        sid,
        "entered-review",
        "pipeline",
        1,
        rule=2,
        outcome="two",
        audience="all",
    )

    _, body = world.call("GET", "/api/submissions/{id}", "carol", "curator", sid=sid)

    entered = body["events"][-1]
    assert {k: entered[k] for k in ("type", "actor", "round", "rule", "outcome", "audience")} == {
        "type": "entered-review",
        "actor": "pipeline",
        "round": 1,
        "rule": 2,
        "outcome": "two",
        "audience": "all",
    }
    assert "note" not in entered


def test_a_decision_closes_the_callback_it_completed(world: World) -> None:
    sid = _in_review(world)

    status, _ = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "carol",
        "curator",
        {"decision": "approve"},
        sid=sid,
    )

    assert status == 202
    assert "callbackId" not in world.submissions.items[(sid,)]
    _, body = world.call("GET", "/api/submissions/{id}", "dave", "curator", sid=sid)
    assert body["submission"]["waiting"] is False
    again, body = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "dave",
        "curator",
        {"decision": "approve"},
        sid=sid,
    )
    assert again == 409, body
    assert [e["type"] for e in world.events(sid)] == ["created", "decided"]


def test_a_wait_the_pipeline_opened_since_is_kept(world: World) -> None:
    sid = _in_review(world)
    world.lambda_.on_callback = lambda: world.submissions.items[(sid,)].update(
        callbackId="cb-second"
    )

    status, _ = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "carol",
        "curator",
        {"decision": "approve"},
        sid=sid,
    )

    assert status == 202
    assert world.submissions.items[(sid,)]["callbackId"] == "cb-second"
    _, body = world.call("GET", "/api/submissions/{id}", "dave", "curator", sid=sid)
    assert body["submission"]["waiting"] is True


def _throttle_closing(world: World) -> None:
    """DynamoDB throttles every attempt to remove a submission's callbackId."""
    update = world.submissions.update_item

    def throttled(**kwargs: Any) -> Any:
        if (
            kwargs["UpdateExpression"].startswith("REMOVE ")
            and "callbackId" in kwargs["ExpressionAttributeNames"].values()
        ):
            raise ClientError(
                {"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "UpdateItem"
            )
        return update(**kwargs)

    world.submissions.update_item = throttled  # type: ignore[method-assign]


def test_a_throttled_close_answers_202_logs_it_and_the_spent_wait_reads_closed(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    sid = _in_review(world)
    _throttle_closing(world)

    status, _ = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "carol",
        "curator",
        {"decision": "approve"},
        sid=sid,
    )

    assert status == 202
    assert world.submissions.items[(sid,)]["callbackId"] == "cb-review"
    assert any(sid in record.getMessage() for record in caplog.records)
    _, body = world.call("GET", "/api/submissions/{id}", "dave", "curator", sid=sid)
    assert body["submission"]["waiting"] is False
    again, _ = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "dave",
        "curator",
        {"decision": "approve"},
        sid=sid,
    )
    assert again == 409
    assert len(world.lambda_.callbacks) == 1


def test_a_throttled_close_after_a_resubmit_reads_closed(world: World) -> None:
    sid = world.create("alice")
    world.submissions.items[(sid,)].update(status="needs-changes", callbackId="cb-resubmit")
    world.call(
        "POST", "/api/submissions/{id}/uploads", "alice", "contributor", {"files": FILES}, sid=sid
    )
    world.s3.upload_all()
    _throttle_closing(world)

    status, _ = world.call("POST", "/api/submissions/{id}/submit", "alice", "contributor", sid=sid)

    assert status == 202
    _, body = world.call("GET", "/api/submissions/{id}", "alice", "contributor", sid=sid)
    assert body["submission"]["waiting"] is False


def test_a_callback_that_fails_to_complete_leaves_the_wait_open(world: World) -> None:
    sid = _in_review(world)

    def refuse(**kwargs: Any) -> Any:
        raise ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "slow down"}},
            "SendDurableExecutionCallbackSuccess",
        )

    world.lambda_.send_durable_execution_callback_success = refuse  # type: ignore[method-assign]

    status, _ = world.call(
        "POST",
        "/api/submissions/{id}/decision",
        "carol",
        "curator",
        {"decision": "approve"},
        sid=sid,
    )

    assert status == 409
    _, body = world.call("GET", "/api/submissions/{id}", "dave", "curator", sid=sid)
    assert body["submission"]["waiting"] is True


def test_a_resubmit_closes_the_callback_it_completed(world: World) -> None:
    sid = world.create("alice")
    world.submissions.items[(sid,)].update(status="needs-changes", callbackId="cb-resubmit")
    world.call(
        "POST", "/api/submissions/{id}/uploads", "alice", "contributor", {"files": FILES}, sid=sid
    )
    world.s3.upload_all()

    status, _ = world.call("POST", "/api/submissions/{id}/submit", "alice", "contributor", sid=sid)

    assert status == 202
    assert "callbackId" not in world.submissions.items[(sid,)]


def _sample(drop: str | None = None) -> dict[str, Any]:
    raw: dict[str, Any] = json.loads((SAMPLE / "datapackage.json").read_text())
    if drop is not None:
        logger = next(r for r in raw["resources"] if r["name"] == "logger")
        column = next(f for f in logger["schema"]["fields"] if f["name"] == drop)
        column.pop("description")
    return raw


def test_checks_answer_the_manifest_rules_findings_for_a_contributor(world: World) -> None:
    status, body = world.call("POST", "/api/checks", "alice", "contributor", _sample("timestamp"))

    assert status == 200, body
    found = {(f["ruleId"], f.get("target", {}).get("field")) for f in body["findings"]}
    assert ("field.description-missing", "timestamp") in found
    assert ("field.description-missing", "battery_v") in found
    assert not any(rule.startswith("values.") for rule, _ in found)


def test_checks_use_the_archive_config_s_required_fields(world: World) -> None:
    world.ssm.config["required"] = ["archive:funding"]
    raw = _sample()
    raw.pop("archive:funding", None)

    status, body = world.call("POST", "/api/checks", "alice", "contributor", raw)

    assert status == 200, body
    assert "package.profile-field-missing" in {f["ruleId"] for f in body["findings"]}


def test_checks_are_refused_to_a_reader_without_the_contributor_group(world: World) -> None:
    status, _ = world.call("POST", "/api/checks", "rita", "", _sample())
    assert status == 403


@pytest.mark.parametrize(
    "raw",
    [
        json.dumps({"description": "x" * (2 * 1024 * 1024)}),
        "not json",
        json.dumps({"title": 7}),
    ],
    ids=["two-megabytes", "not-json", "not-a-manifest"],
)
def test_checks_refuse_a_body_that_is_not_a_manifest_of_at_most_1_mb(
    world: World, raw: str
) -> None:
    status, body = world.call("POST", "/api/checks", "alice", "contributor", raw=raw)
    assert status == 400, body
    assert body["error"]


def _held_package(world: World, submitter: str = "alice", status: str = "in-review") -> str:
    """A round-1 submission whose held files are the sample package's listed files."""
    sid = world.create(submitter)
    sums = (SAMPLE / "checksums.sha256").read_text()
    paths = [line.split("  ", 1)[1] for line in sums.splitlines() if line.strip()]
    paths.append("checksums.sha256")
    files = []
    for path in paths:
        body = (SAMPLE / path).read_bytes()
        world.s3.objects[f"held/{sid}/{path}"] = body
        files.append({"path": path, "size": len(body), "sha256": hashlib.sha256(body).hexdigest()})
    world.submissions.items[(sid,)].update(
        status=status, callbackId="cb-review", files={"1": files}, reportKey=f"reports/{sid}/1.json"
    )
    world.s3.objects[f"reports/{sid}/1.json"] = json.dumps(STUB_REPORT).encode()
    return sid


STUB_REPORT: dict[str, Any] = {
    "round": 1,
    "validation": {"valid": True, "contractVersion": "1", "checkedAt": "2026-11-01T00:00:00Z"},
    "quality": {"errors": 0, "warnings": 2, "notes": 0, "auditedAt": "2026-11-01T00:00:00Z"},
    "findings": [
        {
            "ruleId": "field.description-missing",
            "severity": "warning",
            "message": "battery_v has no description",
            "target": {"resource": "logger", "field": "battery_v"},
        },
        {
            "ruleId": "values.out-of-range",
            "severity": "warning",
            "message": "depth_cm has values out of range",
            "target": {"resource": "logger", "field": "depth_cm"},
            "evidence": {"rows": [3], "count": 1},
        },
    ],
}
"""The held round's report as the pipeline left it: one stale field finding, one from the data."""


def _edit(world: World, sid: str, edits: Any, user: str = "cara") -> tuple[int, Any]:
    return world.call(
        "POST", "/api/submissions/{id}/edits", user, "curator", {"edits": edits}, sid=sid
    )


def _held_folder(world: World, sid: str, into: Path) -> Path:
    prefix = f"held/{sid}/"
    for key, body in world.s3.objects.items():
        if key.startswith(prefix):
            target = into / key[len(prefix) :]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
    return into


def test_a_curator_s_edit_rewrites_the_held_manifest_and_checksums_and_re_checks(
    world: World, tmp_path: Path
) -> None:
    sid = _held_package(world)
    text = "Battery voltage at the reading."

    status, body = _edit(
        world, sid, [{"resource": "logger", "field": "battery_v", "description": text}]
    )

    assert status == 200, body
    manifest = json.loads(world.s3.objects[f"held/{sid}/datapackage.json"])
    logger = next(r for r in manifest["resources"] if r["name"] == "logger")
    battery = next(f for f in logger["schema"]["fields"] if f["name"] == "battery_v")
    assert battery["description"] == text
    assert validate_package(_held_folder(world, sid, tmp_path)) == []
    edited = [e for e in world.events(sid) if e["type"] == "edited"]
    assert len(edited) == 1
    assert edited[0]["actor"] == "cara" and edited[0]["round"] == 1
    assert edited[0]["changes"] == [
        {
            "resource": "logger",
            "field": "battery_v",
            "property": "description",
            "before": None,
            "after": text,
        }
    ]
    report = json.loads(world.s3.objects[f"reports/{sid}/1.json"])
    targets = {(f["ruleId"], (f.get("target") or {}).get("field")) for f in report["findings"]}
    assert ("field.description-missing", "battery_v") not in targets
    assert ("field.description-repeats-name", "depth_cm") in targets
    assert body["report"]["findings"] == report["findings"]
    # An unset `before` is left out of the answer, as every absent detail is.
    assert body["changes"] == [
        {k: v for k, v in change.items() if v is not None} for change in edited[0]["changes"]
    ]


def test_a_unit_edit_sets_archive_unit(world: World) -> None:
    sid = _held_package(world)

    status, body = _edit(world, sid, [{"resource": "logger", "field": "depth_cm", "unit": "mm"}])

    assert status == 200, body
    manifest = json.loads(world.s3.objects[f"held/{sid}/datapackage.json"])
    logger = next(r for r in manifest["resources"] if r["name"] == "logger")
    depth = next(f for f in logger["schema"]["fields"] if f["name"] == "depth_cm")
    assert depth["archive:unit"] == "mm"
    assert body["changes"][0] == {
        "resource": "logger",
        "field": "depth_cm",
        "property": "unit",
        "before": "cm",
        "after": "mm",
    }


@pytest.mark.parametrize(
    "edits",
    [
        [{"resource": "logger", "field": "battery_v", "type": "string"}],
        [{"resource": "logger", "field": "no_such_field", "description": "x"}],
        [{"resource": "no-such-resource", "field": "battery_v", "description": "x"}],
        [{"resource": "logger", "field": "battery_v", "id": "other-dataset"}],
        [{"resource": "logger", "field": "battery_v"}],
        [{"resource": "logger", "field": "battery_v", "description": "  "}],
        [],
    ],
    ids=["type", "unknown-field", "unknown-resource", "dataset-id", "nothing", "blank", "empty"],
)
def test_an_edit_to_anything_but_a_known_field_s_description_or_unit_is_refused(
    world: World, edits: Any
) -> None:
    sid = _held_package(world)
    before = dict(world.s3.objects)

    status, body = _edit(world, sid, edits)

    assert status == 400, body
    assert world.s3.objects == before
    assert not [e for e in world.events(sid) if e["type"] == "edited"]


def test_the_submitter_may_edit_their_own_submission_in_review(world: World) -> None:
    sid = _held_package(world, submitter="alice")
    text = "Battery voltage at the reading."

    status, body = world.call(
        "POST",
        "/api/submissions/{id}/edits",
        "alice",
        "contributor",
        {"edits": [{"resource": "logger", "field": "battery_v", "description": text}]},
        sid=sid,
    )

    assert status == 200, body
    manifest = json.loads(world.s3.objects[f"held/{sid}/datapackage.json"])
    logger = next(r for r in manifest["resources"] if r["name"] == "logger")
    battery = next(f for f in logger["schema"]["fields"] if f["name"] == "battery_v")
    assert battery["description"] == text
    edited = [e for e in world.events(sid) if e["type"] == "edited"]
    assert [e["actor"] for e in edited] == ["alice"]


def test_another_contributor_may_not_edit_a_submission(world: World) -> None:
    sid = _held_package(world, submitter="alice")
    before = dict(world.s3.objects)

    status, body = world.call(
        "POST",
        "/api/submissions/{id}/edits",
        "bob",
        "contributor",
        {"edits": [{"resource": "logger", "field": "battery_v", "description": "x"}]},
        sid=sid,
    )

    assert status == 403, body
    assert world.s3.objects == before


@pytest.mark.parametrize("status", ["draft", "published"])
def test_the_submitter_may_not_edit_their_own_submission_outside_review(
    world: World, status: str
) -> None:
    sid = _held_package(world, submitter="alice", status=status)

    answered, body = world.call(
        "POST",
        "/api/submissions/{id}/edits",
        "alice",
        "contributor",
        {"edits": [{"resource": "logger", "field": "battery_v", "description": "x"}]},
        sid=sid,
    )

    assert answered == 409, body


@pytest.mark.parametrize("status", ["draft", "published"])
def test_an_edit_is_refused_while_the_submission_is_not_in_review(
    world: World, status: str
) -> None:
    sid = _held_package(world, status=status)

    answered, _ = _edit(
        world, sid, [{"resource": "logger", "field": "battery_v", "description": "x"}]
    )

    assert answered == 409


def test_a_vector_resource_s_attribute_can_be_edited(world: World, tmp_path: Path) -> None:
    sid = _held_package(world)

    status, body = _edit(
        world, sid, [{"resource": "sites", "field": "site", "description": "The site's code."}]
    )

    assert status == 200, body
    manifest = json.loads(world.s3.objects[f"held/{sid}/datapackage.json"])
    sites = next(r for r in manifest["resources"] if r["name"] == "sites")
    site = next(f for f in sites["archive:attributes"]["fields"] if f["name"] == "site")
    assert site["description"] == "The site's code."
    assert validate_package(_held_folder(world, sid, tmp_path)) == []


def test_an_edit_reads_only_the_manifest_checksums_and_report(world: World) -> None:
    sid = _held_package(world)
    read: list[str] = []
    get = world.s3.get_object

    def recording(*, Bucket: str, Key: str) -> dict[str, Any]:
        read.append(Key)
        return get(Bucket=Bucket, Key=Key)

    world.s3.get_object = recording  # type: ignore[method-assign]

    status, body = _edit(world, sid, [{"resource": "logger", "field": "depth_cm", "unit": "mm"}])

    assert status == 200, body
    assert sorted(read) == sorted(
        [f"held/{sid}/datapackage.json", f"held/{sid}/checksums.sha256", f"reports/{sid}/1.json"]
    )


def test_an_edit_replaces_only_the_manifest_s_checksum_line(world: World) -> None:
    sid = _held_package(world)
    # Not in the order checksums_text writes, which an edit must keep as it is.
    key = f"held/{sid}/checksums.sha256"
    world.s3.objects[key] = "".join(
        reversed(world.s3.objects[key].decode().splitlines(True))
    ).encode()
    before = world.s3.objects[key].decode().splitlines(keepends=True)

    status, body = _edit(world, sid, [{"resource": "logger", "field": "depth_cm", "unit": "mm"}])

    assert status == 200, body
    after = world.s3.objects[f"held/{sid}/checksums.sha256"].decode().splitlines(keepends=True)
    digest = hashlib.sha256(world.s3.objects[f"held/{sid}/datapackage.json"]).hexdigest()
    assert len(after) == len(before)
    for old, new in zip(before, after, strict=True):
        if old.endswith("  datapackage.json\n"):
            assert new == f"{digest}  datapackage.json\n"
        else:
            assert new == old


def test_an_edit_rebuilds_the_report_s_manifest_findings_and_keeps_the_rest(
    world: World,
) -> None:
    sid = _held_package(world)

    status, body = _edit(
        world, sid, [{"resource": "logger", "field": "battery_v", "description": "Volts."}]
    )

    assert status == 200, body
    report = json.loads(world.s3.objects[f"reports/{sid}/1.json"])
    assert report["validation"] == STUB_REPORT["validation"]
    assert report["quality"] == STUB_REPORT["quality"]
    assert STUB_REPORT["findings"][1] in report["findings"]
    targets = {(f["ruleId"], (f.get("target") or {}).get("field")) for f in report["findings"]}
    assert ("field.description-missing", "battery_v") not in targets
    assert ("field.description-repeats-name", "depth_cm") in targets


def test_the_edited_event_is_written_before_the_held_files(world: World) -> None:
    sid = _held_package(world)

    def refuse(**_: Any) -> dict[str, Any]:
        raise ClientError({"Error": {"Code": "500", "Message": "down"}}, "PutObject")

    world.s3.put_object = refuse  # type: ignore[method-assign]

    with pytest.raises(ClientError):
        _edit(world, sid, [{"resource": "logger", "field": "depth_cm", "unit": "mm"}])

    assert [e["type"] for e in world.events(sid)].count("edited") == 1


def test_an_edit_that_changes_nothing_is_refused(world: World) -> None:
    sid = _held_package(world)
    before = dict(world.s3.objects)

    status, body = _edit(world, sid, [{"resource": "logger", "field": "depth_cm", "unit": " cm "}])

    assert status == 400, body
    assert body["error"] == "nothing changed"
    assert world.s3.objects == before
    assert not [e for e in world.events(sid) if e["type"] == "edited"]


def test_the_submissions_module_imports_no_diagnosis_at_load() -> None:
    code = "import sys, archive_backend.submissions; print('cruise.diagnose' in sys.modules)"
    found = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert found.stdout.strip() == "False"


def test_a_claim_only_id_is_a_new_dataset(world: World) -> None:
    # Another submission's first version being published: the claim, with no currentVersion yet.
    world.catalog["catalog-b"].put_item(
        Item={"PK": "DATASET#stream", "SK": "META", "claimedBy": "sub-a"}
    )

    fresh = world.create("bob", datasetId="stream")

    assert world.submissions.items[(fresh,)]["newVersion"] is False


MIB = 1024**2


def _two_files(size: int) -> list[dict[str, Any]]:
    return [{"path": f"data/{name}.bin", "size": size, "sha256": DIGEST} for name in ("a", "b")]


def test_create_refuses_a_package_over_the_archives_limit(world: World) -> None:
    world.ssm.config = {"publisher": "X", "submissions": {"maxPackageGiB": 1}}

    status, body = world.call(
        "POST", "/api/submissions", "alice", "contributor", {"files": _two_files(600 * MIB)}
    )

    assert status == 400
    assert body["error"] == (
        "the package's files total 1,258,291,200 bytes, "
        "more than the 1 GiB (1,073,741,824 bytes) this archive takes"
    )
    assert world.submissions.items == {}
    assert world.s3.presigned == []


def test_create_takes_a_package_of_exactly_the_limit(world: World) -> None:
    world.ssm.config = {"publisher": "X", "submissions": {"maxPackageGiB": 1}}

    status, body = world.call(
        "POST", "/api/submissions", "alice", "contributor", {"files": _two_files(512 * MIB)}
    )

    assert status == 201, body


def test_the_next_rounds_uploads_are_held_to_the_same_limit(world: World) -> None:
    world.ssm.config = {"publisher": "X", "submissions": {"maxPackageGiB": 1}}
    sid = world.create("alice")
    world.submissions.items[(sid,)].update(status="needs-changes", callbackId="cb-resubmit")
    before = dict(world.submissions.items[(sid,)])
    world.s3.presigned.clear()

    status, body = world.call(
        "POST",
        "/api/submissions/{id}/uploads",
        "alice",
        "contributor",
        {"files": _two_files(600 * MIB)},
        sid=sid,
    )

    assert status == 400
    assert "more than the 1 GiB" in body["error"]
    assert world.submissions.items[(sid,)] == before
    assert world.s3.presigned == []


def test_with_no_setting_the_limit_is_9_gib(world: World) -> None:
    status, body = world.call(
        "POST", "/api/submissions", "alice", "contributor", {"files": _two_files(5 * 1024**3)}
    )

    assert status == 400
    assert "more than the 9 GiB (9,663,676,416 bytes) this archive takes" in body["error"]
