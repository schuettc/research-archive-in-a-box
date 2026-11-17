"""The shapes of the access function's routes, `/api/admin/people…`,
`/api/admin/account-events`, `/api/datasets/{id}/access…` and `/api/admin/access-requests…`, as
Pydantic models.

The access handler validates request bodies with the request models (their checks raise the
API's own 400 messages) and builds every answer through the answer models. `paths()` declares
the routes for the OpenAPI spec the read API writes, beside the submissions function's.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Literal, get_args

from pydantic import BaseModel, Field, field_validator
from pydantic.json_schema import models_json_schema

from archive_backend.submissions_api import ApiError, Model

Role = Literal["contributor", "curator", "admin"]
ROLES: tuple[Role, ...] = get_args(Role)

AccountStatus = Literal["invited", "signed-up", "active", "disabled"]
"""Invited and not signed in yet, signed up and not confirmed, active, or disabled."""

AccountAction = Literal[
    "invited",
    "roles-set",
    "invite-resent",
    "disabled",
    "enabled",
    "access-requested",
    "access-approved",
    "access-declined",
    "access-taken-back",
    "dataset-withdrawn",
    "dataset-restored",
    "metadata-corrected",
    "embargo-moved",
]

AccessState = Literal["none", "waiting", "approved", "declined", "ended", "taken-back"]
"""A person's standing for one restricted dataset. `ended` is an approval whose `until` has
passed; it's stored as `approved` and read as `ended` from the next day in UTC."""
StoredState = Literal["waiting", "approved", "declined", "taken-back"]

MAX_EMAIL = 254
DEFAULT_EVENTS = 50
MAX_EVENTS = 200
MAX_REASON = 1000
MAX_NOTE = 1000
# Enough to refuse what isn't an address; Cognito and the invitation email do the rest.
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


def _roles(value: list[Role]) -> list[Role]:
    if len(set(value)) != len(value):
        raise ValueError("each role may be given once")
    return value


# Requests


class InviteRequest(Model):
    email: str = Field(max_length=MAX_EMAIL)
    roles: list[Role] = Field(default_factory=list)

    @field_validator("email")
    @classmethod
    def _address(cls, value: str) -> str:
        value = value.strip().lower()
        if not EMAIL.fullmatch(value):
            raise ValueError("not an email address")
        return value

    _unique = field_validator("roles")(_roles)


class RolesRequest(Model):
    """The roles to hold, exactly: those not listed are removed."""

    roles: list[Role]

    _unique = field_validator("roles")(_roles)


class AccessRequestBody(Model):
    """Why the person wants the dataset; the admins read it."""

    reason: str

    @field_validator("reason")
    @classmethod
    def _reason(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("say what you will use it for")
        if len(value) > MAX_REASON:
            raise ValueError(f"the reason is at most {MAX_REASON} characters")
        return value


class DecisionBody(Model):
    """Approve, optionally until a date (through the end of that day in UTC), or decline. Either
    may carry a note the person sees on the dataset page."""

    decision: Literal["approve", "decline"]
    until: date | None = None
    note: str | None = Field(default=None, max_length=MAX_NOTE)


# Answers


class Account(Model):
    sub: str
    email: str
    roles: list[Role]
    status: AccountStatus
    created: str


class AccountList(Model):
    people: list[Account]


class AccountEvent(Model):
    actor: str
    action: AccountAction
    user_id: str = Field(alias="userId")
    details: dict[str, Any]
    at: str


class AccountEventList(Model):
    """Newest first."""

    events: list[AccountEvent]


class DatasetAccess(Model):
    """The signed-in person's standing for one dataset, for its page's banner."""

    dataset_id: str = Field(alias="datasetId")
    state: AccessState
    reason: str | None = None
    requested_at: str | None = Field(default=None, alias="requestedAt")
    decided_at: str | None = Field(default=None, alias="decidedAt")
    note: str | None = None
    until: date | None = None
    taken_back_at: str | None = Field(default=None, alias="takenBackAt")


class AccessRequest(DatasetAccess):
    """One person's request for one dataset, for the admins' list."""

    user_id: str = Field(alias="userId")
    email: str
    dataset_title: str = Field(alias="datasetTitle")
    decided_by: str | None = Field(default=None, alias="decidedBy")
    taken_back_by: str | None = Field(default=None, alias="takenBackBy")


class AccessRequestList(Model):
    """The waiting requests and the approvals (current, ended and taken back)."""

    requests: list[AccessRequest]


# The OpenAPI paths

REF = "#/components/schemas/{model}"
MODELS: tuple[type[BaseModel], ...] = (
    InviteRequest,
    RolesRequest,
    Account,
    AccountList,
    AccountEventList,
    AccessRequestBody,
    DecisionBody,
    DatasetAccess,
    AccessRequest,
    AccessRequestList,
)


def _ref(model: type[BaseModel]) -> dict[str, str]:
    return {"$ref": REF.format(model=model.__name__)}


def _op(
    summary: str,
    status: int,
    model: type[BaseModel],
    refused: tuple[int, ...],
    request: type[BaseModel] | None = None,
    parameters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    def answer(schema: dict[str, Any], description: str) -> dict[str, Any]:
        return {"description": description, "content": {"application/json": {"schema": schema}}}

    responses = {str(status): answer(_ref(model), "OK")}
    for code in refused:
        # ApiError is the submissions API's component; both functions answer refusals with it.
        responses[str(code)] = answer(_ref(ApiError), "Refused")
    operation: dict[str, Any] = {
        "summary": summary,
        "operationId": re.sub(r"[^a-z0-9]+", "_", summary.lower()).strip("_"),
        "responses": responses,
    }
    if request is not None:
        content = {"application/json": {"schema": _ref(request)}}
        operation["requestBody"] = {"required": True, "content": content}
    if parameters:
        operation["parameters"] = parameters
    return operation


def paths() -> tuple[dict[str, Any], dict[str, Any]]:
    """The routes as OpenAPI paths, and the component schemas they refer to."""
    _, top = models_json_schema([(m, "validation") for m in MODELS], ref_template=REF)
    schemas: dict[str, Any] = top["$defs"]
    sub = [{"in": "path", "name": "sub", "required": True, "schema": {"type": "string"}}]
    limit = {"type": "integer", "minimum": 1, "maximum": MAX_EVENTS, "default": DEFAULT_EVENTS}
    events = [{"in": "query", "name": "limit", "required": False, "schema": limit}]
    dataset = [{"in": "path", "name": "id", "required": True, "schema": {"type": "string"}}]
    request = [
        {"in": "path", "name": "dataset", "required": True, "schema": {"type": "string"}},
        *sub,
    ]
    declared: dict[str, Any] = {
        "/api/admin/people": {
            "get": _op("List every account", 200, AccountList, (403,)),
            "post": _op("Invite a person", 201, Account, (400, 403, 409), InviteRequest),
        },
        "/api/admin/people/{sub}/roles": {
            "put": _op(
                "Set a person's roles", 200, Account, (400, 403, 404, 409), RolesRequest, sub
            ),
        },
        "/api/admin/people/{sub}/resend": {
            "post": _op("Resend an invite", 200, Account, (400, 403, 404, 409), parameters=sub),
        },
        "/api/admin/people/{sub}/disable": {
            "post": _op("Disable an account", 200, Account, (400, 403, 404, 409), parameters=sub),
        },
        "/api/admin/people/{sub}/enable": {
            "post": _op("Enable an account", 200, Account, (400, 403, 404), parameters=sub),
        },
        "/api/admin/account-events": {
            "get": _op(
                "List recent account changes", 200, AccountEventList, (400, 403), None, events
            ),
        },
        "/api/datasets/{id}/access": {
            "get": _op("Read my access to a dataset", 200, DatasetAccess, (400,), None, dataset),
        },
        "/api/datasets/{id}/access-requests": {
            "post": _op(
                "Ask for access to a dataset",
                201,
                DatasetAccess,
                (400, 403, 404, 409),
                AccessRequestBody,
                dataset,
            ),
        },
        "/api/admin/access-requests": {
            "get": _op("List access requests and approvals", 200, AccessRequestList, (403,)),
        },
        "/api/admin/access-requests/{dataset}/{sub}/decision": {
            "post": _op(
                "Decide an access request",
                200,
                AccessRequest,
                (400, 403, 404, 409),
                DecisionBody,
                request,
            ),
        },
        "/api/admin/access-requests/{dataset}/{sub}/take-back": {
            "post": _op(
                "Take back an approval",
                200,
                AccessRequest,
                (400, 403, 404, 409),
                parameters=request,
            ),
        },
    }
    return declared, schemas
