import base64
import hashlib
import io
import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from archive_backend import curation
from archive_backend.integrity import check_archive
from archive_backend.reindex import catalog_items, dataset_item

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"

ARCHIVE = "archive"
TABLE_A = "catalog-a"
TABLE_B = "catalog-b"
PARAMETER = "/research-archive/test/catalog-active"
LIFECYCLE = "ResearchArchive-test-Lifecycle"
PROFILES = "user-profiles"
USER = {"sub": "user-1", "email": "a@example.org"}
CURATOR = {"sub": "curator-1", "cognito:groups": "[curator]"}
ADMIN = {"sub": "admin-1", "cognito:groups": "[admin]"}


def _b64(body: bytes) -> str:
    return base64.b64encode(hashlib.sha256(body).digest()).decode()


class FakeS3:
    """Objects with the full SHA-256 S3 stores: the one a put gave, or the body's own."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.checksums: dict[tuple[str, str], str] = {}
        self.puts: list[str] = []

    def load(self, bucket: str, key: str, body: bytes) -> None:
        self.objects[(bucket, key)] = body
        self.checksums[(bucket, key)] = _b64(body)

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def head_object(self, *, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ChecksumSHA256": self.checksums[(Bucket, Key)]}

    def get_paginator(self, name: str) -> "FakeS3":
        assert name == "list_objects_v2"
        return self

    def paginate(self, *, Bucket: str, Prefix: str) -> Iterator[dict[str, Any]]:
        keys = sorted(k for b, k in self.objects if b == Bucket and k.startswith(Prefix))
        yield {"Contents": [{"Key": k} for k in keys]}

    def put_object(self, *, Bucket: str, Key: str, Body: Any, **kwargs: Any) -> dict[str, Any]:
        body = Body.encode() if isinstance(Body, str) else Body
        self.objects[(Bucket, Key)] = body
        # A put without a checksum stores S3's composite-less default, which the check refuses.
        self.checksums[(Bucket, Key)] = kwargs.get("ChecksumSHA256", "none-")
        self.puts.append(Key)
        return {}

    def delete_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.objects.pop((Bucket, Key), None)
        return {}


class FakeDynamoDB:
    def __init__(self) -> None:
        self.tables: dict[str, dict[tuple[str, str], dict[str, Any]]] = {TABLE_A: {}, TABLE_B: {}}
        self.profiles: dict[str, dict[str, Any]] = {}

    def load(self, table: str, items: list[dict[str, Any]]) -> None:
        for item in items:
            self.tables[table][(item["PK"]["S"], item["SK"]["S"])] = item

    def get_item(self, *, TableName: str, Key: dict[str, Any], **_: Any) -> dict[str, Any]:
        if TableName == PROFILES:
            profile = self.profiles.get(Key["userId"]["S"])
            return {"Item": profile} if profile else {}
        item = self.tables[TableName].get((Key["PK"]["S"], Key["SK"]["S"]))
        return {"Item": item} if item else {}

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        """`SET #a = :a, ...` and `REMOVE #b`, with `attribute_exists(#x)` and
        `attribute_not_exists(#x)` conditions joined by AND."""
        key = kwargs["Key"]
        table = self.tables[kwargs["TableName"]]
        item = table.get((key["PK"]["S"], key["SK"]["S"]))
        names = kwargs.get("ExpressionAttributeNames", {})
        values = kwargs.get("ExpressionAttributeValues", {})
        for name, value in re.findall(r"(\w+) = (:\w+)", kwargs.get("ConditionExpression", "")):
            if item is None or item.get(name) != values[value]:
                raise ClientError(
                    {"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem"
                )
        for test, name in re.findall(
            r"(attribute_\w+)\(([^)]+)\)", kwargs.get("ConditionExpression", "")
        ):
            present = item is not None and names.get(name, name) in item
            if present != (test == "attribute_exists"):
                raise ClientError(
                    {"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem"
                )
        assert item is not None
        for verb, body in re.findall(r"(SET|REMOVE) ([^A-Z]+)", kwargs["UpdateExpression"]):
            for part in body.split(","):
                if verb == "SET":
                    name, value = part.split("=")
                    item[names.get(name.strip(), name.strip())] = values[value.strip()]
                else:
                    item.pop(names.get(part.strip(), part.strip()), None)
        return {}


class FakeSSM:
    def get_parameter(self, *, Name: str) -> dict[str, Any]:
        assert Name == PARAMETER
        return {"Parameter": {"Value": "B"}}


class FakeLambda:
    def __init__(self) -> None:
        self.invokes: list[dict[str, Any]] = []

    def invoke(self, **kwargs: Any) -> dict[str, Any]:
        self.invokes.append(kwargs)
        return {"StatusCode": 202}


class FakeCognito:
    """The pool's accounts by sub, with their live groups, for the live role check."""

    def __init__(self, groups: dict[str, set[str]]) -> None:
        self.groups = groups

    def list_users(self, *, UserPoolId: str, Filter: str, Limit: int) -> dict[str, Any]:
        assert UserPoolId == "pool"
        sub = Filter.split('"')[1]
        if sub not in self.groups:
            return {"Users": []}
        return {
            "Users": [{"Username": f"name-{sub}", "Attributes": [{"Name": "sub", "Value": sub}]}]
        }

    def admin_list_groups_for_user(self, *, UserPoolId: str, Username: str) -> dict[str, Any]:
        assert UserPoolId == "pool"
        names = sorted(self.groups[Username.removeprefix("name-")])
        return {"Groups": [{"GroupName": name} for name in names]}


class FakeEvents:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    def put_item(self, *, Item: dict[str, Any], **_: Any) -> dict[str, Any]:
        self.items.append(Item)
        return {}

    def of(self, subject: str) -> list[dict[str, Any]]:
        return [i for i in self.items if i["subject"] == subject]


class World:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.s3 = FakeS3()
        self.dynamodb = FakeDynamoDB()
        self.lambda_ = FakeLambda()
        self.events = FakeEvents()
        self.cognito = FakeCognito({"curator-1": {"curator"}, "admin-1": {"admin"}})
        clients = curation.Clients(
            s3=self.s3,  # type: ignore[arg-type]
            dynamodb=self.dynamodb,  # type: ignore[arg-type]
            ssm=FakeSSM(),  # type: ignore[arg-type]
            lambda_=self.lambda_,
            account_events=self.events,  # type: ignore[arg-type]
            cognito=self.cognito,  # type: ignore[arg-type]
        )
        monkeypatch.setattr(curation, "clients", lambda: clients)
        monkeypatch.setattr(curation, "_now", lambda: "2026-11-20T10:00:00Z")
        for name, value in {
            "ARCHIVE_BUCKET": ARCHIVE,
            "CATALOG_TABLE_A": TABLE_A,
            "CATALOG_TABLE_B": TABLE_B,
            "ACTIVE_CATALOG_PARAMETER": PARAMETER,
            "LIFECYCLE_FUNCTION": LIFECYCLE,
            "ACCOUNT_EVENTS_TABLE": "account-events",
            "USER_POOL_ID": "pool",
            "USER_PROFILES_TABLE": PROFILES,
        }.items():
            monkeypatch.setenv(name, value)

    def publish(self, dataset_id: str, manifest: dict[str, Any], versions: int = 1) -> None:
        prefix = "open" if manifest.get("archive:access", "public") == "public" else "restricted"
        items: list[dict[str, Any]] = []
        for version in range(1, versions + 1):
            items += catalog_items(prefix, dataset_id, version, json.dumps(manifest))
        items.append(dataset_item(dataset_id, [(prefix, versions, manifest)]))
        self.dynamodb.load(TABLE_B, items)

    def meta(self, dataset_id: str) -> dict[str, Any]:
        return self.dynamodb.tables[TABLE_B][(f"DATASET#{dataset_id}", "META")]

    def call(
        self, method: str, path: str, body: Any = None, claims: dict[str, str] | None = None
    ) -> tuple[int, Any]:
        event: dict[str, Any] = {
            "resource": path,
            "path": path,
            "httpMethod": method,
            "headers": {"content-type": "application/json"},
            "multiValueHeaders": {},
            "queryStringParameters": None,
            "multiValueQueryStringParameters": None,
            "pathParameters": None,
            "body": json.dumps(body) if body is not None else None,
            "isBase64Encoded": False,
            "requestContext": {"stage": "prod", "path": path},
        }
        if claims is not None:
            event["requestContext"]["authorizer"] = {"claims": claims}
        response = curation.handler(event, None)
        text = response.get("body")
        return int(response["statusCode"]), json.loads(text) if text else None

    def lifecycle_runs(self) -> list[dict[str, Any]]:
        return [
            {"FunctionName": i["FunctionName"], "InvocationType": i["InvocationType"]}
            | json.loads(i["Payload"])
            for i in self.lambda_.invokes
        ]


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    yield World(monkeypatch)


REASON = {"reason": "Consent was withdrawn."}
RECORD = {"at": "2026-11-20T10:00:00Z", "by": "admin-1", "reason": "Consent was withdrawn."}


def test_an_admin_withdraws_a_dataset_with_a_reason(world: World) -> None:
    world.publish("ds", {"title": "T"})

    status, body = world.call("POST", "/api/admin/datasets/ds/withdraw", REASON, ADMIN)

    assert status == 200
    assert body == {"datasetId": "ds", "withdrawn": RECORD}
    assert json.loads(world.s3.objects[(ARCHIVE, "state/ds/withdrawn.json")]) == RECORD
    assert json.loads(world.meta("ds")["withdrawn"]["S"]) == RECORD
    assert world.lifecycle_runs() == [
        {"FunctionName": LIFECYCLE, "InvocationType": "Event", "datasetId": "ds", "dois": True}
    ]
    for subject in ("admin-1", "all"):
        [event] = world.events.of(subject)
        assert (event["actor"], event["action"], event["userId"]) == (
            "admin-1",
            "dataset-withdrawn",
            "admin-1",
        )
        assert event["details"] == {"datasetId": "ds", "reason": "Consent was withdrawn."}


def test_withdraw_needs_a_reason(world: World) -> None:
    world.publish("ds", {"title": "T"})

    for body in ({}, {"reason": ""}, {"reason": "   "}):
        status, _ = world.call("POST", "/api/admin/datasets/ds/withdraw", body, ADMIN)
        assert status in (400, 422)
    assert "withdrawn" not in world.meta("ds")
    assert world.lambda_.invokes == []


def test_a_second_withdraw_is_refused_with_409(world: World) -> None:
    world.publish("ds", {"title": "T"})
    world.call("POST", "/api/admin/datasets/ds/withdraw", REASON, ADMIN)

    status, _ = world.call("POST", "/api/admin/datasets/ds/withdraw", {"reason": "Again"}, ADMIN)

    assert status == 409
    assert json.loads(world.meta("ds")["withdrawn"]["S"]) == RECORD
    assert len(world.lambda_.invokes) == 1


def test_restore_removes_the_withdrawal_and_runs_the_lifecycle(world: World) -> None:
    world.publish("ds", {"title": "T"})
    world.call("POST", "/api/admin/datasets/ds/withdraw", REASON, ADMIN)

    status, body = world.call("POST", "/api/admin/datasets/ds/restore", None, ADMIN)

    assert status == 200
    assert body == {"datasetId": "ds"}
    assert (ARCHIVE, "state/ds/withdrawn.json") not in world.s3.objects
    assert "withdrawn" not in world.meta("ds")
    assert world.lifecycle_runs()[1] == {
        "FunctionName": LIFECYCLE,
        "InvocationType": "Event",
        "datasetId": "ds",
        "dois": True,
    }
    assert [e["action"] for e in world.events.of("all")] == [
        "dataset-withdrawn",
        "dataset-restored",
    ]


def test_restore_of_a_dataset_that_is_not_withdrawn_is_refused_with_409(world: World) -> None:
    world.publish("ds", {"title": "T"})

    status, _ = world.call("POST", "/api/admin/datasets/ds/restore", None, ADMIN)

    assert status == 409
    assert world.lambda_.invokes == []


@pytest.mark.parametrize("action", ["withdraw", "restore"])
def test_withdraw_and_restore_are_for_admins_only(world: World, action: str) -> None:
    world.publish("ds", {"title": "T"})

    unsigned, _ = world.call("POST", f"/api/admin/datasets/ds/{action}", REASON)
    user, _ = world.call("POST", f"/api/admin/datasets/ds/{action}", REASON, USER)
    curator, _ = world.call("POST", f"/api/admin/datasets/ds/{action}", REASON, CURATOR)
    missing, _ = world.call("POST", f"/api/admin/datasets/nope/{action}", REASON, ADMIN)

    assert (unsigned, user, curator, missing) == (401, 403, 403, 404)
    assert world.lambda_.invokes == []


def _store_sample(world: World, dataset_id: str, versions: int = 1) -> dict[str, Any]:
    """The sample package published as `versions` versions, in the archive and the catalog."""
    manifest: dict[str, Any] = json.loads((SAMPLE / "datapackage.json").read_text())
    manifest |= {"id": dataset_id, "archive:published": "2026-11-14T09:30:00Z"}
    text = json.dumps(manifest, indent=2) + "\n"
    files = {
        str(p.relative_to(SAMPLE)): p.read_bytes()
        for p in sorted(SAMPLE.rglob("*"))
        if p.is_file() and "_build" not in p.relative_to(SAMPLE).parts
    }
    old = hashlib.sha256(files["datapackage.json"]).hexdigest()
    files["datapackage.json"] = text.encode()
    files["checksums.sha256"] = (
        files["checksums.sha256"].decode().replace(old, hashlib.sha256(text.encode()).hexdigest())
    ).encode()
    items: list[dict[str, Any]] = []
    for version in range(1, versions + 1):
        for path, body in files.items():
            world.s3.load(ARCHIVE, f"open/{dataset_id}/{version}/{path}", body)
        items += catalog_items("open", dataset_id, version, text)
    items.append(dataset_item(dataset_id, [("open", versions, manifest)]))
    world.dynamodb.load(TABLE_B, items)
    return manifest


def _stored(world: World, key: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(world.s3.objects[(ARCHIVE, key)])
    return loaded


def _sums(world: World, root: str) -> dict[str, str]:
    text = world.s3.objects[(ARCHIVE, root + "checksums.sha256")].decode()
    return {line.split()[1]: line.split()[0] for line in text.splitlines() if line.strip()}


CORRECTION = {
    "description": "Hourly water temperature, corrected.",
    "keywords": ["water", "temperature"],
    "note": "Fixed the description's units.",
}


def test_a_curator_corrects_a_published_versions_details(world: World) -> None:
    _store_sample(world, "ds")
    root = "open/ds/1/"
    before = _sums(world, root)

    status, body = world.call("PUT", "/api/datasets/ds/versions/1/metadata", CORRECTION, CURATOR)

    assert status == 200
    manifest = _stored(world, root + "datapackage.json")
    assert body["manifest"] == manifest
    assert manifest["description"] == CORRECTION["description"]
    assert manifest["keywords"] == ["water", "temperature"]
    assert manifest["archive:metadataHistory"][-1] == {
        "when": "2026-11-20T10:00:00Z",
        "who": "curator-1",
        "fields": ["description", "keywords"],
        "note": "Fixed the description's units.",
    }
    readme = world.s3.objects[(ARCHIVE, root + "README.md")].decode()
    assert "Hourly water temperature, corrected." in readme
    after = _sums(world, root)
    assert {p: d for p, d in after.items() if p not in ("datapackage.json", "README.md")} == {
        p: d for p, d in before.items() if p not in ("datapackage.json", "README.md")
    }
    assert (
        after["datapackage.json"]
        == hashlib.sha256(world.s3.objects[(ARCHIVE, root + "datapackage.json")]).hexdigest()
    )
    assert after["README.md"] == hashlib.sha256(readme.encode()).hexdigest()
    item = world.dynamodb.tables[TABLE_B][("DATASET#ds", "V#000001")]
    assert json.loads(item["manifest"]["S"]) == manifest
    assert world.lifecycle_runs() == [
        {"FunctionName": LIFECYCLE, "InvocationType": "Event", "datasetId": "ds", "dois": True}
    ]
    [event] = world.events.of("all")
    assert event["action"] == "metadata-corrected"
    assert event["details"] == {
        "datasetId": "ds",
        "version": 1,
        "fields": ["description", "keywords"],
        "note": "Fixed the description's units.",
    }


def test_the_integrity_check_passes_on_a_corrected_version(world: World) -> None:
    _store_sample(world, "ds")

    world.call("PUT", "/api/datasets/ds/versions/1/metadata", CORRECTION, ADMIN)

    assert check_archive(world.s3, ARCHIVE) == []  # type: ignore[arg-type]


def test_a_correction_of_an_older_version_rewrites_that_version_only(world: World) -> None:
    _store_sample(world, "ds", versions=2)
    v2 = {k: v for k, v in world.s3.objects.items() if k[1].startswith("open/ds/2/")}
    meta = dict(world.meta("ds"))

    status, _ = world.call("PUT", "/api/datasets/ds/versions/1/metadata", CORRECTION, CURATOR)

    assert status == 200
    assert {k: v for k, v in world.s3.objects.items() if k[1].startswith("open/ds/2/")} == v2
    assert _stored(world, "open/ds/1/datapackage.json")["description"] == CORRECTION["description"]
    assert world.meta("ds") == meta
    item = world.dynamodb.tables[TABLE_B][("DATASET#ds", "V#000002")]
    assert "corrected" not in item["manifest"]["S"]


def test_related_identifiers_funding_and_creators_can_be_corrected(world: World) -> None:
    _store_sample(world, "ds")
    body = {
        "archive:relatedIdentifiers": [
            {"identifier": "10.1/x", "identifierType": "DOI", "relationType": "IsCitedBy"}
        ],
        "archive:funding": [{"funder": "NSF", "awardNumber": "123"}],
        "contributors": [
            {
                "title": "Ada Lovelace",
                "roles": ["creator"],
                "orcid": "https://orcid.org/0000-0002-1825-0097",
            }
        ],
        "note": "Added the paper, the grant and Ada's ORCID iD.",
    }

    status, _ = world.call("PUT", "/api/datasets/ds/versions/1/metadata", body, CURATOR)

    assert status == 200
    manifest = _stored(world, "open/ds/1/datapackage.json")
    assert manifest["archive:relatedIdentifiers"][0]["identifier"] == "10.1/x"
    assert manifest["archive:funding"] == [{"funder": "NSF", "awardNumber": "123"}]
    assert manifest["contributors"][0]["orcid"] == "0000-0002-1825-0097"
    assert manifest["archive:metadataHistory"][-1]["fields"] == [
        "contributors",
        "archive:relatedIdentifiers",
        "archive:funding",
    ]


@pytest.mark.parametrize(
    "body",
    [
        {"title": "New title", "note": "n"},
        {"archive:access": "restricted", "note": "n"},
        {"description": "D"},
        {"description": "D", "note": "  "},
        {"note": "nothing changed"},
        {"contributors": [{"title": "A", "orcid": "0000-0002-1825-0098"}], "note": "n"},
    ],
)
def test_a_correction_outside_its_fields_or_without_a_note_is_refused(
    world: World, body: dict[str, Any]
) -> None:
    _store_sample(world, "ds")
    stored = dict(world.s3.objects)

    status, _ = world.call("PUT", "/api/datasets/ds/versions/1/metadata", body, CURATOR)

    assert status in (400, 422)
    assert world.s3.objects == stored
    assert world.lambda_.invokes == []


def test_a_correction_is_for_curators_and_admins_of_a_dataset_that_is_not_withdrawn(
    world: World,
) -> None:
    _store_sample(world, "ds")
    path = "/api/datasets/ds/versions/1/metadata"

    unsigned, _ = world.call("PUT", path, CORRECTION)
    user, _ = world.call("PUT", path, CORRECTION, USER)
    missing, _ = world.call("PUT", "/api/datasets/ds/versions/9/metadata", CORRECTION, CURATOR)
    world.call("POST", "/api/admin/datasets/ds/withdraw", REASON, ADMIN)
    withdrawn, _ = world.call("PUT", path, CORRECTION, CURATOR)

    assert (unsigned, user, missing, withdrawn) == (401, 403, 404, 409)


def test_an_admin_moves_an_embargo_through_the_correction_writer(world: World) -> None:
    _store_sample(world, "ds", versions=2)

    status, body = world.call(
        "PUT", "/api/admin/datasets/ds/embargo", {"until": "2026-12-01"}, ADMIN
    )

    assert status == 200
    manifest = _stored(world, "open/ds/2/datapackage.json")
    assert body == {"datasetId": "ds", "version": 2, "manifest": manifest}
    assert manifest["archive:embargoUntil"] == "2026-12-01"
    assert manifest["archive:metadataHistory"][-1] == {
        "when": "2026-11-20T10:00:00Z",
        "who": "admin-1",
        "fields": ["archive:embargoUntil"],
        "note": "Embargo moved to 2026-12-01",
    }
    assert "archive:embargoUntil" not in _stored(world, "open/ds/1/datapackage.json")
    assert world.meta("ds")["embargoUntil"] == {"S": "2026-12-01"}
    assert check_archive(world.s3, ARCHIVE) == []  # type: ignore[arg-type]
    [event] = world.events.of("all")
    assert (event["action"], event["details"]) == (
        "embargo-moved",
        {"datasetId": "ds", "until": "2026-12-01"},
    )
    # Moving it later holds the public files again, so the lifecycle always runs.
    assert world.lifecycle_runs() == [
        {"FunctionName": LIFECYCLE, "InvocationType": "Event", "datasetId": "ds"}
    ]


def test_moving_an_embargo_needs_an_admin_a_date_and_a_dataset_that_is_not_withdrawn(
    world: World,
) -> None:
    _store_sample(world, "ds")
    path = "/api/admin/datasets/ds/embargo"
    until = {"until": "2026-12-01"}

    unsigned, _ = world.call("PUT", path, until)
    curator, _ = world.call("PUT", path, until, CURATOR)
    bad, _ = world.call("PUT", path, {"until": "next week"}, ADMIN)
    missing, _ = world.call("PUT", "/api/admin/datasets/nope/embargo", until, ADMIN)
    world.call("POST", "/api/admin/datasets/ds/withdraw", REASON, ADMIN)
    withdrawn, _ = world.call("PUT", path, until, ADMIN)

    assert (unsigned, curator, bad, missing, withdrawn) == (401, 403, 422, 404, 409)
    assert "archive:embargoUntil" not in _stored(world, "open/ds/1/datapackage.json")


def test_a_disabled_curator_is_refused_though_their_token_says_curator(world: World) -> None:
    world.publish("ds", {"title": "T", "description": "D"})
    world.dynamodb.profiles["curator-1"] = {
        "userId": {"S": "curator-1"},
        "disabled": {"BOOL": True},
    }

    status, body = world.call(
        "PUT", "/api/datasets/ds/versions/1/metadata", {"description": "E", "note": "n"}, CURATOR
    )

    assert (status, body["message"]) == (403, "your account is disabled")
    assert world.lambda_.invokes == []
    assert world.s3.puts == []


def test_a_demoted_admin_is_refused_though_their_token_says_admin(world: World) -> None:
    world.publish("ds", {"title": "T"})
    world.cognito.groups["admin-1"] = set()

    withdraw, _ = world.call("POST", "/api/admin/datasets/ds/withdraw", REASON, ADMIN)
    embargo, _ = world.call("PUT", "/api/admin/datasets/ds/embargo", {"until": "2026-12-01"}, ADMIN)
    correct, _ = world.call(
        "PUT", "/api/datasets/ds/versions/1/metadata", {"description": "E", "note": "n"}, ADMIN
    )

    assert (withdraw, embargo, correct) == (403, 403, 403)
    assert "withdrawn" not in world.meta("ds")
    assert world.lambda_.invokes == []


def test_an_admin_demoted_to_curator_may_still_correct_but_not_withdraw(world: World) -> None:
    world.publish("ds", {"title": "T"})
    world.cognito.groups["admin-1"] = {"curator"}

    withdraw, _ = world.call("POST", "/api/admin/datasets/ds/withdraw", REASON, ADMIN)

    assert withdraw == 403
    assert world.lambda_.invokes == []


def test_withdrawing_a_claim_only_id_is_not_found(world: World) -> None:
    # A first version being published: the claim, with no currentVersion yet.
    claim = {"PK": {"S": "DATASET#stream"}, "SK": {"S": "META"}, "claimedBy": {"S": "sub-a"}}
    world.dynamodb.tables[TABLE_B][("DATASET#stream", "META")] = dict(claim)

    status, _ = world.call("POST", "/api/admin/datasets/stream/withdraw", REASON, ADMIN)

    assert status == 404
    assert world.meta("stream") == claim
    assert world.lifecycle_runs() == []
