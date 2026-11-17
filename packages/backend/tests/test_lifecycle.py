import base64
import hashlib
import io
import json
import logging
import re
from collections.abc import Iterator
from datetime import date
from typing import Any

import pytest
from botocore.exceptions import ClientError

from archive_backend import doi, lifecycle
from archive_backend.doi import DataCiteError
from archive_backend.reindex import catalog_items, dataset_item
from datacite_fake import FakeDataCite

ARCHIVE = "archive"
DERIVED = "derived"
TABLE_A = "catalog-a"
TABLE_B = "catalog-b"
PARAMETER = "/research-archive/test/catalog-active"
CONFIG_PARAMETER = "/research-archive/test/archive-config"
DOMAIN = "d111.cloudfront.net"
DISTRIBUTION = "E123"
TODAY = date(2026, 11, 20)
WITHDRAWN = {"at": "2026-11-20T10:00:00Z", "by": "admin-1", "reason": "Consent ended."}


def _b64(body: bytes) -> str:
    return base64.b64encode(hashlib.sha256(body).digest()).decode()


class FakeS3:
    """Objects with their stored full SHA-256; a copy into `corrupt` stores the wrong bytes."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.corrupt: set[str] = set()
        self.copies: list[str] = []
        self.puts: list[str] = []

    def put(self, bucket: str, key: str, body: bytes) -> None:
        self.objects[(bucket, key)] = (body, _b64(body))

    def keys(self, bucket: str, prefix: str = "") -> list[str]:
        return sorted(k for b, k in self.objects if b == bucket and k.startswith(prefix))

    def body(self, bucket: str, key: str) -> bytes:
        return self.objects[(bucket, key)][0]

    def get_paginator(self, name: str) -> "FakeS3":
        assert name == "list_objects_v2"
        return self

    def paginate(self, *, Bucket: str, Prefix: str) -> Iterator[dict[str, Any]]:
        keys = self.keys(Bucket, Prefix)
        for start in range(0, len(keys), 2):
            yield {"Contents": [{"Key": k} for k in keys[start : start + 2]]}

    def list_objects_v2(self, *, Bucket: str, Prefix: str, MaxKeys: int) -> dict[str, Any]:
        keys = self.keys(Bucket, Prefix)[:MaxKeys]
        return {"KeyCount": len(keys), "Contents": [{"Key": k} for k in keys]}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)][0])}

    def head_object(self, *, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ChecksumSHA256": self.objects[(Bucket, Key)][1]}

    def put_object(self, *, Bucket: str, Key: str, Body: Any, **kwargs: Any) -> dict[str, Any]:
        body = Body.encode() if isinstance(Body, str) else Body
        self.objects[(Bucket, Key)] = (body, kwargs.get("ChecksumSHA256") or _b64(body))
        self.puts.append(Key)
        return {}

    def copy_object(
        self, *, Bucket: str, Key: str, CopySource: dict[str, str], ChecksumAlgorithm: str, **_: Any
    ) -> dict[str, Any]:
        assert ChecksumAlgorithm == "SHA256"
        body = self.objects[(CopySource["Bucket"], CopySource["Key"])][0]
        if Key in self.corrupt:
            body = body + b"!"
        self.objects[(Bucket, Key)] = (body, _b64(body))
        self.copies.append(Key)
        return {"CopyObjectResult": {"ChecksumSHA256": _b64(body)}}

    def delete_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.objects.pop((Bucket, Key), None)
        return {}


def _value(token: str, values: dict[str, Any]) -> Any:
    return values[token.strip()]


class FakeDynamoDB:
    def __init__(self) -> None:
        self.tables: dict[str, dict[tuple[str, str], dict[str, Any]]] = {TABLE_A: {}, TABLE_B: {}}

    def load(self, table: str, items: list[dict[str, Any]]) -> None:
        for item in items:
            self.tables[table][(item["PK"]["S"], item["SK"]["S"])] = item

    def get_item(self, *, TableName: str, Key: dict[str, Any], **_: Any) -> dict[str, Any]:
        item = self.tables[TableName].get((Key["PK"]["S"], Key["SK"]["S"]))
        return {"Item": item} if item else {}

    def query(self, **kwargs: Any) -> dict[str, Any]:
        pk = kwargs["ExpressionAttributeValues"][":pk"]
        rows = [i for _, i in sorted(self.tables[kwargs["TableName"]].items()) if i["PK"] == pk]
        start = kwargs.get("ExclusiveStartKey", {}).get("n", 0)
        page: dict[str, Any] = {"Items": rows[start : start + 2]}
        if start + 2 < len(rows):
            page["LastEvaluatedKey"] = {"n": start + 2}
        return page

    def scan(self, **kwargs: Any) -> dict[str, Any]:
        rows = [i for _, i in sorted(self.tables[kwargs["TableName"]].items())]
        if "FilterExpression" in kwargs:
            assert kwargs["FilterExpression"] == "SK = :meta OR attribute_exists(#v)"
            assert kwargs["ExpressionAttributeNames"] == {"#v": "version"}
            rows = [r for r in rows if r["SK"] == {"S": "META"} or "version" in r]
        return {"Items": rows}

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        """`SET #a = :a, ...` and `REMOVE #b`, by names and values."""
        key = kwargs["Key"]
        item = self.tables[kwargs["TableName"]][(key["PK"]["S"], key["SK"]["S"])]
        names = kwargs.get("ExpressionAttributeNames", {})
        values = kwargs.get("ExpressionAttributeValues", {})
        for clause in re.findall(r"(SET|REMOVE) ([^A-Z]+)", kwargs["UpdateExpression"]):
            verb, body = clause
            for part in body.split(","):
                if verb == "SET":
                    name, value = part.split("=")
                    item[names.get(name.strip(), name.strip())] = _value(value, values)
                else:
                    item.pop(names.get(part.strip(), part.strip()), None)
        return {}


class FakeSSM:
    def __init__(self) -> None:
        self.config: dict[str, Any] = {"publisher": "P"}

    def get_parameter(self, *, Name: str) -> dict[str, Any]:
        if Name == CONFIG_PARAMETER:
            return {"Parameter": {"Value": json.dumps(self.config)}}
        assert Name == PARAMETER
        return {"Parameter": {"Value": "B"}}


class FakeCloudFront:
    def __init__(self) -> None:
        self.invalidations: list[dict[str, Any]] = []

    def create_invalidation(self, **kwargs: Any) -> dict[str, Any]:
        self.invalidations.append(kwargs)
        return {}


class World:
    def __init__(self) -> None:
        self.s3 = FakeS3()
        self.dynamodb = FakeDynamoDB()
        self.cloudfront = FakeCloudFront()
        self.ssm = FakeSSM()
        self.clients = lifecycle.Clients(
            s3=self.s3,  # type: ignore[arg-type]
            dynamodb=self.dynamodb,  # type: ignore[arg-type]
            ssm=self.ssm,  # type: ignore[arg-type]
            cloudfront=self.cloudfront,
        )
        self.env = lifecycle.Env(
            archive_bucket=ARCHIVE,
            derived_bucket=DERIVED,
            catalog_table_a=TABLE_A,
            catalog_table_b=TABLE_B,
            active_catalog_parameter=PARAMETER,
            archive_config_parameter=CONFIG_PARAMETER,
            site_domain=DOMAIN,
            distribution_id=DISTRIBUTION,
        )

    def publish(
        self, dataset_id: str, prefix: str, versions: int = 1, extra: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        manifest: dict[str, Any] = {}
        for version in range(1, versions + 1):
            manifest = self.add_version(dataset_id, prefix, version, extra)
        return manifest

    def add_version(
        self, dataset_id: str, prefix: str, version: int, extra: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Version `version` of the dataset under `prefix`, which becomes its current one."""
        manifest = {
            "id": dataset_id,
            "title": f"Title of {dataset_id}",
            "resources": [{"name": "data", "path": "data/a.csv", "format": "csv"}],
            **(extra or {}),
        }
        root = f"{prefix}/{dataset_id}/{version}/"
        text = json.dumps(manifest)
        files = {"datapackage.json": text.encode(), "data/a.csv": f"a\n{version}\n".encode()}
        sums = "".join(
            f"{hashlib.sha256(body).hexdigest()}  {path}\n" for path, body in files.items()
        )
        for path, body in files.items():
            self.s3.put(ARCHIVE, root + path, body)
        self.s3.put(ARCHIVE, root + "checksums.sha256", sums.encode())
        items = catalog_items(prefix, dataset_id, version, text)
        items.append(dataset_item(dataset_id, [(prefix, version, manifest)]))
        self.dynamodb.load(TABLE_B, items)
        return manifest

    def version(self, dataset_id: str, version: int) -> dict[str, Any]:
        return self.dynamodb.tables[TABLE_B][(f"DATASET#{dataset_id}", f"V#{version:06d}")]

    def meta(self, dataset_id: str) -> dict[str, Any]:
        return self.dynamodb.tables[TABLE_B][(f"DATASET#{dataset_id}", "META")]

    def withdraw(self, dataset_id: str) -> None:
        self.meta(dataset_id)["withdrawn"] = {"S": json.dumps(WITHDRAWN)}

    def sync(self, dataset_id: str, today: date = TODAY) -> dict[str, Any]:
        return lifecycle.sync(self.clients, self.env, dataset_id, today)

    def page(self, dataset_id: str, version: int | None = None) -> str:
        key = f"site/datasets/{dataset_id}/" + (f"v{version}/" if version else "") + "index.html"
        return self.s3.body(DERIVED, key).decode()

    def catalog(self) -> list[str]:
        return [row["id"] for row in json.loads(self.s3.body(DERIVED, "site/catalog.json"))]


@pytest.fixture
def world() -> World:
    return World()


def test_a_withdrawal_moves_every_versions_files_out_of_open(world: World) -> None:
    world.publish("ds", "open", versions=2)
    world.publish("other", "open")
    before = {k: world.s3.body(ARCHIVE, k) for k in world.s3.keys(ARCHIVE, "open/ds/")}
    world.withdraw("ds")

    result = world.sync("ds")

    assert world.s3.keys(ARCHIVE, "open/ds/") == []
    after = {
        k.replace("restricted/", "open/", 1): world.s3.body(ARCHIVE, k)
        for k in world.s3.keys(ARCHIVE, "restricted/ds/")
    }
    assert after == before
    assert result["moved"] == 6
    assert world.meta("ds")["prefix"] == {"S": "restricted"}
    for version in (1, 2):
        item = world.dynamodb.tables[TABLE_B][("DATASET#ds", f"V#{version:06d}")]
        assert item["prefix"] == {"S": "restricted"}
    assert world.s3.keys(ARCHIVE, "open/other/")


def test_a_withdrawal_invalidates_the_datasets_data_and_rewrites_pages_and_catalog(
    world: World,
) -> None:
    world.publish("ds", "open", versions=2)
    world.publish("other", "open")
    world.withdraw("ds")

    world.sync("ds")

    [invalidation] = world.cloudfront.invalidations
    assert invalidation["DistributionId"] == DISTRIBUTION
    assert invalidation["InvalidationBatch"]["Paths"] == {"Quantity": 1, "Items": ["/ds/*"]}
    for version in (None, 1, 2):
        page = world.page("ds", version)
        assert "Consent ended." in page
        assert "/data/ds/" not in page
    assert world.catalog() == ["other"]
    sitemap = world.s3.body(DERIVED, "site/sitemap.xml").decode()
    assert "/datasets/other/v1" in sitemap and "/datasets/ds/" not in sitemap


def test_a_restore_moves_the_files_back_and_lists_the_dataset_again(world: World) -> None:
    world.publish("ds", "open")
    world.withdraw("ds")
    world.sync("ds")
    del world.meta("ds")["withdrawn"]
    world.cloudfront.invalidations.clear()

    world.sync("ds")

    assert world.s3.keys(ARCHIVE, "restricted/ds/") == []
    assert world.s3.keys(ARCHIVE, "open/ds/1/") == [
        "open/ds/1/checksums.sha256",
        "open/ds/1/data/a.csv",
        "open/ds/1/datapackage.json",
    ]
    assert world.meta("ds")["prefix"] == {"S": "open"}
    assert len(world.cloudfront.invalidations) == 1
    assert f"https://{DOMAIN}/data/ds/1/data/a.csv" in world.page("ds")
    assert world.catalog() == ["ds"]
    assert "/datasets/ds/v1" in world.s3.body(DERIVED, "site/sitemap.xml").decode()


def test_a_dataset_held_in_restricted_is_invalidated_even_when_nothing_moved(
    world: World,
) -> None:
    world.publish("ds", "restricted", extra={"archive:access": "restricted"})
    world.withdraw("ds")

    result = world.sync("ds")

    assert result["moved"] == 0
    assert world.s3.copies == []
    # A retry after a run that moved files and then failed moves nothing, but must invalidate.
    assert len(world.cloudfront.invalidations) == 1
    assert "Consent ended." in world.page("ds")


def test_a_copy_that_differs_from_its_checksum_keeps_the_source_and_fails_the_run(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    world.publish("ds", "open")
    world.withdraw("ds")
    world.s3.corrupt.add("restricted/ds/1/data/a.csv")

    with caplog.at_level(logging.ERROR), pytest.raises(lifecycle.MoveFailed):
        world.sync("ds")

    assert world.s3.keys(ARCHIVE, "open/ds/") == ["open/ds/1/data/a.csv"]
    assert "open/ds/1/data/a.csv" in caplog.text
    # The files that did move left open/, so the edges must drop them even though the run failed.
    [invalidation] = world.cloudfront.invalidations
    assert invalidation["InvalidationBatch"]["Paths"]["Items"] == ["/ds/*"]

    world.s3.corrupt.clear()
    world.s3.copies.clear()
    world.sync("ds")

    assert world.s3.copies == ["restricted/ds/1/data/a.csv"]
    assert world.s3.keys(ARCHIVE, "open/ds/") == []
    assert world.meta("ds")["prefix"] == {"S": "restricted"}


def test_a_file_already_in_place_is_not_copied_again(world: World) -> None:
    world.publish("ds", "open")
    world.withdraw("ds")
    # A run that copied the manifest but failed before deleting its source.
    body = world.s3.body(ARCHIVE, "open/ds/1/datapackage.json")
    world.s3.put(ARCHIVE, "restricted/ds/1/datapackage.json", body)

    world.sync("ds")

    assert "restricted/ds/1/datapackage.json" not in world.s3.copies
    assert world.s3.keys(ARCHIVE, "open/ds/") == []


def test_an_unknown_dataset_does_nothing(world: World) -> None:
    assert world.sync("nope") == {"datasetId": "nope", "moved": 0, "pages": 0}


def test_an_embargo_moved_later_holds_public_files_again(world: World) -> None:
    world.publish("ds", "open", extra={"archive:embargoUntil": "2026-12-01"})

    world.sync("ds")

    assert world.s3.keys(ARCHIVE, "open/ds/") == []
    assert world.meta("ds")["prefix"] == {"S": "restricted"}
    assert "Files available from 2026-12-01" in world.page("ds")


def test_the_daily_release_opens_only_the_public_embargoes_that_have_ended(world: World) -> None:
    ended = {"archive:embargoUntil": "2026-11-20"}
    world.publish("due", "restricted", extra=ended)
    world.publish("later", "restricted", extra={"archive:embargoUntil": "2026-11-21"})
    world.publish("limited", "restricted", extra=ended | {"archive:access": "limited"})
    world.publish("gone", "restricted", extra=ended)
    world.withdraw("gone")
    world.publish("free", "open")

    released = lifecycle.release(world.clients, world.env, TODAY)

    assert released == ["due"]
    assert world.s3.keys(ARCHIVE, "open/due/")
    assert world.s3.keys(ARCHIVE, "restricted/due/") == []
    assert world.meta("due")["prefix"] == {"S": "open"}
    assert f"https://{DOMAIN}/data/due/1/data/a.csv" in world.page("due")
    for held in ("later", "limited", "gone"):
        assert world.s3.keys(ARCHIVE, f"open/{held}/") == []
    assert lifecycle.release(world.clients, world.env, TODAY) == []


def test_the_handler_releases_on_the_schedule_and_syncs_on_a_dataset(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[Any] = []
    monkeypatch.setattr(lifecycle, "clients", lambda: world.clients)
    monkeypatch.setattr(lifecycle.Env, "from_environ", classmethod(lambda cls: world.env))
    monkeypatch.setattr(lifecycle, "_today", lambda: TODAY)

    def release(c: Any, env: Any, today: date) -> list[str]:
        calls.append(("release", today))
        return []

    def sync(c: Any, env: Any, dataset_id: str, today: date) -> dict[str, Any]:
        calls.append(("sync", dataset_id))
        return {}

    monkeypatch.setattr(lifecycle, "release", release)
    monkeypatch.setattr(lifecycle, "sync", sync)

    lifecycle.handler({}, None)
    lifecycle.handler({"datasetId": "ds"}, None)

    assert calls == [("release", TODAY), ("sync", "ds")]


def test_a_restricted_older_version_stays_restricted_beside_a_public_current_one(
    world: World,
) -> None:
    world.add_version("ds", "restricted", 1, {"archive:access": "restricted"})
    world.add_version("ds", "open", 2)

    world.sync("ds")

    assert world.s3.keys(ARCHIVE, "open/ds/1/") == []
    assert world.s3.keys(ARCHIVE, "restricted/ds/1/")
    assert world.s3.keys(ARCHIVE, "open/ds/2/")
    assert world.version("ds", 1)["prefix"] == {"S": "restricted"}
    assert world.version("ds", 2)["prefix"] == {"S": "open"}
    assert world.meta("ds")["prefix"] == {"S": "open"}
    # A restricted version means /data/ may still cache files that are not meant for anyone.
    assert len(world.cloudfront.invalidations) == 1


def test_an_older_version_with_its_own_later_embargo_is_held_beside_a_public_current_one(
    world: World,
) -> None:
    world.add_version("ds", "open", 1, {"archive:embargoUntil": "2026-12-01"})
    world.add_version("ds", "open", 2)

    world.sync("ds")

    assert world.s3.keys(ARCHIVE, "open/ds/1/") == []
    assert world.s3.keys(ARCHIVE, "restricted/ds/1/")
    assert world.s3.keys(ARCHIVE, "open/ds/2/")
    assert world.version("ds", 1)["prefix"] == {"S": "restricted"}
    assert world.version("ds", 2)["prefix"] == {"S": "open"}


def test_the_daily_run_releases_an_older_versions_own_embargo(world: World) -> None:
    world.add_version("ds", "restricted", 1, {"archive:embargoUntil": "2026-11-20"})
    world.add_version("ds", "open", 2)

    assert lifecycle.release(world.clients, world.env, TODAY) == ["ds"]

    assert world.s3.keys(ARCHIVE, "restricted/ds/") == []
    assert world.version("ds", 1)["prefix"] == {"S": "open"}
    assert lifecycle.release(world.clients, world.env, TODAY) == []


def test_the_daily_run_finishes_a_withdrawal_whose_runs_all_failed(world: World) -> None:
    world.publish("ds", "open")
    world.withdraw("ds")
    world.s3.corrupt.add("restricted/ds/1/data/a.csv")
    with pytest.raises(lifecycle.MoveFailed):
        world.sync("ds")
    world.s3.corrupt.clear()

    assert lifecycle.release(world.clients, world.env, TODAY) == ["ds"]

    assert world.s3.keys(ARCHIVE, "open/ds/") == []
    assert world.meta("ds")["prefix"] == {"S": "restricted"}


def test_the_daily_run_clears_files_left_in_open_for_a_withdrawn_dataset(world: World) -> None:
    world.publish("ds", "open")
    world.withdraw("ds")
    world.sync("ds")
    # A correction that raced the withdrawal wrote its metadata back into open/.
    world.s3.put(ARCHIVE, "open/ds/1/README.md", b"# late\n")

    assert lifecycle.release(world.clients, world.env, TODAY) == ["ds"]

    assert world.s3.keys(ARCHIVE, "open/ds/") == []
    assert "restricted/ds/1/README.md" in world.s3.keys(ARCHIVE, "restricted/ds/")


def test_the_daily_run_holds_public_files_whose_embargo_moved_later(world: World) -> None:
    world.publish("ds", "open")
    world.meta("ds")["embargoUntil"] = {"S": "2026-12-01"}

    assert lifecycle.release(world.clients, world.env, TODAY) == ["ds"]

    assert world.s3.keys(ARCHIVE, "open/ds/") == []
    assert world.meta("ds")["prefix"] == {"S": "restricted"}


def test_the_daily_run_passes_by_datasets_already_in_place(world: World) -> None:
    world.publish("free", "open")
    world.publish("closed", "restricted", extra={"archive:access": "restricted"})
    world.publish("gone", "restricted")
    world.withdraw("gone")

    assert lifecycle.release(world.clients, world.env, TODAY) == []
    assert world.s3.copies == []


DOI_BLOCK = {"repository": "EXAMPLE.IRC", "prefix": "10.5072", "test": True}
RESOLVER = "https://handle.test.datacite.org/"
CITABLE = {
    "description": "Before.",
    "contributors": [{"title": "Ada Invented", "roles": ["creator"]}],
    "licenses": [{"name": "CC-BY-4.0", "path": "https://creativecommons.org/licenses/by/4.0/"}],
    "archive:published": "2026-11-14T09:30:00Z",
}


@pytest.fixture
def dois(world: World, monkeypatch: pytest.MonkeyPatch) -> FakeDataCite:
    """The DOI module on, a fake DataCite, and the handler on the world's clients."""
    dc = FakeDataCite()
    world.ssm.config["doi"] = DOI_BLOCK
    monkeypatch.setattr(doi, "client", lambda ssm, settings: dc)
    monkeypatch.setattr(lifecycle, "clients", lambda: world.clients)
    monkeypatch.setattr(lifecycle.Env, "from_environ", classmethod(lambda cls: world.env))
    monkeypatch.setattr(lifecycle, "_today", lambda: TODAY)
    return dc


def _with_doi(world: World, dataset_id: str, versions: int, **extra: Any) -> None:
    """Publish the dataset with a DOI on every version, as publish leaves it."""
    for version in range(1, versions + 1):
        name = f"10.5072/example.irc.{dataset_id}.v{version}"
        world.add_version(
            dataset_id, "open", version, {**CITABLE, **extra, "archive:identifier": RESOLVER + name}
        )


def _url(dataset_id: str, version: int) -> str:
    return f"https://{DOMAIN}/datasets/{dataset_id}/v{version}"


def test_a_dois_run_resends_each_versions_record_after_a_correction(
    world: World, dois: FakeDataCite
) -> None:
    _with_doi(world, "ds", 2, description="Corrected.")

    lifecycle.handler({"datasetId": "ds", "dois": True}, None)

    sent = dois.puts()
    assert [name for name, _ in sent] == [
        "10.5072/example.irc.ds.v1",
        "10.5072/example.irc.ds.v2",
    ]
    for version, (_, attributes) in enumerate(sent, start=1):
        assert "event" not in attributes
        assert attributes["url"] == _url("ds", version)
        assert attributes["descriptions"] == [
            {"description": "Corrected.", "descriptionType": "Abstract"}
        ]


def test_a_dois_run_after_a_withdrawal_sends_the_withdrawn_description(
    world: World, dois: FakeDataCite
) -> None:
    _with_doi(world, "ds", 1)
    world.withdraw("ds")

    lifecycle.handler({"datasetId": "ds", "dois": True}, None)

    [(_, attributes)] = dois.puts()
    assert attributes["url"] == _url("ds", 1)
    assert attributes["descriptions"][-1] == {
        "description": "Withdrawn on 2026-11-20: Consent ended.",
        "descriptionType": "Other",
    }
    assert world.s3.keys(ARCHIVE, "open/ds/") == []


def test_a_dois_run_after_a_restore_sends_the_record_without_the_withdrawal(
    world: World, dois: FakeDataCite
) -> None:
    _with_doi(world, "ds", 1)
    world.withdraw("ds")
    lifecycle.handler({"datasetId": "ds", "dois": True}, None)
    del world.meta("ds")["withdrawn"]

    lifecycle.handler({"datasetId": "ds", "dois": True}, None)

    _, attributes = dois.puts()[-1]
    assert not any("Withdrawn" in d["description"] for d in attributes["descriptions"])


def test_a_version_with_no_doi_is_not_sent(world: World, dois: FakeDataCite) -> None:
    world.add_version("ds", "open", 1, CITABLE)
    _with_doi(world, "other", 1)
    world.add_version("ds", "open", 2, {**CITABLE, "archive:identifier": RESOLVER + "10.5072/x"})
    world.add_version(
        "ds", "open", 3, {**CITABLE, "archive:identifier": RESOLVER + "10.5072/example.irc.ds.v3"}
    )

    lifecycle.handler({"datasetId": "ds", "dois": True}, None)

    assert [name for name, _ in dois.puts()] == ["10.5072/x", "10.5072/example.irc.ds.v3"]


def test_a_failing_datacite_raises_after_the_files_and_pages_are_done(
    world: World, dois: FakeDataCite
) -> None:
    _with_doi(world, "ds", 1)
    world.withdraw("ds")
    dois.fail(5)

    with pytest.raises(DataCiteError):
        lifecycle.handler({"datasetId": "ds", "dois": True}, None)

    assert world.s3.keys(ARCHIVE, "open/ds/") == []
    assert world.s3.keys(ARCHIVE, "restricted/ds/1/")
    assert "Consent ended." in world.page("ds")


def test_without_dois_in_the_payload_or_the_config_nothing_is_called(
    world: World, dois: FakeDataCite
) -> None:
    _with_doi(world, "ds", 1)

    lifecycle.handler({"datasetId": "ds"}, None)
    lifecycle.handler({}, None)
    world.ssm.config.pop("doi")
    lifecycle.handler({"datasetId": "ds", "dois": True}, None)

    assert dois.calls == []
