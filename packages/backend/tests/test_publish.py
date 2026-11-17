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

from archive_backend import doi, ingest, pages, reindex, submissions
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

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def put_object(self, *, Bucket: str, Key: str, Body: Any, **extra: Any) -> dict[str, Any]:
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

    def get_item(self, *, TableName: str, Key: dict[str, Any]) -> dict[str, Any]:
        # A stale snapshot answers one read, as a publish that read before another wrote.
        tables, self.stale = self.stale or self.tables, None
        item = tables[TableName].get((Key["PK"]["S"], Key["SK"]["S"]))
        return {"Item": item} if item else {}

    def update_item(
        self,
        *,
        TableName: str,
        Key: dict[str, Any],
        UpdateExpression: str,
        ConditionExpression: str,
        ExpressionAttributeValues: dict[str, Any],
    ) -> dict[str, Any]:
        """Only the `SET a = :x, ...` updates, under `attribute_not_exists(PK)` or `a = :x`."""
        key = (Key["PK"]["S"], Key["SK"]["S"])
        self.writes.append(("update", key[0]))
        current = self.tables[TableName].get(key)
        if ConditionExpression == "attribute_not_exists(PK)":
            holds = current is None
        else:
            name, value = (part.strip() for part in ConditionExpression.split("="))
            holds = current is not None and current.get(name) == ExpressionAttributeValues[value]
        if not holds:
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException", "Message": "no"}},
                "UpdateItem",
            )
        item = current if current is not None else dict(Key)
        assert UpdateExpression.startswith("SET ")
        for assignment in UpdateExpression[4:].split(","):
            name, value = (part.strip() for part in assignment.split("="))
            item[name] = ExpressionAttributeValues[value]
        self.tables[TableName][key] = item
        return {}

    def batch_write_item(self, *, RequestItems: dict[str, Any]) -> dict[str, Any]:
        for table, requests in RequestItems.items():
            assert len(requests) <= 25
            for request in requests:
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


def test_every_put_carries_its_checksum_and_the_manifest_goes_last(world: World) -> None:
    world.hold(SID, _package(), datasetId="stream")

    world.publish()

    puts = [p for p in world.s3.puts if p["Bucket"] == ARCHIVE]
    files = [p for p in puts if "/_zips/" not in p["Key"]]
    assert len(files) == len(_package())
    assert all(p.get("ChecksumSHA256") for p in puts)
    assert files[-1]["Key"] == "open/stream/1/datapackage.json"


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
    assert world.table()[(f"DATASET#{first['datasetId']}", "META")]["claimedBy"] == {"S": SID}
    world.publish()
    meta = world.table()[(f"DATASET#{first['datasetId']}", "META")]
    assert meta["currentVersion"] == {"N": "1"} and "claimedBy" not in meta


def test_the_page_step_writes_the_versions_zips_beside_it(world: World) -> None:
    world.hold(SID, _package(**{"archive:access": "limited"}), datasetId="secret")

    world.publish()

    root = "restricted/secret/1/"
    zips = world.s3.keys(ARCHIVE, root + "_zips/")
    assert zips == [
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
        for part in ("version", "fill", "copy", "catalog", "page", "catalog-file", "sitemap")
        + ("finish",)
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
