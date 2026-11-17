"""The sitemap: `site/sitemap.xml`, served at `/sitemap.xml`, which `robots.txt` names.

One `<url>` per published dataset that isn't withdrawn: its latest version's page, with
`lastmod` from that version's publish or its latest correction, whichever is later. Publish,
the lifecycle (withdraw, restore) and the reindex rewrite it from a catalog table.
"""

from __future__ import annotations

import json
from html import escape
from typing import Any

from archive_backend.catalog_file import DynamoDB, _scan
from archive_backend.pages import identifier

KEY = "site/sitemap.xml"


def _lastmod(version: dict[str, Any]) -> str | None:
    """The version's publish time or its latest correction, as UTC to the second."""
    times = []
    published = version.get("publishedAt", {}).get("S")
    if published:
        times.append(published)
    manifest = json.loads(version.get("manifest", {}).get("S") or "{}")
    for edit in manifest.get("archive:metadataHistory") or []:
        when = edit.get("when") if isinstance(edit, dict) else None
        if isinstance(when, str):
            times.append(when)
    return max(times) if times else None


def sitemap_xml(items: list[dict[str, Any]], domain: str) -> str:
    """The sitemap of the datasets in a catalog table's items."""
    by_dataset: dict[str, dict[str, dict[str, Any]]] = {}
    for item in items:
        by_dataset.setdefault(item["PK"]["S"], {})[item["SK"]["S"]] = item
    urls: list[str] = []
    for pk, dataset in sorted(by_dataset.items()):
        meta = dataset.get("META")
        if meta is None or "withdrawn" in meta or "currentVersion" not in meta:
            continue
        current = int(meta["currentVersion"]["N"])
        version = dataset.get(f"V#{current:06d}")
        if version is None:
            continue
        loc = identifier(domain, pk.removeprefix("DATASET#"), current)
        lastmod = _lastmod(version)
        entry = f"<url><loc>{escape(loc)}</loc>"
        if lastmod:
            entry += f"<lastmod>{escape(lastmod)}</lastmod>"
        urls.append(entry + "</url>")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"{url}\n" for url in urls)
        + "</urlset>\n"
    )


def write_sitemap(table: str, derived: str, domain: str, *, dynamodb: DynamoDB, s3: Any) -> int:
    """Write `site/sitemap.xml` from the catalog table; how many datasets it lists."""
    xml = sitemap_xml(_scan(dynamodb, table), domain)
    s3.put_object(
        Bucket=derived,
        Key=KEY,
        Body=xml.encode("utf-8"),
        ContentType="application/xml",
        CacheControl="max-age=300",
    )
    return xml.count("<url>")
