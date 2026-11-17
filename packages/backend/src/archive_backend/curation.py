"""The curation routes: withdraw and restore a published dataset, correct a published version's
details, and move an embargo's date.

Each route records the change at once (the dataset item in the active catalog table, and for a
withdrawal `state/<id>/withdrawn.json` in the archive bucket, which the reindex reads) and
invokes the lifecycle function asynchronously to move files and rewrite the pages and listings.
Every change is written to the AccountEvents table under the acting admin or curator and under
`all`, as the admin plan's account changes are. Withdraw, restore and embargo are for admins; a
correction is for curators and admins.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import UTC, date, datetime
from functools import cache
from pathlib import Path
from typing import Any, Protocol, cast

import boto3
from aws_lambda_powertools.event_handler import APIGatewayRestResolver
from aws_lambda_powertools.event_handler.exceptions import (
    BadRequestError,
    ForbiddenError,
    NotFoundError,
    ServiceError,
    UnauthorizedError,
)
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.exceptions import ClientError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from archive_backend import access, people
from archive_backend.access_api import AccountAction
from archive_backend.reindex import embargo_of, withdrawal_key
from archive_backend.submissions import Table
from archive_backend.whoami import _groups
from archive_contract.manifest import (
    Contributor,
    Funding,
    Manifest,
    MetadataEdit,
    RelatedIdentifier,
)
from cruise.edit import PACKAGE_TARGETS, README, EditError, edit_package

ADMIN = "admin"
CURATOR = "curator"
MAX_TEXT = 2000
MANIFEST = "datapackage.json"
CHECKSUMS = "checksums.sha256"
HISTORY = "archive:metadataHistory"


class S3(Protocol):
    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def put_object(self, **kwargs: Any) -> Any: ...
    def delete_object(self, **kwargs: Any) -> Any: ...


class DynamoDB(Protocol):
    def get_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def update_item(self, **kwargs: Any) -> dict[str, Any]: ...


class SSM(Protocol):
    def get_parameter(self, **kwargs: Any) -> dict[str, Any]: ...


class Lambda(Protocol):
    def invoke(self, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Clients:
    s3: S3
    dynamodb: DynamoDB
    ssm: SSM
    lambda_: Lambda
    account_events: Table
    cognito: people.Groups


@cache
def clients() -> Clients:
    events = boto3.resource("dynamodb").Table(os.environ["ACCOUNT_EVENTS_TABLE"])
    return Clients(
        s3=cast(S3, boto3.client("s3")),
        dynamodb=cast(DynamoDB, boto3.client("dynamodb")),
        ssm=cast(SSM, boto3.client("ssm")),
        lambda_=cast(Lambda, boto3.client("lambda")),
        account_events=cast(Table, events),
        cognito=cast(people.Groups, boto3.client("cognito-idp")),
    )


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class Conflict(ServiceError):
    def __init__(self, message: str) -> None:
        super().__init__(409, message)


class WithdrawRequest(BaseModel):
    reason: str = Field(max_length=MAX_TEXT)

    @field_validator("reason")
    @classmethod
    def _said(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("give the reason for the withdrawal")
        return value.strip()


class Withdrawal(BaseModel):
    """When, by whom and why a dataset was withdrawn."""

    at: str
    by: str
    reason: str


class CorrectionRequest(BaseModel):
    """`PUT /api/datasets/{id}/versions/{version}/metadata`: the fields a correction may change,
    each given replacing the stored value (null removes it), and what was corrected."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    description: str | None = None
    keywords: list[str] | None = None
    contributors: list[Contributor] | None = None
    related_identifiers: list[RelatedIdentifier] | None = Field(
        default=None, alias="archive:relatedIdentifiers"
    )
    funding: list[Funding] | None = Field(default=None, alias="archive:funding")
    methods: str | None = Field(default=None, alias="archive:methods")
    note: str = Field(max_length=MAX_TEXT, description="What did you correct?")

    @field_validator("note")
    @classmethod
    def _said(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("say what you corrected")
        return value.strip()

    def changes(self) -> dict[str, Any]:
        """The given fields by their manifest names, in the form the manifest stores them."""
        found: dict[str, Any] = {}
        for name, info in type(self).model_fields.items():
            if name == "note" or name not in self.model_fields_set:
                continue
            value = getattr(self, name)
            if isinstance(value, list):
                value = [
                    v.model_dump(mode="json", by_alias=True, exclude_none=True)
                    if isinstance(v, BaseModel)
                    else v
                    for v in value
                ]
            found[info.alias or name] = value
        return found


class EmbargoRequest(BaseModel):
    """`PUT /api/admin/datasets/{id}/embargo`: the day the files become available; today lifts
    the embargo."""

    until: date


class CorrectionAnswer(BaseModel):
    datasetId: str
    version: int
    manifest: dict[str, Any]


class CurationAnswer(BaseModel):
    datasetId: str
    withdrawn: Withdrawal | None = Field(default=None, exclude_if=lambda v: v is None)


app = APIGatewayRestResolver(enable_validation=True)


def _claims() -> dict[str, Any]:
    context = app.current_event.raw_event.get("requestContext") or {}
    claims = (context.get("authorizer") or {}).get("claims")
    if not isinstance(claims, dict) or not claims:
        raise UnauthorizedError("sign in first")
    return claims


def _live(sub: str, roles: set[str], refusal: str) -> str:
    """The caller's id once the token's role holds live: not disabled in UserProfiles, and one
    of `roles` among their Cognito groups now, as the access function checks its admins."""
    c = clients()
    profile = (
        c.dynamodb.get_item(
            TableName=os.environ["USER_PROFILES_TABLE"], Key={"userId": {"S": sub}}
        ).get("Item")
        or {}
    )
    try:
        people.require_live(
            c.cognito,
            os.environ["USER_POOL_ID"],
            sub,
            disabled=profile.get("disabled") == {"BOOL": True},
            roles=roles,
            refusal=refusal,
        )
    except people.NotAllowed as refused:
        raise ForbiddenError(str(refused)) from None
    return sub


def _curator() -> str:
    claims = _claims()
    if not {CURATOR, ADMIN} & set(_groups(claims.get("cognito:groups"))):
        raise ForbiddenError("curators and admins only")
    return _live(str(claims["sub"]), {CURATOR, ADMIN}, "curators and admins only")


def _admin() -> str:
    claims = _claims()
    if ADMIN not in _groups(claims.get("cognito:groups")):
        raise ForbiddenError("admins only")
    return _live(str(claims["sub"]), {ADMIN}, "admins only")


def _table() -> str:
    name = os.environ["ACTIVE_CATALOG_PARAMETER"]
    value = clients().ssm.get_parameter(Name=name)["Parameter"]["Value"]
    if value not in ("A", "B"):
        raise RuntimeError(f"{name} names {value!r}, not A or B")
    return os.environ[f"CATALOG_TABLE_{value}"]


def _meta_key(dataset_id: str) -> dict[str, Any]:
    return {"PK": {"S": f"DATASET#{dataset_id}"}, "SK": {"S": "META"}}


def _meta(table: str, dataset_id: str) -> dict[str, Any]:
    item = clients().dynamodb.get_item(TableName=table, Key=_meta_key(dataset_id)).get("Item")
    if not item:
        raise NotFoundError(f"no dataset {dataset_id}")
    return cast(dict[str, Any], item)


def _update(
    table: str, dataset_id: str, condition: str, quiet: bool = False, **update: Any
) -> None:
    """Update the dataset item under `condition`; 409 when the condition fails, or nothing with
    `quiet`."""
    try:
        clients().dynamodb.update_item(
            TableName=table, Key=_meta_key(dataset_id), ConditionExpression=condition, **update
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        if quiet:
            return
        raise Conflict(f"dataset {dataset_id} changed meanwhile; read it again") from None


def record_event(action: AccountAction, actor: str, dataset_id: str, **details: Any) -> None:
    """Write one AccountEvents item: who did what to which dataset, under the actor and `all`."""
    access.record_event(
        clients().account_events, actor, action, actor, datasetId=dataset_id, **details
    )


def run_lifecycle(dataset_id: str, dois: bool = False) -> None:
    """Invoke the lifecycle function asynchronously for the dataset; with `dois`, it also
    re-sends the DataCite record of each version that has a DOI, when the DOI module is on."""
    payload: dict[str, Any] = {"datasetId": dataset_id}
    if dois:
        payload["dois"] = True
    clients().lambda_.invoke(
        FunctionName=os.environ["LIFECYCLE_FUNCTION"],
        InvocationType="Event",
        Payload=json.dumps(payload).encode("utf-8"),
    )


@app.post("/api/admin/datasets/<id>/withdraw")
def withdraw(id: str, request: WithdrawRequest) -> CurationAnswer:
    by = _admin()
    table = _table()
    if "withdrawn" in _meta(table, id):
        raise Conflict(f"dataset {id} is already withdrawn")
    record = Withdrawal(at=_now(), by=by, reason=request.reason)
    text = json.dumps(record.model_dump(), sort_keys=True)
    clients().s3.put_object(
        Bucket=os.environ["ARCHIVE_BUCKET"],
        Key=withdrawal_key(id),
        Body=text.encode("utf-8"),
        ContentType="application/json",
    )
    _update(
        table,
        id,
        "attribute_exists(PK) AND attribute_not_exists(#w)",
        UpdateExpression="SET #w = :w",
        ExpressionAttributeNames={"#w": "withdrawn"},
        ExpressionAttributeValues={":w": {"S": text}},
    )
    record_event("dataset-withdrawn", by, id, reason=request.reason)
    # The lifecycle updates the version DOIs' DataCite records after its sync.
    run_lifecycle(id, dois=True)
    return CurationAnswer(datasetId=id, withdrawn=record)


@app.post("/api/admin/datasets/<id>/restore")
def restore(id: str) -> CurationAnswer:
    by = _admin()
    table = _table()
    if "withdrawn" not in _meta(table, id):
        raise Conflict(f"dataset {id} is not withdrawn")
    # The record in state/ goes first, so a restore that fails between the two can be retried.
    clients().s3.delete_object(Bucket=os.environ["ARCHIVE_BUCKET"], Key=withdrawal_key(id))
    _update(
        table,
        id,
        "attribute_exists(#w)",
        UpdateExpression="REMOVE #w",
        ExpressionAttributeNames={"#w": "withdrawn"},
    )
    record_event("dataset-restored", by, id)
    # The lifecycle updates the version DOIs' DataCite records after its sync.
    run_lifecycle(id, dois=True)
    return CurationAnswer(datasetId=id)


def _read(bucket: str, key: str) -> bytes:
    body: bytes = clients().s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    return body


def _put(bucket: str, key: str, body: bytes, kind: str) -> None:
    """One PUT with its full SHA-256, as publish writes, so the integrity check reads it."""
    clients().s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType=kind,
        ChecksumSHA256=base64.b64encode(hashlib.sha256(body).digest()).decode("ascii"),
    )


def checksum_lines(text: str, changed: dict[str, bytes]) -> str:
    """`checksums.sha256` with the changed files' lines replaced and every other line kept."""
    listed: dict[str, str] = {}
    for line in text.splitlines():
        if line.strip():
            digest, path = line.split(maxsplit=1)
            listed[path.lstrip("*")] = digest
    for path, body in changed.items():
        listed[path] = hashlib.sha256(body).hexdigest()
    listed.pop(CHECKSUMS, None)
    return "".join(f"{listed[path]}  {path}\n" for path in sorted(listed))


def rewrite_version(
    root: str, changes: dict[str, Any], by: str, note: str, when: str
) -> dict[str, Any]:
    """Apply `changes` to the stored version at `root` through cruise's edit code, record a
    `MetadataEdit`, and rewrite its manifest, README and checksums in the archive bucket. The
    data files and their checksum lines are untouched. Raise BadRequestError when the contract
    refuses the result, before anything is written."""
    bucket = os.environ["ARCHIVE_BUCKET"]
    document = json.loads(_read(bucket, root + MANIFEST))
    entry = MetadataEdit(when=datetime.fromisoformat(when), who=by, fields=list(changes), note=note)
    edits: list[dict[str, Any]] = []
    for target, value in changes.items():
        if target in PACKAGE_TARGETS:
            edits.append({"target": target, "value": value})
        elif value is None:
            document.pop(target, None)
        else:
            document[target] = value
    history = document.get(HISTORY)
    recorded = entry.model_dump(mode="json", by_alias=True, exclude_none=True)
    document[HISTORY] = [*(history if isinstance(history, list) else []), recorded]
    if not edits:
        # cruise rewrites the README and checksums only through an edit; this one changes nothing.
        edits.append({"target": "description", "value": document.get("description")})
    with tempfile.TemporaryDirectory(prefix="correct-") as tmp:
        folder = Path(tmp)
        try:
            Manifest.model_validate(document)
            (folder / MANIFEST).write_text(
                json.dumps(document, indent=2, ensure_ascii=False) + "\n"
            )
            edit_package(folder, edits)
        except (EditError, ValidationError, ValueError) as error:
            raise BadRequestError(str(error)) from None
        manifest_body = (folder / MANIFEST).read_bytes()
        readme_body = (folder / README).read_bytes()
    listed = _read(bucket, root + CHECKSUMS).decode("utf-8")
    sums = checksum_lines(listed, {MANIFEST: manifest_body, README: readme_body}).encode("utf-8")
    _put(bucket, root + README, readme_body, "text/markdown")
    _put(bucket, root + CHECKSUMS, sums, "text/plain")
    _put(bucket, root + MANIFEST, manifest_body, "application/json")
    stored: dict[str, Any] = json.loads(manifest_body)
    return stored


def _version_key(dataset_id: str, version: int) -> dict[str, Any]:
    return {"PK": {"S": f"DATASET#{dataset_id}"}, "SK": {"S": f"V#{version:06d}"}}


def store_manifest(table: str, dataset_id: str, version: int, manifest: dict[str, Any]) -> None:
    """The version item's `manifest`, and the dataset item's title and embargo date when it is
    the current one."""
    db = clients().dynamodb
    db.update_item(
        TableName=table,
        Key=_version_key(dataset_id, version),
        UpdateExpression="SET #m = :m",
        ExpressionAttributeNames={"#m": "manifest"},
        ExpressionAttributeValues={
            ":m": {"S": json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"}
        },
    )
    values = {
        ":t": {"S": str(manifest.get("title") or dataset_id)},
        ":v": {"N": str(version)},
    }
    expression = "SET #t = :t"
    embargo = embargo_of(manifest)
    if embargo is None:
        expression += " REMOVE #e"
    else:
        expression += ", #e = :e"
        values[":e"] = {"S": embargo}
    _update(
        table,
        dataset_id,
        "currentVersion = :v",
        UpdateExpression=expression,
        ExpressionAttributeNames={"#t": "title", "#e": "embargoUntil"},
        ExpressionAttributeValues=values,
        quiet=True,
    )


@app.put("/api/datasets/<id>/versions/<version>/metadata")
def correct(id: str, version: int, request: CorrectionRequest) -> CorrectionAnswer:
    by = _curator()
    table = _table()
    if "withdrawn" in _meta(table, id):
        raise Conflict(f"dataset {id} is withdrawn; restore it before correcting it")
    item = clients().dynamodb.get_item(TableName=table, Key=_version_key(id, version)).get("Item")
    if not item:
        raise NotFoundError(f"no version {version} of {id}")
    changes = request.changes()
    if not changes:
        raise BadRequestError("give at least one field to correct")
    root = f"{item['prefix']['S']}/{id}/{version}/"
    manifest = rewrite_version(root, changes, by, request.note, _now())
    store_manifest(table, id, version, manifest)
    record_event(
        "metadata-corrected", by, id, version=version, fields=list(changes), note=request.note
    )
    # The lifecycle updates the version DOIs' DataCite records after its sync.
    run_lifecycle(id, dois=True)
    return CorrectionAnswer(datasetId=id, version=version, manifest=manifest)


@app.put("/api/admin/datasets/<id>/embargo")
def move_embargo(id: str, request: EmbargoRequest) -> CorrectionAnswer:
    """Rewrite the current version's `archive:embargoUntil` through the correction writer, and
    run the lifecycle: an earlier date may release the files, a later one holds them again."""
    by = _admin()
    table = _table()
    meta = _meta(table, id)
    if "withdrawn" in meta:
        raise Conflict(f"dataset {id} is withdrawn; restore it before moving its embargo")
    version = int(meta["currentVersion"]["N"])
    until = request.until.isoformat()
    root = f"{meta['prefix']['S']}/{id}/{version}/"
    manifest = rewrite_version(
        root, {"archive:embargoUntil": until}, by, f"Embargo moved to {until}", _now()
    )
    store_manifest(table, id, version, manifest)
    record_event("embargo-moved", by, id, until=until)
    run_lifecycle(id)
    return CorrectionAnswer(datasetId=id, version=version, manifest=manifest)


def handler(event: dict[str, Any], context: object) -> dict[str, Any]:
    return app.resolve(event, cast(LambdaContext, context))
