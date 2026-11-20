"""The reindex: rebuild the inactive catalog table from the archive's manifests, then flip to it.

A published version sits at `<open|restricted>/<datasetId>/<version>/` with `datapackage.json`
at its root. The durable handler empties the inactive table, writes every manifest's catalog
items as DynamoDB JSON lines under the derived bucket's `reindex/<run>/data/`, bulk-loads them
into that table, waits for the load to end, and flips the active-catalog parameter only when the
load ends COMPLETED, then rewrites the catalog file, the sitemap and every dataset's page from the
table it flipped to. Every stage is
a checkpointed step, so a replay never repeats one. With the embeddings module on, each dataset
item gets its embedding in the write step, before its line is written.

Started with `{"dois": true}` and the DOI module on, it first registers a DOI for every version of
a dataset that isn't withdrawn whose `archive:identifier` isn't a current DOI address, writing it
into the stored manifest, and re-sends the record of every version that has one; the rebuild then
carries the DOIs everywhere. Versions DataCite refuses are named in one alert.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any, Protocol, cast

import boto3
from aws_durable_execution_sdk_python import (
    DurableContext,
    StepContext,
    durable_execution,
    durable_step,
)
from aws_durable_execution_sdk_python.config import Duration
from aws_durable_execution_sdk_python.waits import (
    WaitForConditionConfig,
    WaitForConditionDecision,
)
from botocore.exceptions import ClientError

from archive_backend import doi, pages, zips
from archive_backend.catalog_file import _scan, write_catalog_file
from archive_backend.config import read_archive_config
from archive_backend.embeddings import Bedrock, with_embedding
from archive_backend.sitemap import write_sitemap
from archive_backend.zips import FOLDER as ZIPS
from archive_backend.zips import zip_files
from archive_contract.config import ArchiveConfig
from archive_contract.manifest import Manifest

if TYPE_CHECKING:
    # Dev-only stubs: the Lambda asset is built without them.
    from mypy_boto3_s3 import S3Client
    from mypy_boto3_sns import SNSClient

MANIFEST = "datapackage.json"
PREFIXES = ("open", "restricted")
BATCH = 200
DELETE_BATCH = 25
RUNNING = ("IN_PROGRESS", "CANCELLING")
MISSING = ("404", "NoSuchKey", "NotFound")


class DynamoDB(Protocol):
    """The DynamoDB calls the reindex makes (boto3-stubs has no dynamodb extra installed)."""

    def scan(self, **kwargs: Any) -> dict[str, Any]: ...
    def batch_write_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def start_bulk_put_items(self, **kwargs: Any) -> dict[str, Any]: ...
    def describe_bulk_operation(self, **kwargs: Any) -> dict[str, Any]: ...


class SSM(Protocol):
    def get_parameter(self, **kwargs: Any) -> dict[str, Any]: ...
    def put_parameter(self, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Clients:
    s3: S3Client
    dynamodb: DynamoDB
    ssm: SSM
    sns: SNSClient
    bedrock: Bedrock


def clients() -> Clients:
    return Clients(
        s3=boto3.client("s3"),
        dynamodb=cast(DynamoDB, boto3.client("dynamodb")),
        ssm=cast(SSM, boto3.client("ssm")),
        sns=boto3.client("sns"),
        bedrock=cast(Bedrock, boto3.client("bedrock-runtime")),
    )


def embeddings_enabled(cfg: ArchiveConfig) -> bool:
    """Whether the archive config switches the embeddings module on."""
    return cfg.infrastructure is not None and cfg.infrastructure.modules.embeddings is not None


def _s(value: Any) -> dict[str, str]:
    return {"S": str(value)}


def _n(value: int) -> dict[str, str]:
    return {"N": str(value)}


def _sk(version: int) -> str:
    return f"V#{version:06d}"


def _paths(path: Any) -> list[str]:
    if isinstance(path, str):
        return [path]
    if isinstance(path, list):
        return [p for p in path if isinstance(p, str)]
    return []


def _file_item(
    pk: str, sk: str, path: str, name: Any, fmt: Any, size: Any, digest: Any
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "PK": _s(pk),
        "SK": _s(f"{sk}#FILE#{path}"),
        "path": _s(path),
        "name": _s(name),
    }
    if fmt is not None:
        item["format"] = _s(fmt)
    if isinstance(size, int):
        item["bytes"] = _n(size)
    if digest is not None:
        item["hash"] = _s(digest)
    return item


def _published(manifest: dict[str, Any]) -> str | None:
    """`archive:published` read through the contract's field, as UTC to the second.

    Only that field is validated, so a manifest the current contract would refuse elsewhere
    still reindexes.
    """
    field = Manifest.model_validate({"archive:published": manifest.get("archive:published")})
    if field.published is None:
        return None
    when = field.published
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def catalog_items(
    prefix: str, dataset_id: str, version: int, manifest_text: str
) -> list[dict[str, Any]]:
    """The version item and one file item per resource path and `archive:files` member.

    The version item carries the manifest's `archive:published` as `publishedAt` when it has one.
    """
    manifest = json.loads(manifest_text)
    pk = f"DATASET#{dataset_id}"
    sk = _sk(version)
    version_item: dict[str, Any] = {
        "PK": _s(pk),
        "SK": _s(sk),
        "version": _n(version),
        "prefix": _s(prefix),
        "manifest": _s(manifest_text),
    }
    published = _published(manifest)
    if published:
        version_item["publishedAt"] = _s(published)
    items: list[dict[str, Any]] = [version_item]
    files: dict[str, dict[str, Any]] = {}
    for resource in manifest.get("resources") or []:
        name, fmt = resource.get("name"), resource.get("format")
        for path in _paths(resource.get("path")):
            files[path] = _file_item(
                pk, sk, path, name, fmt, resource.get("bytes"), resource.get("hash")
            )
        for member in resource.get("archive:files") or []:
            path = member.get("path")
            if isinstance(path, str):
                files[path] = _file_item(
                    pk, sk, path, name, fmt, member.get("bytes"), member.get("hash")
                )
    # The version's zips, beside it under _zips/, as file items the download route accepts;
    # no size or hash is recorded for them.
    for name, path in zip_files(manifest):
        files.setdefault(path, _file_item(pk, sk, path, name, "zip", None, None))
    items.extend(files.values())
    return items


def dataset_item(
    dataset_id: str,
    versions: list[tuple[str, int, dict[str, Any]]],
    withdrawn: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The dataset item, from the highest of one dataset's `(prefix, version, manifest)`, with
    that manifest's embargo date in `embargoUntil` and its withdrawal record (`at`, `by`,
    `reason`) as JSON in `withdrawn` when it has them.

    It keys on the folder's dataset id, as the version and file items do, never on the
    manifest's `id`, so all of a dataset's items share one partition.
    """
    prefix, version, manifest = max(versions, key=lambda v: v[1])
    item: dict[str, Any] = {
        "PK": _s(f"DATASET#{dataset_id}"),
        "SK": _s("META"),
        "id": _s(dataset_id),
        "title": _s(manifest.get("title") or dataset_id),
        "access": _s(manifest.get("archive:access") or "public"),
        "currentVersion": _n(version),
        "prefix": _s(prefix),
    }
    project = manifest.get("archive:project")
    if project:
        item["project"] = _s(project)
        item["GSI1PK"] = _s(f"PROJECT#{project}")
        item["GSI1SK"] = _s(f"DATASET#{dataset_id}")
    embargo = embargo_of(manifest)
    if embargo is not None:
        item["embargoUntil"] = _s(embargo)
    if withdrawn is not None:
        item["withdrawn"] = _s(json.dumps(withdrawn, sort_keys=True))
    return item


def embargo_of(manifest: dict[str, Any]) -> str | None:
    """The manifest's `archive:embargoUntil` as `YYYY-MM-DD`, read through the contract's field."""
    field = Manifest.model_validate({"archive:embargoUntil": manifest.get("archive:embargoUntil")})
    return field.embargo_until.isoformat() if field.embargo_until else None


def withdrawal_key(dataset_id: str) -> str:
    """Where a dataset's withdrawal is recorded in the archive bucket, so a reindex keeps it."""
    return f"state/{dataset_id}/withdrawn.json"


def read_withdrawal(s3: Any, archive: str, dataset_id: str) -> dict[str, Any] | None:
    """The dataset's withdrawal record from the archive bucket, or None when it has none."""
    try:
        body = s3.get_object(Bucket=archive, Key=withdrawal_key(dataset_id))["Body"].read()
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in MISSING:
            return None
        raise
    record: dict[str, Any] = json.loads(body)
    return record


def withdrawal_of(meta: dict[str, Any] | None) -> dict[str, Any] | None:
    """The withdrawal record a dataset item carries, or None."""
    text = (meta or {}).get("withdrawn", {}).get("S")
    if not isinstance(text, str):
        return None
    record: dict[str, Any] = json.loads(text)
    return record


def current_versions(items: list[dict[str, Any]]) -> list[tuple[str, int, str, list[str]]]:
    """Each dataset's `(id, current version, manifest text, file paths)` from catalog items.

    The paths are the version's file items that sit in the archive; a linked URL is left out.
    """
    by_dataset: dict[str, dict[str, dict[str, Any]]] = {}
    for item in items:
        by_dataset.setdefault(item["PK"]["S"], {})[item["SK"]["S"]] = item
    found: list[tuple[str, int, str, list[str]]] = []
    for dataset in by_dataset.values():
        meta = dataset.get("META")
        if meta is None or "currentVersion" not in meta:
            continue
        version = int(meta["currentVersion"]["N"])
        sk = _sk(version)
        current = dataset.get(sk)
        if current is None:
            continue
        files = sorted(
            path
            for key, file in dataset.items()
            if key.startswith(f"{sk}#FILE#")
            for path in [file["path"]["S"]]
            if "://" not in path and not path.startswith(ZIPS)
        )
        found.append((meta["id"]["S"], version, current["manifest"]["S"], files))
    return sorted(found)


def version_files(items: list[dict[str, Any]]) -> dict[tuple[str, int], list[str]]:
    """Each `(dataset id, version)`'s file paths that sit in the archive, zips left out."""
    found: dict[tuple[str, int], list[str]] = {}
    for item in items:
        pk, sk = item["PK"]["S"], item["SK"]["S"]
        head, marker, path = sk.partition("#FILE#")
        if marker and "://" not in path and not path.startswith(ZIPS):
            key = (pk.removeprefix("DATASET#"), int(head.removeprefix("V#")))
            found.setdefault(key, []).append(path)
    return {key: sorted(paths) for key, paths in found.items()}


def write_pages(
    s3: Any,
    derived: str,
    domain: str,
    look: pages.PageBrand,
    items: list[dict[str, Any]],
    today: date | None = None,
) -> int:
    """Render and write each dataset's page from its current version in `items`, and every
    version's own page, as the withdrawn page for a withdrawn dataset; return how many."""
    files = version_files(items)
    withdrawals = {
        item["PK"]["S"].removeprefix("DATASET#"): withdrawal_of(item)
        for item in items
        if item["SK"]["S"] == "META"
    }
    written = 0
    for dataset_id, version, text, current in current_versions(items):
        html = pages.render_page(
            Manifest.model_validate_json(text),
            dataset_id=dataset_id,
            version=version,
            domain=domain,
            files=current,
            brand=look,
            withdrawn=withdrawals.get(dataset_id),
            today=today,
        )
        pages.write_page(s3, derived, html, dataset_id)
        written += 1
    for dataset_id, found in stored_versions(items):
        for _prefix, version, text in found:
            html = pages.render_page(
                Manifest.model_validate_json(text),
                dataset_id=dataset_id,
                version=version,
                domain=domain,
                files=files.get((dataset_id, version), []),
                versioned=True,
                brand=look,
                withdrawn=withdrawals.get(dataset_id),
                today=today,
            )
            pages.write_page(s3, derived, html, dataset_id, version)
            written += 1
    return written


@durable_step
def _pages(
    _: StepContext, c: Clients, table: str, derived: str, domain: str, brand: dict[str, Any]
) -> int:
    """Every dataset's and version's page from `table`; how many were written."""
    return write_pages(c.s3, derived, domain, pages.PageBrand(**brand), _scan(c.dynamodb, table))


def stored_versions(items: list[dict[str, Any]]) -> list[tuple[str, list[tuple[str, int, str]]]]:
    """Each dataset's `(id, [(prefix, version, manifest text)])` from catalog items, every
    version in order."""
    by_dataset: dict[str, list[tuple[str, int, str]]] = {}
    for item in items:
        sk = item["SK"]["S"]
        if sk.startswith("V#") and "#FILE#" not in sk:
            dataset_id = item["PK"]["S"].removeprefix("DATASET#")
            entry = (item["prefix"]["S"], int(item["version"]["N"]), item["manifest"]["S"])
            by_dataset.setdefault(dataset_id, []).append(entry)
    return [(d, sorted(v, key=lambda e: e[1])) for d, v in sorted(by_dataset.items())]


@durable_step
def _zips(
    _: StepContext, c: Clients, archive: str, dataset_id: str, versions: list[list[Any]]
) -> int:
    """Write the zips of each of one dataset's versions whose members changed."""
    written = 0
    for prefix, version, text in versions:
        root = f"{prefix}/{dataset_id}/{version}/"
        written += len(zips.write_zips(cast(zips.S3, c.s3), archive, root, json.loads(text)))
    return written


def to_lines(items: list[dict[str, Any]]) -> str:
    """Bulk put items input: one `{"Item": {...}}` per line, newline-terminated."""
    return "".join(json.dumps({"Item": item}) + "\n" for item in items)


def _parts(key: str) -> tuple[str, str, int] | None:
    parts = key.split("/")
    if len(parts) != 4 or parts[0] not in PREFIXES or parts[3] != MANIFEST:
        return None
    if not parts[1] or not parts[2].isdigit():
        return None
    return parts[0], parts[1], int(parts[2])


def manifest_keys(s3: S3Client, bucket: str) -> list[str]:
    """Every `<open|restricted>/<datasetId>/<version>/datapackage.json`, sorted."""
    paginator = s3.get_paginator("list_objects_v2")
    keys: list[str] = []
    for prefix in PREFIXES:
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix + "/"):
            for item in page.get("Contents", []):
                key = item.get("Key", "")
                if _parts(key):
                    keys.append(key)
    return sorted(keys)


@durable_step
def _list(_: StepContext, c: Clients, archive: str) -> list[str]:
    return manifest_keys(c.s3, archive)


def _batches(keys: list[str]) -> list[list[str]]:
    """Batches of at most BATCH keys that never split a dataset; a bigger dataset stands alone."""
    by_dataset: dict[str, list[str]] = {}
    for key in keys:
        parts = _parts(key)
        if parts:
            by_dataset.setdefault(parts[1], []).append(key)
    batches: list[list[str]] = []
    current: list[str] = []
    for dataset_id in sorted(by_dataset):
        group = by_dataset[dataset_id]
        if current and len(current) + len(group) > BATCH:
            batches.append(current)
            current = []
        current.extend(group)
    if current:
        batches.append(current)
    return batches


@durable_step
def _write(
    _: StepContext,
    c: Clients,
    archive: str,
    derived: str,
    run: str,
    n: int,
    keys: list[str],
    embeddings: bool = False,
) -> int:
    items: list[dict[str, Any]] = []
    versions: dict[str, list[tuple[str, int, dict[str, Any]]]] = {}
    for key in keys:
        parts = _parts(key)
        if not parts:
            continue
        prefix, dataset_id, version = parts
        text = c.s3.get_object(Bucket=archive, Key=key)["Body"].read().decode("utf-8")
        items.extend(catalog_items(prefix, dataset_id, version, text))
        versions.setdefault(dataset_id, []).append((prefix, version, json.loads(text)))
    for dataset_id, found in versions.items():
        item = dataset_item(dataset_id, found, read_withdrawal(c.s3, archive, dataset_id))
        if embeddings:
            item = with_embedding(item, max(found, key=lambda v: v[1])[2], c.bedrock)
        items.append(item)
    c.s3.put_object(
        Bucket=derived,
        Key=f"reindex/{run}/data/part-{n:05d}.json",
        Body=to_lines(items).encode("utf-8"),
    )
    return len(items)


@durable_step
def _empty_page(
    _: StepContext, c: Clients, table: str, start: dict[str, Any] | None
) -> dict[str, Any] | None:
    scan: dict[str, Any] = {
        "TableName": table,
        "ProjectionExpression": "#pk, #sk",
        "ExpressionAttributeNames": {"#pk": "PK", "#sk": "SK"},
    }
    if start:
        scan["ExclusiveStartKey"] = start
    page = c.dynamodb.scan(**scan)
    keys = page.get("Items", [])
    for i in range(0, len(keys), DELETE_BATCH):
        requests: dict[str, Any] = {
            table: [{"DeleteRequest": {"Key": k}} for k in keys[i : i + DELETE_BATCH]]
        }
        attempt = 0
        while requests:
            if attempt:
                time.sleep(min(0.05 * 2**attempt, 5))
            requests = c.dynamodb.batch_write_item(RequestItems=requests).get(
                "UnprocessedItems", {}
            )
            attempt += 1
    last: dict[str, Any] | None = page.get("LastEvaluatedKey")
    return last


def _stage(config_parameter: str) -> str:
    """The stage's name, from its parameter `/research-archive/<stage>/archive-config`."""
    return config_parameter.strip("/").split("/")[1]


@durable_step
def _dois_list(_: StepContext, c: Clients, archive: str, config_parameter: str) -> list[str] | None:
    """The manifest keys a `--dois` run handles: each version that has a current DOI, and each
    without one of a dataset that isn't withdrawn. None when the DOI module is off."""
    settings = read_archive_config(c.ssm, config_parameter).doi
    if settings is None:
        return None
    withdrawn: dict[str, bool] = {}
    keys: list[str] = []
    for key in manifest_keys(c.s3, archive):
        _prefix, dataset_id, _version = cast(tuple[str, str, int], _parts(key))
        manifest = json.loads(c.s3.get_object(Bucket=archive, Key=key)["Body"].read())
        if dataset_id not in withdrawn:
            withdrawn[dataset_id] = read_withdrawal(c.s3, archive, dataset_id) is not None
        if (
            doi.is_current(settings, manifest.get("archive:identifier"))
            or not withdrawn[dataset_id]
        ):
            keys.append(key)
    return keys


@durable_step
def _doi(
    _: StepContext, c: Clients, archive: str, domain: str, config_parameter: str, key: str
) -> str | None:
    """Re-send the version's record when it has a current DOI, else register one and write it
    into the stored manifest; a line naming the version when DataCite refuses, else None."""
    config = read_archive_config(c.ssm, config_parameter)
    settings = config.doi
    if settings is None:
        return None
    prefix, dataset_id, version = cast(tuple[str, str, int], _parts(key))
    text = c.s3.get_object(Bucket=archive, Key=key)["Body"].read().decode("utf-8")
    identifier = json.loads(text).get("archive:identifier")
    manifest = Manifest.model_validate_json(text)
    url = pages.identifier(domain, dataset_id, version)
    try:
        dc = doi.client(c.ssm, settings)
        if doi.is_current(settings, identifier):
            doi.update(
                dc,
                settings,
                manifest,
                publisher=config.publisher,
                doi=doi.name_of(settings, identifier),
                url=url,
                withdrawn=read_withdrawal(c.s3, archive, dataset_id),
            )
        else:
            found = doi.register(
                dc,
                settings,
                manifest,
                publisher=config.publisher,
                dataset_id=dataset_id,
                version=version,
                url=url,
            )
            root = f"{prefix}/{dataset_id}/{version}/"
            doi.write_identifier(cast(doi.S3, c.s3), archive, root, found)
    except (doi.DataCiteError, doi.DoiTaken) as error:
        return f"{dataset_id} v{version}: {error}"
    return None


def _register_dois(
    context: DurableContext, c: Clients, archive: str, domain: str, topic: str
) -> None:
    """The `--dois` steps, before the reindex lists and loads the manifests."""
    config_parameter = os.environ["ARCHIVE_CONFIG_PARAMETER"]
    keys = context.step(_dois_list(c, archive, config_parameter), name="dois-list")
    if keys is None:
        subject = "Reindex --dois: DOIs are off"
        message = (
            "archive.yaml has no doi block, so no DOI was registered; the reindex ran as usual."
        )
    else:
        lines = [
            line
            for n, key in enumerate(keys)
            if (
                line := context.step(
                    _doi(c, archive, domain, config_parameter, key), name=f"doi-{n}"
                )
            )
        ]
        if not lines:
            return
        subject = f"Reindex --dois: {len(lines)} DOI(s) not registered or updated"
        message = "\n".join(
            [
                *lines,
                "",
                f"Run just reindex {_stage(config_parameter)} --dois again once DataCite answers.",
            ]
        )

    def alert(_: object) -> None:
        c.sns.publish(TopicArn=topic, Subject=subject[:99], Message=message)

    context.step(alert, name="dois-alert")


def _until_ended(state: dict[str, Any], attempt: int) -> WaitForConditionDecision:
    if state["status"] not in RUNNING:
        return WaitForConditionDecision.stop_polling()
    return WaitForConditionDecision.continue_waiting(Duration.from_seconds(min(30 * attempt, 300)))


def run(event: dict[str, Any], context: DurableContext) -> dict[str, Any]:
    """Empty, write, load, wait and flip, each a checkpointed step."""
    c = clients()
    archive = os.environ["ARCHIVE_BUCKET"]
    derived = os.environ["DERIVED_BUCKET"]
    tables = {"A": os.environ["CATALOG_TABLE_A"], "B": os.environ["CATALOG_TABLE_B"]}
    parameter = os.environ["ACTIVE_CATALOG_PARAMETER"]
    topic = os.environ["ALERT_TOPIC_ARN"]
    domain = os.environ["SITE_DOMAIN"]

    def start(_: object) -> dict[str, Any]:
        active = c.ssm.get_parameter(Name=parameter)["Parameter"]["Value"]
        cfg = read_archive_config(c.ssm, os.environ["ARCHIVE_CONFIG_PARAMETER"])
        return {
            "run": datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"),
            "active": active,
            "embeddings": embeddings_enabled(cfg),
            "brand": asdict(pages.page_brand(cfg)),
        }

    begun = context.step(start, name="start")
    if event.get("dois"):
        _register_dois(context, c, archive, domain, topic)
    run_id: str = begun["run"]
    embeddings = bool(begun.get("embeddings"))
    target = "A" if begun["active"] == "B" else "B"
    table = tables[target]

    page: dict[str, Any] | None = None
    while True:
        page = context.step(_empty_page(c, table, page), name="empty")
        if not page:
            break

    keys = context.step(_list(c, archive), name="list")

    count = 0
    for n, batch in enumerate(_batches(keys)):
        count += context.step(
            _write(c, archive, derived, run_id, n, batch, embeddings),
            name=f"write-{n}",
        )

    status = "COMPLETED"
    if keys:
        data = f"reindex/{run_id}/data/"
        report = f"reindex/{run_id}/report/"

        def load(_: object) -> str:
            started = c.dynamodb.start_bulk_put_items(
                TableName=table,
                InputS3Configuration={
                    "S3Bucket": derived,
                    "S3KeyPrefix": data,
                    "InputFormat": "DYNAMODB_JSON",
                },
                OutputS3Configuration={
                    "S3Bucket": derived,
                    "S3KeyPrefix": report,
                    "OutputType": ["ERROR"],
                },
                PerformanceTier="STANDARD",
                ClientToken=run_id,
            )
            arn: str = started["BulkOperationDescription"]["BulkOperationArn"]
            return arn

        operation = context.step(load, name="load")

        def check(state: dict[str, Any], _: object) -> dict[str, Any]:
            described = c.dynamodb.describe_bulk_operation(BulkOperationArn=operation)
            d = described["BulkOperationDescription"]
            return {
                "status": d["BulkOperationStatus"],
                "processed": d.get("ProcessedItemCount", 0),
                "failed": d.get("FailedItemCount", 0),
            }

        ended = context.wait_for_condition(
            check,
            WaitForConditionConfig(
                wait_strategy=_until_ended,
                initial_state={"status": "IN_PROGRESS", "processed": 0, "failed": 0},
            ),
            name="wait-load",
        )
        status = str(ended["status"])

    flipped = status == "COMPLETED"
    rows: int | None = None
    written_pages: int | None = None
    if flipped:

        def flip(_: object) -> None:
            c.ssm.put_parameter(Name=parameter, Value=target, Overwrite=True)

        context.step(flip, name="flip")

        def catalog(_: object) -> dict[str, Any]:
            try:
                rows = write_catalog_file(table, derived, dynamodb=c.dynamodb, s3=c.s3)
                write_sitemap(table, derived, domain, dynamodb=c.dynamodb, s3=c.s3)
                return {"rows": rows}
            except Exception as error:
                return {"error": f"{type(error).__name__}: {error}"}

        written = context.step(catalog, name="catalog")
        rows = written.get("rows")
        if "error" in written:
            subject = f"Reindex {run_id} could not write the catalog file"
            error = str(written["error"])

            def catalog_alert(_: object) -> None:
                c.sns.publish(
                    TopicArn=topic,
                    Subject=subject[:100],
                    Message=f"Reindex {run_id} flipped to {target} but writing "
                    f"s3://{derived}/site/catalog.json failed: {error}",
                )

            context.step(catalog_alert, name="alert")

        brand = begun["brand"]
        written_pages = context.step(_pages(c, table, derived, domain, brand), name="pages")

        def datasets(_: object) -> list[Any]:
            return [
                [d, [list(v) for v in found]]
                for d, found in stored_versions(_scan(c.dynamodb, table))
            ]

        for n, (dataset_id, found) in enumerate(context.step(datasets, name="versions")):
            context.step(_zips(c, archive, dataset_id, found), name=f"zips-{n}")
    else:
        subject = f"Reindex {run_id} on {target} ended {status}"

        def alert(_: object) -> None:
            c.sns.publish(
                TopicArn=topic,
                Subject=subject[:100],
                Message=f"{subject}. Report: s3://{derived}/reindex/{run_id}/report/",
            )

        context.step(alert, name="alert")

    return {
        "run": run_id,
        "target": target,
        "status": status,
        "items": count,
        "flipped": flipped,
        "catalog": rows,
        "pages": written_pages,
    }


handler = durable_execution(run)
