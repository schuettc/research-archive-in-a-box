import base64
import copy
import hashlib
import io
import json
import re
import zipfile
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

import pytest
from aws_durable_execution_sdk_python import DurableContext
from botocore.exceptions import ClientError

from archive_backend import api, doi, ingest, pages, reindex, submissions, zips
from archive_backend.embeddings import Bedrock
from archive_backend.ingest import Clients, Env
from archive_contract.exports.readme import render_readme
from archive_contract.manifest import Manifest
from archive_contract.validate import validate_package
from datacite_fake import FakeDataCite

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"
SID = "sub-1"
STAGING = "staging"
ARCHIVE = "archive"
DERIVED = "derived"
CONFIG = "/research-archive/test/archive-config"
ACTIVE = "/research-archive/test/catalog-active"
DOMAIN = "d111.cloudfront.net"
SITE = "/research-archive/test/site-domain"
COUNTS = "download-counts"
ENV = Env(
    submissions_table="submissions",
    reviews_table="reviews",
    settings_table="settings",
    staging_bucket=STAGING,
    curator_topic_arn="arn:aws:sns:us-east-1:1:curators",
    alert_topic_arn="arn:aws:sns:us-east-1:1:alerts",
    archive_config_parameter=CONFIG,
    archive_bucket=ARCHIVE,
    derived_bucket=DERIVED,
    active_catalog_parameter=ACTIVE,
    catalog_table_a="catalog-a",
    catalog_table_b="catalog-b",
    site_domain=DOMAIN,
)


def _package(**changes: Any) -> dict[str, bytes]:
    files = {
        str(p.relative_to(SAMPLE)): p.read_bytes()
        for p in sorted(SAMPLE.rglob("*"))
        if p.is_file() and "_build" not in p.relative_to(SAMPLE).parts
    }
    if changes:
        manifest = json.loads(files["datapackage.json"])
        manifest.update(changes)
        text = json.dumps(manifest, indent=2).encode()
        old = hashlib.sha256(files["datapackage.json"]).hexdigest()
        files["datapackage.json"] = text
        files["checksums.sha256"] = (
            files["checksums.sha256"]
            .decode()
            .replace(old, hashlib.sha256(text).hexdigest())
            .encode()
        )
    return files


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.puts: list[dict[str, Any]] = []
        self.fail_put: Callable[[str, str], bool] = lambda bucket, key: False
        self.copies: list[dict[str, Any]] = []
        self.fail_copy: Callable[[str, str], bool] = lambda bucket, key: False
        # Paths whose copy arrives with other bytes than its source's.
        self.corrupt: set[str] = set()
        self.gets: list[tuple[str, str]] = []

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.gets.append((Bucket, Key))
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def copy_object(
        self, *, Bucket: str, Key: str, CopySource: dict[str, str], **extra: Any
    ) -> dict[str, Any]:
        """S3's own copy, which answers the SHA-256 of what it stored."""
        if self.fail_copy(Bucket, Key):
            raise RuntimeError(f"copy to {Key} refused")
        body = self.objects[(CopySource["Bucket"], CopySource["Key"])]
        if any(Key.endswith("/" + path) for path in self.corrupt):
            body += b"!"
        self.objects[(Bucket, Key)] = body
        self.copies.append({"Bucket": Bucket, "Key": Key, "CopySource": CopySource, **extra})
        checksum = base64.b64encode(hashlib.sha256(body).digest()).decode()
        return {"CopyObjectResult": {"ChecksumSHA256": checksum}}

    def put_object(self, *, Bucket: str, Key: str, Body: Any, **extra: Any) -> dict[str, Any]:
        if self.fail_put(Bucket, Key):
            raise RuntimeError(f"put of {Key} refused")
        body = Body.read() if hasattr(Body, "read") else Body
        body = body.encode() if isinstance(body, str) else body
        if "ChecksumSHA256" in extra:
            assert (
                extra["ChecksumSHA256"] == base64.b64encode(hashlib.sha256(body).digest()).decode()
            )
        self.objects[(Bucket, Key)] = body
        self.puts.append({"Bucket": Bucket, "Key": Key, **extra})
        return {}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        put = next(p for p in reversed(self.puts) if (p["Bucket"], p["Key"]) == (Bucket, Key))
        return {"Metadata": put.get("Metadata", {})}

    def get_paginator(self, name: str) -> "FakeS3":
        assert name == "list_objects_v2"
        return self

    def paginate(self, *, Bucket: str, Prefix: str) -> Iterator[dict[str, Any]]:
        keys = sorted(k for b, k in self.objects if b == Bucket and k.startswith(Prefix))
        for start in range(0, len(keys), 4):
            yield {"Contents": [{"Key": k} for k in keys[start : start + 4]]}

    def delete_objects(self, *, Bucket: str, Delete: dict[str, Any]) -> dict[str, Any]:
        for entry in Delete["Objects"]:
            self.objects.pop((Bucket, entry["Key"]), None)
        return {}

    def keys(self, bucket: str, prefix: str = "") -> list[str]:
        return sorted(k for b, k in self.objects if b == bucket and k.startswith(prefix))


class FakeDynamoDB:
    """The catalog tables, keyed by (PK, SK), in DynamoDB JSON."""

    def __init__(self) -> None:
        self.tables: dict[str, dict[tuple[str, str], dict[str, Any]]] = {
            "catalog-a": {},
            "catalog-b": {},
        }
        self.stale: dict[str, dict[tuple[str, str], dict[str, Any]]] | None = None
        self.writes: list[tuple[str, str]] = []
        self.before_put: Callable[[], None] | None = None

    def get_item(self, *, TableName: str, Key: dict[str, Any]) -> dict[str, Any]:
        # A stale snapshot answers one read, as a publish that read before another wrote.
        tables, self.stale = self.stale or self.tables, None
        item = tables[TableName].get((Key["PK"]["S"], Key["SK"]["S"]))
        return {"Item": item} if item else {}

    @staticmethod
    def _holds(condition: str, item: dict[str, Any] | None, values: dict[str, Any]) -> bool:
        """`attribute_exists(a)`, `attribute_not_exists(a)` and `a = :x`, joined by AND, OR and
        brackets."""
        item = item or {}
        text = re.sub(
            r"attribute_(not_)?exists\((\w+)\)",
            lambda m: str((m[2] in item) != bool(m[1])),
            condition,
        )
        text = re.sub(r"(\w+) = (:\w+)", lambda m: str(item.get(m[1]) == values[m[2]]), text)
        text = text.replace("AND", "and").replace("OR", "or")
        assert re.fullmatch(r"[TrueFalsandor() ]+", text), condition
        return bool(eval(text))

    def _check(
        self, operation: str, table: str, key: tuple[str, str], condition: str, values: Any
    ) -> None:
        if not self._holds(condition, self.tables[table].get(key), values):
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException", "Message": "no"}}, operation
            )

    def update_item(
        self,
        *,
        TableName: str,
        Key: dict[str, Any],
        UpdateExpression: str,
        ConditionExpression: str,
        ExpressionAttributeValues: dict[str, Any],
    ) -> dict[str, Any]:
        """`SET a = :x, ...` or `REMOVE a`, under a condition."""
        key = (Key["PK"]["S"], Key["SK"]["S"])
        self.writes.append(("update", key[0]))
        self._check("UpdateItem", TableName, key, ConditionExpression, ExpressionAttributeValues)
        item = self.tables[TableName].setdefault(key, dict(Key))
        if UpdateExpression.startswith("REMOVE "):
            item.pop(UpdateExpression[7:].strip(), None)
            return {}
        assert UpdateExpression.startswith("SET ")
        for assignment in UpdateExpression[4:].split(","):
            name, value = (part.strip() for part in assignment.split("="))
            item[name] = ExpressionAttributeValues[value]
        return {}

    def put_item(
        self,
        *,
        TableName: str,
        Item: dict[str, Any],
        ConditionExpression: str,
        ExpressionAttributeValues: dict[str, Any],
    ) -> dict[str, Any]:
        key = (Item["PK"]["S"], Item["SK"]["S"])
        if self.before_put:
            hook, self.before_put = self.before_put, None
            hook()
        self._check("PutItem", TableName, key, ConditionExpression, ExpressionAttributeValues)
        self.writes.append(("put", key[0]))
        self.tables[TableName][key] = Item
        return {}

    def delete_item(
        self,
        *,
        TableName: str,
        Key: dict[str, Any],
        ConditionExpression: str,
        ExpressionAttributeValues: dict[str, Any],
    ) -> dict[str, Any]:
        key = (Key["PK"]["S"], Key["SK"]["S"])
        self._check("DeleteItem", TableName, key, ConditionExpression, ExpressionAttributeValues)
        del self.tables[TableName][key]
        return {}

    def query(
        self,
        *,
        TableName: str,
        KeyConditionExpression: str,
        ExpressionAttributeValues: dict[str, Any],
        **page: Any,
    ) -> dict[str, Any]:
        """A partition's items whose sort key begins with `:sk`, two per page; no downloads
        have been counted."""
        if TableName == COUNTS:
            return {"Items": []}
        assert KeyConditionExpression == "PK = :pk AND begins_with(SK, :sk)"
        pk, sk = ExpressionAttributeValues[":pk"]["S"], ExpressionAttributeValues[":sk"]["S"]
        rows = [
            item
            for (p, k), item in sorted(self.tables[TableName].items())
            if p == pk and k.startswith(sk)
        ]
        if "FilterExpression" in page:
            assert page["FilterExpression"] == "attribute_exists(#v)"
            rows = [row for row in rows if page["ExpressionAttributeNames"]["#v"] in row]
        start = page.get("ExclusiveStartKey", {}).get("n", 0)
        answer: dict[str, Any] = {"Items": rows[start : start + 2]}
        if start + 2 < len(rows):
            answer["LastEvaluatedKey"] = {"n": start + 2}
        return answer

    def batch_write_item(self, *, RequestItems: dict[str, Any]) -> dict[str, Any]:
        for table, requests in RequestItems.items():
            assert len(requests) <= 25
            for request in requests:
                if "DeleteRequest" in request:
                    key = request["DeleteRequest"]["Key"]
                    self.tables[table].pop((key["PK"]["S"], key["SK"]["S"]), None)
                    continue
                item = request["PutRequest"]["Item"]
                self.writes.append(("put", item["PK"]["S"]))
                self.tables[table][(item["PK"]["S"], item["SK"]["S"])] = item
        return {"UnprocessedItems": {}}

    def scan(self, *, TableName: str) -> dict[str, Any]:
        return {"Items": list(self.tables[TableName].values())}

    def updates_after_put(self, pk: str) -> int:
        """How many updates of `pk` came after its first put."""
        writes = [op for op, key in self.writes if key == pk]
        return writes[writes.index("put") :].count("update")


class FakeTable:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []

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
            for assignment in sets[4:].split(","):
                name, value = (part.strip() for part in assignment.split("="))
                item[names[name]] = values[value]
        for name in filter(None, (part.strip() for part in removes.split(","))):
            item.pop(names[name], None)
        return {}

    def put_item(self, *, Item: dict[str, Any], **_: Any) -> Any:
        self.events.append(Item)
        return {}


class FakeSSM:
    def __init__(self) -> None:
        self.active = "B"
        self.config: dict[str, Any] = {"publisher": "Example Archive"}

    def get_parameter(self, *, Name: str) -> dict[str, Any]:
        if Name == ACTIVE:
            return {"Parameter": {"Value": self.active}}
        if Name == SITE:
            return {"Parameter": {"Value": DOMAIN}}
        assert Name == CONFIG
        return {"Parameter": {"Value": json.dumps(self.config)}}


class FakeSNS:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    def publish(self, **kwargs: Any) -> dict[str, Any]:
        self.messages.append(kwargs)
        return {}


class FakeBedrock:
    def __init__(self) -> None:
        self.texts: list[str] = []

    def invoke_model(self, **kwargs: Any) -> dict[str, Any]:
        body = json.loads(kwargs["body"])
        self.texts.append(body["inputText"])
        answer = {"embedding": [0.5] * body["dimensions"]}
        return {"body": io.BytesIO(json.dumps(answer).encode())}


class StepContext:
    def __init__(self) -> None:
        self.names: list[str | None] = []

    def step(self, func: Callable[[Any], Any], name: str | None = None) -> Any:
        self.names.append(name)
        return func(None)


class World:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.s3 = FakeS3()
        self.dynamodb = FakeDynamoDB()
        self.ssm = FakeSSM()
        self.bedrock = FakeBedrock()
        self.sns = FakeSNS()
        self.datacite = FakeDataCite()
        self.submissions = FakeTable()
        self.reviews = FakeTable()
        self.now = datetime(2026, 11, 14, 9, 30, tzinfo=UTC)
        self.clients = Clients(
            s3=cast(ingest.S3, self.s3),
            sns=cast(ingest.SNS, self.sns),
            ssm=cast(ingest.SSM, self.ssm),
            dynamodb=cast(ingest.DynamoDB, self.dynamodb),
            submissions=cast(submissions.Table, self.submissions),
            reviews=cast(submissions.Table, self.reviews),
            settings=cast(submissions.Table, None),
            bedrock=cast(Bedrock, self.bedrock),
        )
        monkeypatch.setattr(ingest, "_clock", lambda: self.now)
        monkeypatch.setattr(doi, "client", lambda ssm, settings: self.datacite)
        self.monkeypatch = monkeypatch

    def hold(self, sid: str, files: dict[str, bytes], **record: Any) -> None:
        self.submissions.items[sid] = {
            "submissionId": sid,
            "submitter": "alice",
            "status": "in-review",
            "round": 1,
            "newVersion": False,
            "callbackId": "cb-1",
            **record,
        }
        for path, body in files.items():
            self.s3.objects[(STAGING, f"held/{sid}/{path}")] = body

    def version(self, sid: str) -> dict[str, Any]:
        """The version step alone."""
        target: dict[str, Any] = ingest._version(self.clients, ENV, sid)(None)  # type: ignore[arg-type]
        return target

    def fail(self, sid: str, error: str) -> None:
        """The fail step alone, as `run` calls it when a step has failed for good."""
        ingest._fail(self.clients, ENV, sid, error)(None)  # type: ignore[arg-type]

    def catalog(self, sid: str, target: dict[str, Any], prefix: str = "open") -> None:
        """The catalog step alone, for a version whose files are in the archive bucket."""
        filled = {"prefix": prefix}
        ingest._catalog(self.clients, ENV, sid, target, filled)(None)  # type: ignore[arg-type]

    def read(self, path: str, query: dict[str, str] | None = None) -> tuple[int, Any]:
        """A GET of the read API over the same catalog tables, with no one signed in."""
        readers = api.Clients(
            s3=cast(Any, self.s3),
            dynamodb=cast(api.DynamoDB, self.dynamodb),
            ssm=cast(api.SSM, self.ssm),
            bedrock=cast(Bedrock, self.bedrock),
            cognito=cast(Any, None),
        )
        self.monkeypatch.setattr(api, "clients", lambda: readers)
        self.monkeypatch.setenv("ACTIVE_CATALOG_PARAMETER", ACTIVE)
        self.monkeypatch.setenv("CATALOG_TABLE_A", "catalog-a")
        self.monkeypatch.setenv("CATALOG_TABLE_B", "catalog-b")
        self.monkeypatch.setenv("SITE_DOMAIN_PARAMETER", SITE)
        self.monkeypatch.setenv("DOWNLOAD_COUNTS_TABLE", COUNTS)
        api.reset_caches()
        event: dict[str, Any] = {
            "resource": path,
            "path": path,
            "httpMethod": "GET",
            "headers": {},
            "multiValueHeaders": {},
            "queryStringParameters": query,
            "multiValueQueryStringParameters": {k: [v] for k, v in (query or {}).items()} or None,
            "pathParameters": None,
            "body": None,
            "isBase64Encoded": False,
            "requestContext": {"stage": "prod", "path": path},
        }
        response = api.handler(event, cast(Any, None))
        return int(response["statusCode"]), json.loads(response["body"])

    def race(self, first: str, second: str) -> dict[str, Any]:
        """Both version steps read the catalog, then `first` claims, then `second`."""
        before = copy.deepcopy(self.dynamodb.tables)
        target = self.version(first)
        self.dynamodb.stale = before
        self.version(second)
        return target

    def publish(self, sid: str = SID) -> StepContext:
        context = StepContext()
        ingest.publish(cast(DurableContext, context), self.clients, ENV, sid, 1, 3)
        return context

    def table(self) -> dict[tuple[str, str], dict[str, Any]]:
        return self.dynamodb.tables["catalog-b"]


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> World:
    return World(monkeypatch)


def _manifest(world: World, key: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(world.s3.objects[(ARCHIVE, key)])
    return loaded


def test_a_new_dataset_publishes_version_1_under_a_minted_id(world: World) -> None:
    world.hold(SID, _package(id=None))

    context = world.publish()

    item = world.submissions.items[SID]
    dataset_id = item["datasetId"]
    assert re.fullmatch(r"stream-temperature-at-three-invented-sites-[a-z]{6}", dataset_id)
    assert item["status"] == "published"
    assert "callbackId" not in item
    root = f"open/{dataset_id}/1/"
    manifest = _manifest(world, root + "datapackage.json")
    assert manifest["id"] == dataset_id
    assert manifest["version"] == "1"
    assert manifest["archive:published"] == "2026-11-14T09:30:00Z"
    assert manifest["archive:publisher"] == "Example Archive"
    assert manifest["archive:identifier"] == f"https://{DOMAIN}/datasets/{dataset_id}/v1"
    stored = [k for k in world.s3.keys(ARCHIVE) if "/_zips/" not in k]
    assert stored == sorted(root + p for p in _package())
    assert world.s3.keys(STAGING, f"held/{SID}/") == []
    [event] = world.reviews.events
    assert (event["type"], event["datasetId"], event["version"], event["rule"]) == (
        "published",
        dataset_id,
        1,
        3,
    )
    assert len(context.names) == len(set(context.names))
    assert all(name and name.startswith("publish-1-") for name in context.names)


def test_a_second_publish_of_the_same_id_is_version_2(world: World) -> None:
    world.hold("sub-a", _package(), datasetId="stream")
    world.publish("sub-a")
    world.hold("sub-b", _package(), datasetId="stream", newVersion=True)

    world.publish("sub-b")

    manifest = _manifest(world, "open/stream/2/datapackage.json")
    assert (manifest["id"], manifest["version"]) == ("stream", "2")
    assert world.table()[("DATASET#stream", "META")]["currentVersion"] == {"N": "2"}
    assert ("DATASET#stream", "V#000001") in world.table()
    assert world.submissions.items["sub-b"]["datasetId"] == "stream"


@pytest.mark.parametrize("access", ["limited", "restricted"])
def test_limited_and_restricted_data_go_under_restricted(world: World, access: str) -> None:
    world.hold(SID, _package(**{"archive:access": access}), datasetId="secret")

    world.publish()

    keys = world.s3.keys(ARCHIVE)
    assert keys and all(k.startswith("restricted/secret/1/") for k in keys)
    page = world.s3.objects[(DERIVED, "site/datasets/secret/index.html")].decode()
    assert "/data/secret/" not in page


def test_every_file_is_copied_by_s3_and_checked_against_checksums_sha256(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    copies = [c for c in world.s3.copies if c["Bucket"] == ARCHIVE]
    assert sorted(c["Key"] for c in copies) == sorted("open/stream/1/" + p for p in _package())
    for made in copies:
        path = made["Key"].removeprefix("open/stream/1/")
        assert made["CopySource"] == {"Bucket": STAGING, "Key": f"held/{SID}/{path}"}
        assert made["ChecksumAlgorithm"] == "SHA256"
        assert (made["MetadataDirective"], made["TaggingDirective"]) == ("REPLACE", "REPLACE")
        assert "Tagging" not in made
    assert copies[-1]["Key"] == "open/stream/1/datapackage.json"
    kinds = {c["Key"].rsplit("/", 1)[-1]: c.get("ContentType") for c in copies}
    assert (kinds["logger.csv"], kinds["datapackage.json"]) == ("text/csv", "application/json")
    # Nothing but the zips goes to the archive by a PUT, and no held data file is read.
    assert all("/_zips/" in p["Key"] for p in world.s3.puts if p["Bucket"] == ARCHIVE)
    assert (STAGING, f"held/{SID}/data/logger.csv") not in world.s3.gets


def test_a_copy_that_differs_from_its_checksum_line_stops_before_the_manifest(
    world: World,
) -> None:
    world.hold(SID, _package(), datasetId="stream")
    world.s3.corrupt = {"data/logger.csv"}

    with pytest.raises(ingest.CopyMismatch, match="data/logger.csv"):
        world.publish()

    assert "open/stream/1/datapackage.json" not in world.s3.keys(ARCHIVE)
    assert "currentVersion" not in world.table()[("DATASET#stream", "META")]


def test_the_published_version_validates(world: World, tmp_path: Path) -> None:
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    for key in world.s3.keys(ARCHIVE, "open/stream/1/"):
        if "/_zips/" in key:
            continue
        target = tmp_path / key.removeprefix("open/stream/1/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(world.s3.objects[(ARCHIVE, key)])
    assert validate_package(tmp_path) == []
    manifest = Manifest.model_validate_json((tmp_path / "datapackage.json").read_text())
    assert (tmp_path / "README.md").read_text(encoding="utf-8") == render_readme(manifest)


def test_the_catalog_items_are_what_the_reindex_builds(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    text = world.s3.objects[(ARCHIVE, "open/stream/1/datapackage.json")].decode()
    expected = [
        *reindex.catalog_items("open", "stream", 1, text),
        reindex.dataset_item("stream", [("open", 1, json.loads(text))]),
    ]
    assert world.table() == {(i["PK"]["S"], i["SK"]["S"]): i for i in expected}
    assert world.dynamodb.tables["catalog-a"] == {}


def test_with_the_embeddings_module_the_dataset_item_is_written_with_its_embedding(
    world: World,
) -> None:
    world.ssm.config["infrastructure"] = {"alertEmail": "a@b.c", "modules": {"embeddings": {}}}
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    meta = world.table()[("DATASET#stream", "META")]
    assert len(meta["embedding"]["L"]) == 1024
    assert all(float(n["N"]) == 0.5 for n in meta["embedding"]["L"])
    [text] = world.bedrock.texts
    assert text.startswith("Stream temperature")
    assert world.dynamodb.updates_after_put("DATASET#stream") == 0


def test_without_the_embeddings_module_bedrock_is_never_called(world: World) -> None:
    world.ssm.config["infrastructure"] = {"alertEmail": "a@b.c"}
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    assert world.bedrock.texts == []
    assert "embedding" not in world.table()[("DATASET#stream", "META")]


def test_the_page_is_written_with_its_json_ld(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    put, versioned = [
        p for p in world.s3.puts if p["Bucket"] == DERIVED and p["Key"].startswith("site/datasets/")
    ]
    assert put["Key"] == "site/datasets/stream/index.html"
    assert versioned["Key"] == "site/datasets/stream/v1/index.html"
    assert put["ContentType"].startswith("text/html")
    # A later version's page must show within five minutes, not CloudFront's default TTL.
    assert put["CacheControl"] == "max-age=300"
    page = world.s3.objects[(DERIVED, put["Key"])].decode()
    block = page.split('<script type="application/ld+json">', 1)[1].split("</script>", 1)[0]
    assert json.loads(block)["identifier"] == f"https://{DOMAIN}/datasets/stream/v1"
    assert f"https://{DOMAIN}/data/stream/1/data/logger.csv" in page


def test_publish_writes_the_catalog_file_with_the_new_dataset(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    rows = json.loads(world.s3.objects[(DERIVED, "site/catalog.json")])
    assert [row["id"] for row in rows] == ["stream"]
    assert rows[0]["version"] == 1


def test_the_catalog_file_is_written_after_the_dataset_pages(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    keys = [p["Key"] for p in world.s3.puts if p["Bucket"] == DERIVED]
    listed = keys.index("site/catalog.json")
    assert "site/datasets/stream/index.html" in keys[:listed]
    assert "site/datasets/stream/v1/index.html" in keys[:listed]


def test_publish_rewrites_the_sitemap_after_the_catalog_file(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")

    context = world.publish()

    keys = [p["Key"] for p in world.s3.puts if p["Bucket"] == DERIVED]
    assert keys[-2:] == ["site/catalog.json", "site/sitemap.xml"]
    sitemap = world.s3.objects[(DERIVED, "site/sitemap.xml")].decode()
    assert f"<loc>https://{DOMAIN}/datasets/stream/v1</loc>" in sitemap
    assert "publish-1-sitemap" in context.names


def test_the_page_goes_through_the_shared_page_writer(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    written: list[tuple[str, str, int | None]] = []
    write_page = pages.write_page

    def recording(
        s3: Any, bucket: str, html: str, dataset_id: str, version: int | None = None
    ) -> str:
        written.append((bucket, dataset_id, version))
        return write_page(s3, bucket, html, dataset_id, version)

    monkeypatch.setattr(pages, "write_page", recording)
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    # The reindex rebuilds pages with the same writer, so the two never drift apart.
    assert written == [(DERIVED, "stream", None), (DERIVED, "stream", 1)]


def test_a_new_dataset_whose_id_was_taken_meanwhile_is_refused(world: World) -> None:
    world.hold("sub-a", _package(), datasetId="stream")
    world.publish("sub-a")
    world.hold("sub-b", _package(), datasetId="stream")

    with pytest.raises(ingest.PublishConflict):
        world.publish("sub-b")

    assert world.s3.keys(ARCHIVE, "open/stream/2/") == []


def test_two_new_submissions_racing_for_version_1_of_one_id_claim_it_once(world: World) -> None:
    world.hold("sub-a", _package(), datasetId="stream")
    world.hold("sub-b", _package(), datasetId="stream")

    with pytest.raises(ingest.PublishConflict):
        world.race("sub-a", "sub-b")

    world.publish("sub-a")
    assert world.s3.keys(ARCHIVE, "open/stream/1/")
    assert world.submissions.items["sub-b"]["status"] == "in-review"


def test_two_new_versions_racing_for_the_next_version_claim_it_once(world: World) -> None:
    world.hold("sub-a", _package(), datasetId="stream")
    world.publish("sub-a")
    world.hold("sub-b", _package(), datasetId="stream", newVersion=True)
    world.hold("sub-c", _package(), datasetId="stream", newVersion=True)

    with pytest.raises(ingest.PublishConflict):
        world.race("sub-b", "sub-c")

    world.publish("sub-b")
    assert world.table()[("DATASET#stream", "META")]["currentVersion"] == {"N": "2"}


def test_a_retried_version_step_keeps_its_own_claim(world: World) -> None:
    world.hold(SID, _package(id=None))

    first = world.version(SID)
    again = world.version(SID)

    assert again == first
    claim = world.table()[(f"DATASET#{first['datasetId']}", "META")]
    assert claim["claimedBy"] == {"S": SID} and "currentVersion" not in claim
    world.publish()
    meta = world.table()[(f"DATASET#{first['datasetId']}", "META")]
    assert meta["currentVersion"] == {"N": "1"} and "claimedBy" not in meta


def test_the_zips_are_written_before_the_version_goes_live(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    world.hold(SID, _package(**{"archive:access": "limited"}), datasetId="secret")
    real = zips.write_zips
    live: list[bool] = []

    def writing(*args: Any, **kwargs: Any) -> list[str]:
        live.append("currentVersion" in world.table()[("DATASET#secret", "META")])
        return real(*args, **kwargs)

    monkeypatch.setattr(zips, "write_zips", writing)

    context = world.publish()

    assert context.names[:6] == [
        f"publish-1-{part}" for part in ("version", "fill", "copy", "zips", "catalog", "page")
    ]
    assert live == [False]
    root = "restricted/secret/1/"
    written = world.s3.keys(ARCHIVE, root + "_zips/")
    assert written == [
        root + "_zips/all/package.zip",
        root + "_zips/depth.zip",
        root + "_zips/sites.zip",
    ]
    listed = world.s3.objects[(ARCHIVE, root + "checksums.sha256")].decode()
    with zipfile.ZipFile(
        io.BytesIO(world.s3.objects[(ARCHIVE, root + "_zips/all/package.zip")])
    ) as z:
        for line in listed.splitlines():
            digest, path = line.split(maxsplit=1)
            assert hashlib.sha256(z.read(path)).hexdigest() == digest
    assert ("DATASET#secret", "V#000001#FILE#_zips/all/package.zip") in world.table()


def test_a_zip_failure_leaves_readers_on_the_version_before(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    world.hold("sub-a", _package(), datasetId="stream")
    world.publish("sub-a")
    world.hold("sub-b", _package(), datasetId="stream", newVersion=True)

    def refuse(*args: Any, **kwargs: Any) -> list[str]:
        raise RuntimeError("zip refused")

    monkeypatch.setattr(zips, "write_zips", refuse)

    with pytest.raises(RuntimeError, match="zip refused"):
        world.publish("sub-b")

    assert world.table()[("DATASET#stream", "META")]["currentVersion"] == {"N": "1"}
    assert ("DATASET#stream", "V#000002") not in world.table()
    status, body = world.read("/api/datasets/stream")
    assert (status, body["currentVersion"]) == (200, 1)


def test_a_public_dataset_with_an_embargo_to_come_is_held_under_restricted(world: World) -> None:
    world.hold(SID, _package(**{"archive:embargoUntil": "2026-12-01"}), datasetId="later")

    world.publish()

    keys = world.s3.keys(ARCHIVE)
    assert keys and all(k.startswith("restricted/later/1/") for k in keys)
    meta = world.table()[("DATASET#later", "META")]
    assert (meta["prefix"], meta["access"], meta["embargoUntil"]) == (
        {"S": "restricted"},
        {"S": "public"},
        {"S": "2026-12-01"},
    )
    page = world.s3.objects[(DERIVED, "site/datasets/later/index.html")].decode()
    assert "Files available from 2026-12-01" in page
    assert "/data/later/" not in page


def test_an_embargo_that_has_ended_publishes_public_files_under_open(world: World) -> None:
    world.hold(SID, _package(**{"archive:embargoUntil": "2026-11-14"}), datasetId="now")

    world.publish()

    assert all(k.startswith("open/now/1/") for k in world.s3.keys(ARCHIVE))


def test_a_new_version_of_a_withdrawn_dataset_stays_withdrawn_and_held(world: World) -> None:
    withdrawn = {"at": "2026-11-13T00:00:00Z", "by": "admin-1", "reason": "Consent ended."}
    world.hold("sub-a", _package(), datasetId="gone")
    world.publish("sub-a")
    world.table()[("DATASET#gone", "META")]["withdrawn"] = {"S": json.dumps(withdrawn)}
    world.hold("sub-b", _package(), datasetId="gone", newVersion=True)

    world.publish("sub-b")

    assert world.s3.keys(ARCHIVE, "open/gone/2/") == []
    assert world.s3.keys(ARCHIVE, "restricted/gone/2/")
    meta = world.table()[("DATASET#gone", "META")]
    assert json.loads(meta["withdrawn"]["S"]) == withdrawn
    page = world.s3.objects[(DERIVED, "site/datasets/gone/index.html")].decode()
    assert "Consent ended." in page


DOI_BLOCK = {"repository": "EXAMPLE.IRC", "prefix": "10.5072", "test": True}
DOI_NAME = "10.5072/example.irc.stream.v1"
DOI_ADDRESS = "https://handle.test.datacite.org/" + DOI_NAME


def _verifies(world: World, root: str) -> bool:
    listed = world.s3.objects[(ARCHIVE, root + "checksums.sha256")].decode()
    for line in listed.splitlines():
        digest, path = line.split(maxsplit=1)
        if hashlib.sha256(world.s3.objects[(ARCHIVE, root + path)]).hexdigest() != digest:
            return False
    return True


def test_without_the_doi_module_the_steps_are_exactly_todays(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")

    context = world.publish()

    assert context.names == [
        f"publish-1-{part}"
        for part in ("version", "fill", "copy", "zips", "catalog", "page", "catalog-file")
        + ("sitemap", "finish")
    ]
    assert world.datacite.calls == []


def test_with_the_doi_module_publish_registers_a_findable_doi_and_shows_it(world: World) -> None:
    world.ssm.config["doi"] = DOI_BLOCK
    world.hold(SID, _package(), datasetId="stream")

    context = world.publish()

    assert world.submissions.items[SID]["status"] == "published"
    assert list(world.datacite.dois) == [DOI_NAME]
    registered = world.datacite.dois[DOI_NAME]
    assert registered["state"] == "findable"
    assert registered["url"] == f"https://{DOMAIN}/datasets/stream/v1"
    assert registered["publisher"] == {"name": "Example Archive"}
    assert _manifest(world, "open/stream/1/datapackage.json")["archive:identifier"] == DOI_ADDRESS
    item = json.loads(world.table()[("DATASET#stream", "V#000001")]["manifest"]["S"])
    assert item["archive:identifier"] == DOI_ADDRESS
    for key in ("site/datasets/stream/index.html", "site/datasets/stream/v1/index.html"):
        assert f'href="{DOI_ADDRESS}"' in world.s3.objects[(DERIVED, key)].decode()
    assert _verifies(world, "open/stream/1/")
    assert context.names[-3:] == ["publish-1-catalog-file", "publish-1-sitemap", "publish-1-finish"]
    assert "publish-1-doi" in context.names
    at = context.names.index("publish-1-doi-identifier")
    assert context.names[at + 1 : at + 4] == [
        f"publish-1-doi-{part}" for part in ("zips", "catalog", "page")
    ]
    assert len(context.names) == len(set(context.names))
    assert world.sns.messages == []


def test_a_datacite_failure_alerts_and_the_version_publishes_without_a_doi(world: World) -> None:
    world.ssm.config["doi"] = DOI_BLOCK
    world.datacite.fail(5)
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    assert world.submissions.items[SID]["status"] == "published"
    manifest = _manifest(world, "open/stream/1/datapackage.json")
    assert manifest["archive:identifier"] == f"https://{DOMAIN}/datasets/stream/v1"
    assert world.datacite.dois == {}
    [alert] = world.sns.messages
    assert alert["TopicArn"] == ENV.alert_topic_arn
    assert alert["Subject"] == "DOI not registered: stream v1"
    assert "--dois" in alert["Message"] and "503" in alert["Message"]
    assert "just reindex test --dois" in alert["Message"]


@pytest.mark.parametrize("step", ["doi-identifier", "doi-catalog", "doi-page"])
def test_a_failure_after_registering_alerts_and_the_publish_still_finishes(
    world: World, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    world.ssm.config["doi"] = DOI_BLOCK
    world.hold(SID, _package(), datasetId="stream")
    target = {"doi-identifier": (doi, "write_identifier"), "doi-catalog": (ingest, "catalog_items")}
    target["doi-page"] = (pages, "render_page")
    module, attr = target[step]
    real = getattr(module, attr)
    calls = {"n": 0}

    def failing(*args: Any, **kwargs: Any) -> Any:
        calls["n"] += 1
        # The plain catalog step builds once, the plain page step renders twice, first.
        if calls["n"] == {"doi-identifier": 1, "doi-catalog": 2, "doi-page": 3}[step]:
            raise ClientError({"Error": {"Code": "SlowDown"}}, "PutObject")
        return real(*args, **kwargs)

    monkeypatch.setattr(module, attr, failing)

    context = world.publish()

    assert world.submissions.items[SID]["status"] == "published"
    assert context.names[-4:] == [
        "publish-1-doi-alert",
        "publish-1-catalog-file",
        "publish-1-sitemap",
        "publish-1-finish",
    ]
    [alert] = world.sns.messages
    assert alert["Subject"] == "DOI not written: stream v1"
    assert "SlowDown" in alert["Message"]
    assert "just reindex test --dois" in alert["Message"]


def test_a_taken_doi_alerts_and_is_not_overwritten(world: World) -> None:
    world.ssm.config["doi"] = DOI_BLOCK
    world.datacite.dois[DOI_NAME] = {"url": "https://other.example/datasets/stream/v1"}
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    assert world.submissions.items[SID]["status"] == "published"
    assert world.datacite.dois[DOI_NAME] == {"url": "https://other.example/datasets/stream/v1"}
    assert world.datacite.puts() == []
    [alert] = world.sns.messages
    assert DOI_NAME in alert["Message"] and "https://other.example/" in alert["Message"]
    manifest = _manifest(world, "open/stream/1/datapackage.json")
    assert manifest["archive:identifier"] == f"https://{DOMAIN}/datasets/stream/v1"


META = ("DATASET#stream", "META")


def _two_versions_claimed(world: World) -> dict[str, Any]:
    """`stream` live at version 1 by sub-a, and version 2 claimed by sub-b; sub-b's target."""
    world.hold("sub-a", _package(), datasetId="stream")
    world.publish("sub-a")
    world.hold("sub-b", _package(), datasetId="stream", newVersion=True)
    return world.version("sub-b")


def test_the_claim_leaves_current_version_alone(world: World) -> None:
    _two_versions_claimed(world)

    meta = world.table()[META]
    assert meta["currentVersion"] == {"N": "1"} and meta["claimedBy"] == {"S": "sub-b"}
    assert ("DATASET#stream", "V#000002") not in world.table()


def test_the_dataset_reads_as_version_1_while_version_2_is_being_published(world: World) -> None:
    _two_versions_claimed(world)

    status, body = world.read("/api/datasets/stream")

    assert status == 200
    assert (body["currentVersion"], body["manifest"]["version"]) == (1, "1")


def test_a_first_version_claim_is_an_item_with_no_current_version(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")

    world.version(SID)

    assert set(world.table()[META]) == {"PK", "SK", "claimedBy"}


def test_a_publish_that_fails_after_the_claim_leaves_the_live_dataset_as_it_was(
    world: World,
) -> None:
    world.hold("sub-a", _package(), datasetId="stream")
    world.publish("sub-a")
    before = copy.deepcopy(world.table())
    world.hold("sub-b", _package(), datasetId="stream", newVersion=True)
    world.s3.fail_copy = lambda bucket, key: (bucket, key) == (ARCHIVE, "open/stream/2/README.md")

    with pytest.raises(RuntimeError):
        world.publish("sub-b")
    world.fail("sub-b", "copy refused")

    assert world.table() == before
    assert world.submissions.items["sub-b"]["status"] == "failed"
    assert [e["type"] for e in world.reviews.events] == ["published", "failed"]
    [alert] = world.sns.messages
    assert "sub-b" in alert["Subject"]


def test_a_failed_first_version_leaves_no_dataset_item(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")
    world.version(SID)

    world.fail(SID, "boom")

    assert META not in world.table()


def test_a_later_publish_takes_over_the_claim_of_a_failed_submission(world: World) -> None:
    _two_versions_claimed(world)
    world.submissions.items["sub-b"]["status"] = "failed"  # failed, and its release never ran
    world.hold("sub-c", _package(), datasetId="stream", newVersion=True)

    world.publish("sub-c")

    meta = world.table()[META]
    assert meta["currentVersion"] == {"N": "2"} and "claimedBy" not in meta
    assert world.submissions.items["sub-c"]["status"] == "published"


def test_a_claim_held_by_a_running_publish_is_not_taken_over(world: World) -> None:
    _two_versions_claimed(world)
    world.hold("sub-c", _package(), datasetId="stream", newVersion=True)

    with pytest.raises(ingest.PublishConflict, match="is being published by submission sub-b"):
        world.publish("sub-c")

    assert world.table()[META]["claimedBy"] == {"S": "sub-b"}


def test_the_catalog_step_refuses_when_its_claim_was_taken(world: World) -> None:
    target = _two_versions_claimed(world)
    world.s3.objects[(ARCHIVE, "open/stream/2/datapackage.json")] = world.s3.objects[
        (ARCHIVE, "open/stream/1/datapackage.json")
    ]
    world.table()[META]["claimedBy"] = {"S": "sub-x"}

    with pytest.raises(ingest.PublishConflict, match="the claim on dataset stream was lost"):
        world.catalog("sub-b", target)

    meta = world.table()[META]
    assert meta["currentVersion"] == {"N": "1"} and meta["claimedBy"] == {"S": "sub-x"}


def test_the_doi_paths_second_catalog_run_keeps_a_later_claim(world: World) -> None:
    _two_versions_claimed(world)

    world.catalog("sub-a", {"datasetId": "stream", "version": 1, "table": "catalog-b"})

    meta = world.table()[META]
    assert meta["currentVersion"] == {"N": "1"} and meta["claimedBy"] == {"S": "sub-b"}


def test_a_withdrawal_during_the_publish_is_kept_when_the_version_goes_live(world: World) -> None:
    withdrawn = {"S": json.dumps({"at": "2026-11-13T00:00:00Z", "by": "admin-1", "reason": "x"})}
    target = _two_versions_claimed(world)
    world.s3.objects[(ARCHIVE, "open/stream/2/datapackage.json")] = world.s3.objects[
        (ARCHIVE, "open/stream/1/datapackage.json")
    ]
    # The withdrawal lands after the catalog step read the dataset item and before its put.
    world.dynamodb.before_put = lambda: world.table()[META].update(withdrawn=withdrawn)

    world.catalog("sub-b", target)

    meta = world.table()[META]
    assert meta["currentVersion"] == {"N": "2"} and "claimedBy" not in meta
    assert json.loads(meta["withdrawn"]["S"]) == json.loads(withdrawn["S"])


def _fail_the_catalog_put(world: World) -> None:
    def refuse() -> None:
        raise RuntimeError("the dataset item's put was refused")

    world.dynamodb.before_put = refuse


def test_a_catalog_step_that_fails_leaves_nothing_of_the_version_in_the_catalog(
    world: World,
) -> None:
    world.hold("sub-a", _package(), datasetId="stream")
    world.publish("sub-a")
    before = copy.deepcopy(world.table())
    world.hold("sub-b", _package(), datasetId="stream", newVersion=True)
    _fail_the_catalog_put(world)

    with pytest.raises(RuntimeError):
        world.publish("sub-b")
    # The version and file items were written before the dataset item's put failed.
    assert ("DATASET#stream", "V#000002") in world.table()
    world.fail("sub-b", "put refused")

    assert world.table() == before
    assert world.read("/api/datasets/stream/versions")[1] == {
        "versions": [{"version": 1, "prefix": "open", "publishedAt": "2026-11-14T09:30:00Z"}]
    }
    assert world.read("/api/datasets/stream/versions/2")[0] == 404
    link = "/api/datasets/stream/versions/2/download"
    assert world.read(link, {"path": "data/logger.csv"})[0] == 404
    link = "/api/datasets/stream/versions/1/download"
    assert world.read(link, {"path": "data/logger.csv"})[0] == 200


def test_a_takeover_publishes_a_version_holding_only_its_own_files(world: World) -> None:
    world.hold("sub-a", _package(), datasetId="stream")
    world.publish("sub-a")
    left = _package()
    left["data/extra.csv"] = b"a,b\n1,2\n"
    extra = hashlib.sha256(left["data/extra.csv"]).hexdigest()
    left["checksums.sha256"] += f"{extra}  data/extra.csv\n".encode()
    world.hold("sub-b", left, datasetId="stream", newVersion=True)
    _fail_the_catalog_put(world)
    with pytest.raises(RuntimeError):
        world.publish("sub-b")
    world.table()[("DATASET#stream", "V#000002#FILE#data/extra.csv")] = {
        "PK": {"S": "DATASET#stream"},
        "SK": {"S": "V#000002#FILE#data/extra.csv"},
        "path": {"S": "data/extra.csv"},
    }
    world.submissions.items["sub-b"]["status"] = "failed"  # failed, and its release never ran
    world.hold("sub-c", _package(), datasetId="stream", newVersion=True)

    world.publish("sub-c")

    assert ("DATASET#stream", "V#000002#FILE#data/extra.csv") not in world.table()
    stored = [k for k in world.s3.keys(ARCHIVE, "open/stream/2/") if "/_zips/" not in k]
    assert stored == sorted("open/stream/2/" + p for p in _package())


def test_a_publish_that_fails_after_the_copy_hides_the_folder_it_copied(world: World) -> None:
    world.hold("sub-a", _package(), datasetId="stream")
    world.publish("sub-a")
    first = world.s3.keys(ARCHIVE, "open/stream/1/")
    world.hold("sub-b", _package(), datasetId="stream", newVersion=True)
    _fail_the_catalog_put(world)
    with pytest.raises(RuntimeError):
        world.publish("sub-b")
    assert "open/stream/2/datapackage.json" in reindex.manifest_keys(cast(Any, world.s3), ARCHIVE)

    world.fail("sub-b", "put refused")

    assert reindex.manifest_keys(cast(Any, world.s3), ARCHIVE) == ["open/stream/1/datapackage.json"]
    assert world.s3.keys(ARCHIVE, "open/stream/2/") == []
    assert world.s3.keys(ARCHIVE, "open/stream/1/") == first


def test_a_failure_of_a_submission_that_holds_no_claim_deletes_nothing(world: World) -> None:
    _two_versions_claimed(world)
    world.hold("sub-c", _package(), datasetId="stream", newVersion=True)
    world.s3.objects[(ARCHIVE, "open/stream/2/datapackage.json")] = b"{}"
    table, stored = copy.deepcopy(world.table()), world.s3.keys(ARCHIVE)

    world.fail("sub-c", "boom")
    world.fail("sub-a", "boom")  # its version is live

    assert world.table() == table
    assert world.s3.keys(ARCHIVE) == stored
