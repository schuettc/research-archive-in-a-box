"""The lifecycle function: brings a dataset's files, pages and listings in line with its record.

The curation routes record a change on the dataset item (a withdrawal, a restore, a correction,
an embargo date) and invoke this function asynchronously with `{"datasetId": ...}`, since moving
up to a thousand files can outlast API Gateway's 29 seconds. `sync` works out where each
version's files belong (`open/` only when both the dataset and the version's own manifest are
public, the dataset isn't withdrawn, and neither one's embargo holds it), moves each version's
files there, points the catalog items at their prefix, invalidates `/data/<id>/*` in CloudFront
when anything moved or any version belongs in `restricted/` (even when the run fails), then
rewrites the dataset's pages and the catalog file. Every step is safe to repeat: a move copies,
checks the copy's SHA-256 against the version's `checksums.sha256`, and only then deletes the
source; a failed check leaves the source, logs its key and fails the run, so the async invoke's
retry runs it again, skipping files already in place. The daily schedule invokes it with `{}`
to sync every dataset whose files sit somewhere other than where they belong: an embargo that
has ended, and any run that failed for good.

With the DOI module on, a withdrawal, a restore or a correction invokes it with `"dois": true`:
after the sync it re-sends the DataCite record of every version of the dataset whose
`archive:identifier` is a current DOI address. A DataCite failure raises, so the async invoke's
retries run the sync (which skips work done) and the updates again, and the last failure reaches
the alerts topic. The daily run never calls DataCite.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Protocol, cast

import boto3
from botocore.exceptions import ClientError

from archive_backend import doi, pages
from archive_backend.catalog_file import write_catalog_file
from archive_backend.config import read_archive_config
from archive_backend.reindex import embargo_of, withdrawal_of, write_pages
from archive_backend.sitemap import write_sitemap
from archive_contract.manifest import Manifest

CHECKSUMS = "checksums.sha256"
PREFIXES = ("open", "restricted")
MISSING = ("404", "NoSuchKey", "NotFound")

logger = logging.getLogger(__name__)


class S3(Protocol):
    def get_paginator(self, name: str) -> Any: ...
    def list_objects_v2(self, **kwargs: Any) -> dict[str, Any]: ...
    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def head_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def put_object(self, **kwargs: Any) -> Any: ...
    def copy_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def delete_object(self, **kwargs: Any) -> Any: ...


class DynamoDB(Protocol):
    def get_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def query(self, **kwargs: Any) -> dict[str, Any]: ...
    def scan(self, **kwargs: Any) -> dict[str, Any]: ...
    def update_item(self, **kwargs: Any) -> dict[str, Any]: ...


class SSM(Protocol):
    def get_parameter(self, **kwargs: Any) -> dict[str, Any]: ...


class CloudFront(Protocol):
    def create_invalidation(self, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Clients:
    s3: S3
    dynamodb: DynamoDB
    ssm: SSM
    cloudfront: CloudFront


@dataclass(frozen=True)
class Env:
    archive_bucket: str
    derived_bucket: str
    catalog_table_a: str
    catalog_table_b: str
    active_catalog_parameter: str
    archive_config_parameter: str
    site_domain: str
    distribution_id: str

    @classmethod
    def from_environ(cls) -> Env:
        return cls(
            archive_bucket=os.environ["ARCHIVE_BUCKET"],
            derived_bucket=os.environ["DERIVED_BUCKET"],
            catalog_table_a=os.environ["CATALOG_TABLE_A"],
            catalog_table_b=os.environ["CATALOG_TABLE_B"],
            active_catalog_parameter=os.environ["ACTIVE_CATALOG_PARAMETER"],
            archive_config_parameter=os.environ["ARCHIVE_CONFIG_PARAMETER"],
            site_domain=os.environ["SITE_DOMAIN"],
            distribution_id=os.environ["DISTRIBUTION_ID"],
        )


def clients() -> Clients:
    return Clients(
        s3=cast(S3, boto3.client("s3")),
        dynamodb=cast(DynamoDB, boto3.client("dynamodb")),
        ssm=cast(SSM, boto3.client("ssm")),
        cloudfront=cast(CloudFront, boto3.client("cloudfront")),
    )


class MoveFailed(Exception):
    """A copy's SHA-256 differed from what it should be; its source is kept for the retry."""


def home_prefix(access: str | None, withdrawn: bool, embargo_until: str | None, today: date) -> str:
    """Where a dataset's files belong: `open/`, which CloudFront serves to anyone, only for a
    public dataset that is not withdrawn and whose embargo, if any, has ended (files are
    available on the embargo's day)."""
    held = embargo_until is not None and embargo_until > today.isoformat()
    return "open" if pages.is_public(access) and not withdrawn and not held else "restricted"


def version_home(meta: dict[str, Any], version_item: dict[str, Any], today: date) -> str:
    """Where one version's files belong: held to the stricter of the dataset item and the
    version's own manifest, for its access level and its embargo, so a looser later version
    doesn't open an older one."""
    manifest = json.loads(version_item["manifest"]["S"])
    levels = (meta.get("access", {}).get("S"), manifest.get("archive:access"))
    access = pages.PUBLIC if all(pages.is_public(level) for level in levels) else "restricted"
    dates = [d for d in (meta.get("embargoUntil", {}).get("S"), embargo_of(manifest)) if d]
    return home_prefix(access, withdrawal_of(meta) is not None, max(dates, default=None), today)


def homes(meta: dict[str, Any], items: list[dict[str, Any]], today: date) -> dict[str, str]:
    """Each version's home by its version number as a string, from its version item."""
    return {
        item["version"]["N"]: version_home(meta, item, today)
        for item in items
        if "version" in item and "manifest" in item
    }


def active_table(c: Clients, env: Env) -> str:
    active = c.ssm.get_parameter(Name=env.active_catalog_parameter)["Parameter"]["Value"]
    return env.catalog_table_a if active == "A" else env.catalog_table_b


def dataset_items(c: Clients, table: str, dataset_id: str) -> list[dict[str, Any]]:
    query: dict[str, Any] = {
        "TableName": table,
        "KeyConditionExpression": "PK = :pk",
        "ExpressionAttributeValues": {":pk": {"S": f"DATASET#{dataset_id}"}},
    }
    items: list[dict[str, Any]] = []
    while True:
        page = c.dynamodb.query(**query)
        items.extend(page.get("Items", []))
        last = page.get("LastEvaluatedKey")
        if not last:
            return items
        query["ExclusiveStartKey"] = last


def _keys(c: Clients, bucket: str, prefix: str) -> list[str]:
    keys: list[str] = []
    for page in c.s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        keys.extend(item["Key"] for item in page.get("Contents", []))
    return sorted(keys)


def _listed(c: Clients, bucket: str, roots: tuple[str, ...]) -> dict[str, str]:
    """The version's `checksums.sha256` lines as path to hex digest, from the first root that
    has the file."""
    for root in roots:
        try:
            text = c.s3.get_object(Bucket=bucket, Key=root + CHECKSUMS)["Body"].read()
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") in MISSING:
                continue
            raise
        listed: dict[str, str] = {}
        for line in text.decode("utf-8").splitlines():
            if line.strip():
                digest, path = line.split(maxsplit=1)
                listed[path.lstrip("*")] = digest.lower()
        return listed
    return {}


def _hex(stored: object) -> str | None:
    """An S3 full-object ChecksumSHA256 (base64) as hex, or None when there is none."""
    if not isinstance(stored, str) or "-" in stored:
        return None
    try:
        return base64.b64decode(stored, validate=True).hex()
    except binascii.Error:
        return None


def _stored(c: Clients, bucket: str, key: str) -> str | None:
    try:
        head = c.s3.head_object(Bucket=bucket, Key=key, ChecksumMode="ENABLED")
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in MISSING:
            return None
        raise
    return _hex(head.get("ChecksumSHA256"))


def _move_version(c: Clients, bucket: str, source: str, target: str, keys: list[str]) -> list[str]:
    """Move one version's keys from root `source` to root `target`; the keys that failed."""
    listed = _listed(c, bucket, (source, target))
    failed: list[str] = []
    for key in keys:
        path = key[len(source) :]
        destination = target + path
        # A file the version doesn't list (its checksums file, its zips) keeps its own checksum.
        expected = listed.get(path) or _stored(c, bucket, key)
        if expected is None or _stored(c, bucket, destination) != expected:
            copied = c.s3.copy_object(
                Bucket=bucket,
                Key=destination,
                CopySource={"Bucket": bucket, "Key": key},
                ChecksumAlgorithm="SHA256",
            )
            actual = _hex(copied.get("CopyObjectResult", {}).get("ChecksumSHA256"))
            if expected is not None and actual != expected:
                logger.error(
                    "copy of %s to %s differs from its checksum; source kept", key, destination
                )
                failed.append(key)
                continue
        c.s3.delete_object(Bucket=bucket, Key=key)
    return failed


def move_files(
    c: Clients, env: Env, dataset_id: str, targets: dict[str, str], fallback: str | None
) -> int:
    """Move each version's files of the dataset into its folder in `targets`, by version
    number; a version with no catalog item goes to `fallback`, or stays where it is when that
    is None. How many moved."""
    moved = 0
    failed: list[str] = []
    for prefix in PREFIXES:
        by_version: dict[str, list[str]] = {}
        for key in _keys(c, env.archive_bucket, f"{prefix}/{dataset_id}/"):
            version = key.split("/")[2]
            by_version.setdefault(version, []).append(key)
        for version, keys in sorted(by_version.items()):
            target = targets.get(version, fallback)
            if target is None or target == prefix:
                continue
            source = f"{prefix}/{dataset_id}/{version}/"
            # The checksums file goes last, so a retry can still read it from the source.
            keys.sort(key=lambda k: (k == source + CHECKSUMS, k))
            lost = _move_version(
                c, env.archive_bucket, source, f"{target}/{dataset_id}/{version}/", keys
            )
            failed += lost
            moved += len(keys) - len(lost)
    if failed:
        raise MoveFailed(f"{len(failed)} file(s) of {dataset_id} failed to move: {failed[:10]}")
    return moved


def _set_prefix(c: Clients, table: str, item: dict[str, Any], target: str) -> None:
    if "prefix" in item and item["prefix"] != {"S": target}:
        c.dynamodb.update_item(
            TableName=table,
            Key={"PK": item["PK"], "SK": item["SK"]},
            UpdateExpression="SET #p = :p",
            ExpressionAttributeNames={"#p": "prefix"},
            ExpressionAttributeValues={":p": {"S": target}},
        )
        item["prefix"] = {"S": target}


def _meta_home(meta: dict[str, Any], targets: dict[str, str], today: date) -> str:
    """The dataset item's prefix: its current version's, as a reindex derives it."""
    current = meta.get("currentVersion", {}).get("N")
    if current in targets:
        return targets[current]
    access, embargo = meta.get("access", {}).get("S"), meta.get("embargoUntil", {}).get("S")
    return home_prefix(access, withdrawal_of(meta) is not None, embargo, today)


def invalidate(c: Clients, env: Env, dataset_id: str) -> None:
    """Clear the dataset's cached files. The /data/* behavior's StripData function drops
    `/data` before the cache lookup, so its files are cached under `/<id>/...`."""
    c.cloudfront.create_invalidation(
        DistributionId=env.distribution_id,
        InvalidationBatch={
            "Paths": {"Quantity": 1, "Items": [f"/{dataset_id}/*"]},
            "CallerReference": f"{dataset_id}-{time.time_ns()}",
        },
    )


def rewrite(c: Clients, env: Env, table: str, items: list[dict[str, Any]], today: date) -> int:
    """The dataset's pages from `items`, then the catalog file and the sitemap; how many pages."""
    look = pages.page_brand(read_archive_config(c.ssm, env.archive_config_parameter))
    written = write_pages(cast(Any, c.s3), env.derived_bucket, env.site_domain, look, items, today)
    write_catalog_file(table, env.derived_bucket, dynamodb=c.dynamodb, s3=cast(Any, c.s3))
    write_sitemap(table, env.derived_bucket, env.site_domain, dynamodb=c.dynamodb, s3=c.s3)
    return written


def sync(c: Clients, env: Env, dataset_id: str, today: date) -> dict[str, Any]:
    """Bring the dataset's files, catalog items, pages and listings in line with its record."""
    table = active_table(c, env)
    items = dataset_items(c, table, dataset_id)
    meta = next((item for item in items if item["SK"]["S"] == "META"), None)
    if meta is None:
        logger.warning("no dataset %s in %s; nothing to do", dataset_id, table)
        return {"datasetId": dataset_id, "moved": 0, "pages": 0}
    targets = homes(meta, items, today)
    # Files of a version the catalog doesn't know yet are left alone, unless the dataset is
    # withdrawn: then nothing of it may stay in open/.
    fallback = "restricted" if withdrawal_of(meta) is not None else None
    moved = 0
    try:
        moved = move_files(c, env, dataset_id, targets, fallback)
    finally:
        # A run that moved files out of open/ and then failed still has edges to clear, and so
        # has its retry, which may find nothing left to move.
        if moved or "restricted" in {*targets.values(), fallback}:
            invalidate(c, env, dataset_id)
    for item in items:
        if item["SK"]["S"] == "META":
            _set_prefix(c, table, item, _meta_home(meta, targets, today))
        elif "version" in item and item["version"]["N"] in targets:
            _set_prefix(c, table, item, targets[item["version"]["N"]])
    written = rewrite(c, env, table, items, today)
    return {"datasetId": dataset_id, "moved": moved, "pages": written}


def update_dois(c: Clients, env: Env, dataset_id: str) -> int:
    """Re-send the DataCite record of each of the dataset's versions that has a current DOI,
    with the withdrawal described when it is withdrawn; how many were sent. Nothing with the DOI
    module off."""
    config = read_archive_config(c.ssm, env.archive_config_parameter)
    settings = config.doi
    if settings is None:
        return 0
    items = dataset_items(c, active_table(c, env), dataset_id)
    meta = next((item for item in items if item["SK"]["S"] == "META"), None)
    withdrawn = withdrawal_of(meta)
    versions = sorted(
        (int(item["version"]["N"]), item["manifest"]["S"])
        for item in items
        if "version" in item and "manifest" in item
    )
    dc: doi.DataCite | None = None
    sent = 0
    for version, text in versions:
        identifier = json.loads(text).get("archive:identifier")
        if not doi.is_current(settings, identifier):
            continue
        dc = dc or doi.client(c.ssm, settings)
        doi.update(
            dc,
            settings,
            Manifest.model_validate_json(text),
            publisher=config.publisher,
            doi=doi.name_of(settings, identifier),
            url=pages.identifier(env.site_domain, dataset_id, version),
            withdrawn=withdrawn,
        )
        sent += 1
    return sent


def _today() -> date:
    return datetime.now(UTC).date()


def _drifted(c: Clients, env: Env, items: list[dict[str, Any]], today: date) -> bool:
    """Whether a dataset's files sit somewhere other than where they belong: a version item (or
    the dataset item) whose stored prefix isn't its home, or, for a withdrawn dataset, anything
    at all left under `open/`."""
    meta = next(item for item in items if item["SK"]["S"] == "META")
    targets = homes(meta, items, today)
    for item in items:
        if "version" in item and item.get("prefix", {}).get("S") != targets[item["version"]["N"]]:
            return True
    if meta.get("prefix", {}).get("S") != _meta_home(meta, targets, today):
        return True
    if withdrawal_of(meta) is not None:
        listed = c.s3.list_objects_v2(
            Bucket=env.archive_bucket, Prefix=f"open/{meta['id']['S']}/", MaxKeys=1
        )
        return bool(listed.get("Contents"))
    return False


def release(c: Clients, env: Env, today: date) -> list[str]:
    """The daily run: sync every dataset whose files sit somewhere other than where they
    belong (`_drifted`): an embargo that ended, an embargo moved later, a withdrawal or restore
    whose runs all failed, a file a racing correction wrote back into `open/`. The ids synced.
    Safe to repeat: a synced dataset is in place, so the next run passes it by."""
    table = active_table(c, env)
    scan: dict[str, Any] = {
        "TableName": table,
        "FilterExpression": "SK = :meta OR attribute_exists(#v)",
        "ExpressionAttributeNames": {"#v": "version"},
        "ExpressionAttributeValues": {":meta": {"S": "META"}},
    }
    by_dataset: dict[str, list[dict[str, Any]]] = {}
    while True:
        page = c.dynamodb.scan(**scan)
        for item in page.get("Items", []):
            by_dataset.setdefault(item["PK"]["S"], []).append(item)
        last = page.get("LastEvaluatedKey")
        if not last:
            break
        scan["ExclusiveStartKey"] = last
    due = sorted(
        pk.removeprefix("DATASET#")
        for pk, items in by_dataset.items()
        if any(item["SK"]["S"] == "META" for item in items) and _drifted(c, env, items, today)
    )
    failed: list[str] = []
    for dataset_id in due:
        try:
            sync(c, env, dataset_id, today)
        except MoveFailed:
            logger.exception("syncing %s failed; the next run tries again", dataset_id)
            failed.append(dataset_id)
    return [d for d in due if d not in failed]


def handler(event: dict[str, Any], context: object) -> dict[str, Any]:
    """`{"datasetId": ...}` syncs that dataset, and with `"dois": true` then updates its DOIs'
    DataCite records; a raise makes the async invoke retry the run. The daily schedule's `{}`
    syncs every dataset whose files are out of place."""
    c, env, today = clients(), Env.from_environ(), _today()
    if event.get("datasetId"):
        dataset_id = str(event["datasetId"])
        result = sync(c, env, dataset_id, today)
        if event.get("dois"):
            result["dois"] = update_dois(c, env, dataset_id)
        return result
    return {"released": release(c, env, today)}
