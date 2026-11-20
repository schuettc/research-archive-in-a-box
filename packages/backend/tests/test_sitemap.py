import json
import xml.etree.ElementTree as ET
from typing import Any, cast

from archive_backend.reindex import catalog_items, dataset_item
from archive_backend.sitemap import KEY, sitemap_xml, write_sitemap

DOMAIN = "d111.cloudfront.net"
NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def _items(
    dataset_id: str,
    versions: int = 1,
    withdrawn: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    manifest = {"title": dataset_id, "archive:published": "2026-11-14T09:30:00Z", **(extra or {})}
    items: list[dict[str, Any]] = []
    for version in range(1, versions + 1):
        items += catalog_items("open", dataset_id, version, json.dumps(manifest))
    items.append(dataset_item(dataset_id, [("open", versions, manifest)], withdrawn))
    return items


def _urls(xml: str) -> list[tuple[str, str]]:
    root = ET.fromstring(xml)
    return [
        (
            cast(str, url.findtext("s:loc", namespaces=NS)),
            cast(str, url.findtext("s:lastmod", namespaces=NS)),
        )
        for url in root.findall("s:url", NS)
    ]


def test_the_sitemap_lists_each_datasets_latest_version_page() -> None:
    items = [*_items("a", versions=3), *_items("b")]

    xml = sitemap_xml(items, DOMAIN)

    assert xml.startswith('<?xml version="1.0" encoding="UTF-8"?>')
    assert _urls(xml) == [
        (f"https://{DOMAIN}/datasets/a/v3", "2026-11-14T09:30:00Z"),
        (f"https://{DOMAIN}/datasets/b/v1", "2026-11-14T09:30:00Z"),
    ]


def test_a_withdrawn_dataset_is_left_out() -> None:
    withdrawn = {"at": "2026-11-20T10:00:00Z", "by": "u", "reason": "r"}
    items = [*_items("kept"), *_items("gone", withdrawn=withdrawn)]

    assert [loc for loc, _ in _urls(sitemap_xml(items, DOMAIN))] == [
        f"https://{DOMAIN}/datasets/kept/v1"
    ]


def test_lastmod_is_the_latest_correction_when_there_is_one() -> None:
    history = [
        {"when": "2026-11-18T08:00:00Z", "who": "c", "fields": ["keywords"], "note": "n"},
        {"when": "2026-11-20T08:00:00Z", "who": "c", "fields": ["description"], "note": "n"},
    ]
    items = _items("a", extra={"archive:metadataHistory": history})

    assert _urls(sitemap_xml(items, DOMAIN)) == [
        (f"https://{DOMAIN}/datasets/a/v1", "2026-11-20T08:00:00Z")
    ]


class FakeDynamoDB:
    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = items

    def scan(self, **kwargs: Any) -> dict[str, Any]:
        return {"Items": self.items}


class FakeS3:
    def __init__(self) -> None:
        self.puts: list[dict[str, Any]] = []

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        self.puts.append(kwargs)
        return {}


def test_write_sitemap_puts_site_sitemap_xml() -> None:
    s3 = FakeS3()

    count = write_sitemap("t", "derived", DOMAIN, dynamodb=FakeDynamoDB(_items("a")), s3=s3)

    assert count == 1
    [put] = s3.puts
    assert (put["Bucket"], put["Key"], put["ContentType"]) == (
        "derived",
        KEY,
        "application/xml",
    )
    assert KEY == "site/sitemap.xml"
    assert f"https://{DOMAIN}/datasets/a/v1" in put["Body"].decode()


def test_a_claim_only_item_is_left_out() -> None:
    claim = {"PK": {"S": "DATASET#stream"}, "SK": {"S": "META"}, "claimedBy": {"S": "sub-a"}}

    assert [loc for loc, _ in _urls(sitemap_xml([*_items("kept"), claim], DOMAIN))] == [
        f"https://{DOMAIN}/datasets/kept/v1"
    ]
