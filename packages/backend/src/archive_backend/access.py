"""The access function: the admin people routes, access requests and approvals, and the record of
account changes.

Every `/api/admin/` route needs the caller in the admin group, checked from the token's
`cognito:groups` claim and again live in Cognito, and refuses a caller marked disabled, since a
token issued before a disable or a demotion stays valid until it expires; the
`/api/datasets/{id}/access…` routes need only a signed-in caller.
People are named by their Cognito `sub`; the admin calls name them by username, so each route
looks the account up by `sub` first. Disabling marks the person
`disabled` in the UserProfiles table (keyed by `userId`), which the download route reads, so
their downloads stop before their current token expires. The admin role goes with a
subscription of the person's email to the Admins topic.

Every change is one AccountEvents item written twice, under the person's id and under `all`,
with `eventKey` = `<at>#<uuid>`, so the People tab reads the recent ones from `all`.

The Access table holds one item per person and restricted dataset (`datasetId`, `userId`):
the request, its stored state (waiting, approved, declined, taken-back), the deciding admin, the
admin's note and an approval's optional `until` date. An approval lasts through the end of its
`until` day in UTC and reads as `ended` after it. A new request replaces the old item, and only
once the old one is declined, ended or taken back. Every write is conditional on the item being
as it was read, so two admins deciding at once can't both win.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Protocol, cast

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from archive_backend import people
from archive_backend.access_api import (
    DEFAULT_EVENTS,
    MAX_EVENTS,
    ROLES,
    AccessRequest,
    AccessRequestBody,
    AccessRequestList,
    AccessState,
    Account,
    AccountAction,
    AccountEventList,
    AccountList,
    AccountStatus,
    DatasetAccess,
    DecisionBody,
    InviteRequest,
    RolesRequest,
)
from archive_backend.submissions import (
    ADMIN,
    Caller,
    Refused,
    Table,
    _answer,
    _conditional,
    _parse,
    _response,
    now,
)
from archive_backend.whoami import _groups

EVERYONE = "all"
"""The AccountEvents partition that holds every change, for the recent-changes list."""
ROLE_NAMES: frozenset[str] = frozenset(ROLES)
RESTRICTED = "restricted"
DATASET_ID = re.compile(r"[A-Za-z0-9._-]{1,200}")
SUBJECT_LENGTH = 100
"""SNS refuses an email subject longer than this, or with a line break."""
DECIDED = ("decidedBy", "decidedAt", "note", "until", "takenBackBy", "takenBackAt")
"""The attributes a decision or take-back adds, which a new request clears."""
STATUSES: dict[str, AccountStatus] = {
    "FORCE_CHANGE_PASSWORD": "invited",
    "UNCONFIRMED": "signed-up",
}

logger = logging.getLogger(__name__)


class AdminCognito(Protocol):
    def list_users(self, **kwargs: Any) -> dict[str, Any]: ...
    def admin_list_groups_for_user(self, **kwargs: Any) -> dict[str, Any]: ...
    def admin_create_user(self, **kwargs: Any) -> dict[str, Any]: ...
    def admin_add_user_to_group(self, **kwargs: Any) -> Any: ...
    def admin_remove_user_from_group(self, **kwargs: Any) -> Any: ...
    def admin_disable_user(self, **kwargs: Any) -> Any: ...
    def admin_enable_user(self, **kwargs: Any) -> Any: ...
    def admin_user_global_sign_out(self, **kwargs: Any) -> Any: ...


class SNS(Protocol):
    def subscribe(self, **kwargs: Any) -> Any: ...
    def publish(self, **kwargs: Any) -> Any: ...
    def list_subscriptions_by_topic(self, **kwargs: Any) -> dict[str, Any]: ...
    def unsubscribe(self, **kwargs: Any) -> Any: ...


class ScanTable(Table, Protocol):
    def scan(self, **kwargs: Any) -> dict[str, Any]: ...


class SSM(Protocol):
    def get_parameter(self, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Clients:
    cognito: AdminCognito
    sns: SNS
    user_profiles: Table
    account_events: Table
    access: ScanTable
    ssm: SSM
    table: Callable[[str], Table]
    """A catalog table by name; the active one is named by the active-catalog parameter."""


@dataclass(frozen=True)
class Env:
    user_pool_id: str
    user_profiles_table: str
    account_events_table: str
    admins_topic_arn: str
    access_table: str
    active_catalog_parameter: str
    catalog_tables: dict[str, str]

    @classmethod
    def from_environ(cls) -> Env:
        return cls(
            user_pool_id=os.environ["USER_POOL_ID"],
            user_profiles_table=os.environ["USER_PROFILES_TABLE"],
            account_events_table=os.environ["ACCOUNT_EVENTS_TABLE"],
            admins_topic_arn=os.environ["ADMINS_TOPIC_ARN"],
            access_table=os.environ["ACCESS_TABLE"],
            active_catalog_parameter=os.environ["ACTIVE_CATALOG_PARAMETER"],
            catalog_tables={"A": os.environ["CATALOG_TABLE_A"], "B": os.environ["CATALOG_TABLE_B"]},
        )


def clients(env: Env) -> Clients:
    dynamodb = boto3.resource("dynamodb")

    def table(name: str) -> Table:
        return cast(Table, dynamodb.Table(name))

    return Clients(
        cognito=cast(AdminCognito, boto3.client("cognito-idp")),
        sns=cast(SNS, boto3.client("sns")),
        user_profiles=table(env.user_profiles_table),
        account_events=table(env.account_events_table),
        access=cast(ScanTable, dynamodb.Table(env.access_table)),
        ssm=cast(SSM, boto3.client("ssm")),
        table=table,
    )


def today() -> date:
    return datetime.now(UTC).date()


def put_event(c: Clients, actor: str, action: AccountAction, user_id: str, **details: Any) -> None:
    """Record one change under the person's id and under `all`."""
    record_event(c.account_events, actor, action, user_id, **details)


def record_event(
    events: Table, actor: str, action: AccountAction, user_id: str, **details: Any
) -> None:
    """Write one change to the AccountEvents table `events`, under `user_id` and under `all`."""
    at = now()
    item = {
        "eventKey": f"{at}#{uuid.uuid4()}",
        "actor": actor,
        "action": action,
        "userId": user_id,
        "details": details,
        "at": at,
    }
    for subject in (user_id, EVERYONE):
        events.put_item(Item={"subject": subject, **item})


# People


def _status(user: dict[str, Any]) -> AccountStatus:
    if not user.get("Enabled", True):
        return "disabled"
    return STATUSES.get(str(user.get("UserStatus")), "active")


def _created(user: dict[str, Any]) -> str:
    created = user.get("UserCreateDate")
    if not isinstance(created, datetime):
        return ""
    return created.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _account(user: dict[str, Any], roles: list[str]) -> Account:
    return Account.model_validate(
        {
            "sub": people.attribute(user, "sub"),
            "email": people.attribute(user, "email"),
            "roles": sorted(r for r in roles if r in ROLE_NAMES),
            "status": _status(user),
            "created": _created(user),
        }
    )


def _person(c: Clients, env: Env, sub: str | None) -> dict[str, Any]:
    """The account whose id is in the path, or a 400 or 404."""
    if sub is None or not people.SUB.fullmatch(sub):
        raise Refused(400, f"not a user id: {sub!r}")
    user = people.find(c.cognito, env.user_pool_id, sub)
    if user is None:
        raise Refused(404, f"no account {sub}")
    return user


def _subscribe(c: Clients, env: Env, email: str) -> None:
    """AWS emails the person a link to confirm; until they do, nothing reaches them."""
    c.sns.subscribe(TopicArn=env.admins_topic_arn, Protocol="email", Endpoint=email)


def _unsubscribe(c: Clients, env: Env, email: str) -> None:
    """End the email's confirmed subscriptions to the topic. A pending one has no ARN to end."""
    query: dict[str, Any] = {"TopicArn": env.admins_topic_arn}
    while True:
        page = c.sns.list_subscriptions_by_topic(**query)
        for subscription in page.get("Subscriptions", []):
            arn = str(subscription.get("SubscriptionArn", ""))
            if (
                subscription.get("Protocol") == "email"
                and str(subscription.get("Endpoint", "")).lower() == email.lower()
                and arn.startswith("arn:")
            ):
                c.sns.unsubscribe(SubscriptionArn=arn)
        token = page.get("NextToken")
        if not token:
            return
        query["NextToken"] = token


def list_people(c: Clients, env: Env) -> dict[str, Any]:
    pool = env.user_pool_id
    listed = [
        _account(user, people.groups(c.cognito, pool, user["Username"]))
        for user in people.every(c.cognito, pool)
    ]
    return _answer(200, AccountList(people=listed))


def invite(c: Clients, env: Env, caller: Caller, body: dict[str, Any]) -> dict[str, Any]:
    request = _parse(InviteRequest, body)
    pool = env.user_pool_id
    try:
        user = c.cognito.admin_create_user(
            UserPoolId=pool,
            Username=request.email,
            UserAttributes=[
                {"Name": "email", "Value": request.email},
                {"Name": "email_verified", "Value": "true"},
            ],
            DesiredDeliveryMediums=["EMAIL"],
        )["User"]
    except ClientError as error:
        if error.response["Error"]["Code"] in ("UsernameExistsException", "AliasExistsException"):
            raise Refused(409, "an account with that email already exists") from error
        raise
    for role in request.roles:
        c.cognito.admin_add_user_to_group(
            UserPoolId=pool, Username=user["Username"], GroupName=role
        )
    if ADMIN in request.roles:
        _subscribe(c, env, request.email)
    account = _account(user, list(request.roles))
    put_event(
        c, caller.user, "invited", account.sub, email=account.email, roles=list(account.roles)
    )
    return _answer(201, account)


def set_roles(
    c: Clients, env: Env, caller: Caller, sub: str | None, body: dict[str, Any]
) -> dict[str, Any]:
    request = _parse(RolesRequest, body)
    user = _person(c, env, sub)
    account_sub = people.attribute(user, "sub")
    want: set[str] = set(request.roles)
    if caller.user == account_sub and ADMIN not in want:
        raise Refused(409, "you can't remove your own admin role")
    pool, username = env.user_pool_id, user["Username"]
    before = set(people.groups(c.cognito, pool, username)) & ROLE_NAMES
    for added in sorted(want - before):
        c.cognito.admin_add_user_to_group(UserPoolId=pool, Username=username, GroupName=added)
    for role in sorted(before - want):
        c.cognito.admin_remove_user_from_group(UserPoolId=pool, Username=username, GroupName=role)
    email = people.attribute(user, "email")
    if ADMIN in want - before:
        _subscribe(c, env, email)
    if ADMIN in before - want:
        _unsubscribe(c, env, email)
    if want != before:
        put_event(
            c,
            caller.user,
            "roles-set",
            account_sub,
            email=email,
            before=sorted(before),
            after=sorted(want),
        )
    return _answer(200, _account(user, sorted(want)))


def resend(c: Clients, env: Env, caller: Caller, sub: str | None) -> dict[str, Any]:
    """Email a new temporary password; the account, its id and its roles stay."""
    user = _person(c, env, sub)
    if user.get("UserStatus") != "FORCE_CHANGE_PASSWORD":
        raise Refused(409, "only an invited account that hasn't signed in yet can be sent it again")
    pool, username = env.user_pool_id, user["Username"]
    c.cognito.admin_create_user(
        UserPoolId=pool, Username=username, MessageAction="RESEND", DesiredDeliveryMediums=["EMAIL"]
    )
    account = _account(user, people.groups(c.cognito, pool, username))
    put_event(c, caller.user, "invite-resent", account.sub, email=account.email)
    return _answer(200, account)


def _mark(c: Clients, sub: str, disabled: bool) -> None:
    c.user_profiles.update_item(
        Key={"userId": sub},
        UpdateExpression="SET #d = :d",
        ExpressionAttributeNames={"#d": "disabled"},
        ExpressionAttributeValues={":d": disabled},
    )


def disable(c: Clients, env: Env, caller: Caller, sub: str | None) -> dict[str, Any]:
    """Mark the account, disable it and sign it out everywhere, so its downloads stop at once.
    The mark goes first: if a later step fails, the live token is already refused."""
    user = _person(c, env, sub)
    account_sub = people.attribute(user, "sub")
    if caller.user == account_sub:
        raise Refused(409, "you can't disable yourself")
    pool, username = env.user_pool_id, user["Username"]
    _mark(c, account_sub, True)
    c.cognito.admin_disable_user(UserPoolId=pool, Username=username)
    c.cognito.admin_user_global_sign_out(UserPoolId=pool, Username=username)
    account = _account({**user, "Enabled": False}, people.groups(c.cognito, pool, username))
    put_event(c, caller.user, "disabled", account.sub, email=account.email)
    return _answer(200, account)


def enable(c: Clients, env: Env, caller: Caller, sub: str | None) -> dict[str, Any]:
    user = _person(c, env, sub)
    account_sub = people.attribute(user, "sub")
    if caller.user == account_sub:
        raise Refused(409, "you can't enable yourself")
    pool, username = env.user_pool_id, user["Username"]
    c.cognito.admin_enable_user(UserPoolId=pool, Username=username)
    _mark(c, account_sub, False)
    account = _account({**user, "Enabled": True}, people.groups(c.cognito, pool, username))
    put_event(c, caller.user, "enabled", account.sub, email=account.email)
    return _answer(200, account)


def account_events(c: Clients, query: dict[str, str]) -> dict[str, Any]:
    """The most recent changes to anyone, newest first."""
    raw = query.get("limit")
    limit = DEFAULT_EVENTS
    if raw is not None:
        if not raw.isdigit() or not 1 <= int(raw) <= MAX_EVENTS:
            raise Refused(400, f"limit must be a whole number from 1 to {MAX_EVENTS}")
        limit = int(raw)
    items = c.account_events.query(
        KeyConditionExpression="#k = :k",
        ExpressionAttributeNames={"#k": "subject"},
        ExpressionAttributeValues={":k": EVERYONE},
        ScanIndexForward=False,
        Limit=limit,
    ).get("Items", [])
    return _answer(200, AccountEventList.model_validate({"events": items}))


# Access requests and approvals


def _dataset_id(value: str | None) -> str:
    if value is None or not DATASET_ID.fullmatch(value):
        raise Refused(400, f"not a dataset id: {value!r}")
    return value


def _catalog_meta(c: Clients, env: Env, dataset_id: str) -> dict[str, Any] | None:
    """The dataset's item in the active catalog table, read as the submissions function does."""
    active = c.ssm.get_parameter(Name=env.active_catalog_parameter)["Parameter"]["Value"]
    table = c.table(env.catalog_tables[active])
    item = table.get_item(Key={"PK": f"DATASET#{dataset_id}", "SK": "META"}).get("Item")
    return cast(dict[str, Any] | None, item)


def _access_item(c: Clients, dataset_id: str, user_id: str) -> dict[str, Any] | None:
    item = c.access.get_item(Key={"datasetId": dataset_id, "userId": user_id}).get("Item")
    return cast(dict[str, Any] | None, item)


def state(item: dict[str, Any] | None) -> AccessState:
    """The item's state as of today: an approval past its `until` day has ended."""
    if item is None:
        return "none"
    stored = cast(AccessState, item["state"])
    until = item.get("until")
    if stored == "approved" and until and date.fromisoformat(str(until)) < today():
        return "ended"
    return stored


def _view[M: DatasetAccess](model: type[M], item: dict[str, Any]) -> M:
    return model.model_validate({**item, "state": state(item)})


def _replace(c: Clients, item: dict[str, Any], old: dict[str, Any] | None, *seen: str) -> None:
    """Write `item` only if the stored one is still `old` (in state `seen`, if given)."""
    names: dict[str, str] = {}
    if old is None:
        condition, values = "attribute_not_exists(userId)", {}
    else:
        condition, values = "requestedAt = :at", {":at": old["requestedAt"]}
        if seen:
            condition = f"#s = :seen AND {condition}"
            names = {"#s": "state"}
            values[":seen"] = seen[0]
    extra: dict[str, Any] = {"ExpressionAttributeNames": names} if names else {}
    if values:
        extra["ExpressionAttributeValues"] = values
    try:
        c.access.put_item(Item=item, ConditionExpression=condition, **extra)
    except ClientError as error:
        if _conditional(error):
            raise Refused(409, "the request changed meanwhile; reload and try again") from error
        raise


def _one_line(text: str) -> str:
    return " ".join(text.split())


def _tell_admins(c: Clients, env: Env, item: dict[str, Any]) -> None:
    title = _one_line(str(item["datasetTitle"])) or item["datasetId"]
    subject = f"Access request: {title}"
    if len(subject) > SUBJECT_LENGTH:
        subject = subject[: SUBJECT_LENGTH - 1].rstrip() + "…"
    message = (
        f"{item['email']} asks for access to {title} ({item['datasetId']}).\n\n"
        f"Their reason, in their own words:\n{item['reason']}\n\n"
        "Don't follow links in it; decide from the request under Settings, Access requests,"
        " where you approve or decline it."
    )
    c.sns.publish(TopicArn=env.admins_topic_arn, Subject=subject, Message=message)


def my_access(c: Clients, caller: Caller, dataset_id: str) -> dict[str, Any]:
    item = _access_item(c, dataset_id, caller.user)
    if item is None:
        return _answer(200, DatasetAccess(dataset_id=dataset_id, state="none"))
    return _answer(200, _view(DatasetAccess, item))


def ask(
    c: Clients, env: Env, caller: Caller, dataset_id: str, body: dict[str, Any]
) -> dict[str, Any]:
    request = _parse(AccessRequestBody, body)
    profile = c.user_profiles.get_item(Key={"userId": caller.user}).get("Item") or {}
    if profile.get("disabled") is True:
        raise Refused(403, "your account is disabled")
    meta = _catalog_meta(c, env, dataset_id)
    if meta is None:
        raise Refused(404, f"no dataset {dataset_id}")
    if meta.get("access") != RESTRICTED:
        raise Refused(409, "only a restricted dataset takes access requests")
    old = _access_item(c, dataset_id, caller.user)
    match state(old):
        case "waiting":
            raise Refused(409, "your request is waiting for an admin")
        case "approved":
            raise Refused(409, "you already have access")
    user = people.find(c.cognito, env.user_pool_id, caller.user)
    if user is None:
        raise Refused(403, "no account for this sign-in")
    item = {
        "datasetId": dataset_id,
        "userId": caller.user,
        "email": people.attribute(user, "email"),
        "datasetTitle": str(meta.get("title") or dataset_id),
        "state": "waiting",
        "reason": request.reason,
        "requestedAt": now(),
    }
    _replace(c, item, old)
    try:
        _tell_admins(c, env, item)
    except (BotoCoreError, ClientError):
        # The request is saved and shows in the admins' list; asking again would be refused.
        logger.exception(
            "could not tell the admins of %s's request for %s", caller.user, dataset_id
        )
    put_event(
        c, caller.user, "access-requested", caller.user, datasetId=dataset_id, email=item["email"]
    )
    return _answer(201, _view(DatasetAccess, item))


def _requested(c: Clients, dataset_id: str, sub: str | None) -> dict[str, Any]:
    if sub is None or not people.SUB.fullmatch(sub):
        raise Refused(400, f"not a user id: {sub!r}")
    item = _access_item(c, dataset_id, sub)
    if item is None:
        raise Refused(404, f"no request from {sub} for {dataset_id}")
    return item


def access_requests(c: Clients) -> dict[str, Any]:
    """Every waiting request and every approval, current, ended or taken back.

    A scan: the table holds one item per person and restricted dataset, so it stays small.
    """
    items: list[dict[str, Any]] = []
    query: dict[str, Any] = {}
    while True:
        page = c.access.scan(**query)
        items += [i for i in page.get("Items", []) if i.get("state") != "declined"]
        last = page.get("LastEvaluatedKey")
        if not last:
            break
        query["ExclusiveStartKey"] = last
    items.sort(key=lambda i: str(i.get("requestedAt", "")), reverse=True)
    return _answer(200, AccessRequestList(requests=[_view(AccessRequest, i) for i in items]))


def decide(
    c: Clients, caller: Caller, dataset_id: str, sub: str | None, body: dict[str, Any]
) -> dict[str, Any]:
    decision = _parse(DecisionBody, body)
    old = _requested(c, dataset_id, sub)
    if state(old) != "waiting":
        raise Refused(409, "only a waiting request can be decided")
    if decision.decision == "decline" and decision.until is not None:
        raise Refused(400, "a decline takes no end date")
    if decision.until is not None and decision.until < today():
        raise Refused(400, "the end date has already passed")
    item = {k: v for k, v in old.items() if k not in DECIDED}
    item.update(
        state="approved" if decision.decision == "approve" else "declined",
        decidedBy=caller.user,
        decidedAt=now(),
    )
    if decision.note:
        item["note"] = decision.note
    if decision.until is not None:
        item["until"] = decision.until.isoformat()
    _replace(c, item, old, "waiting")
    details = {k: item[k] for k in ("note", "until") if k in item}
    action: AccountAction = (
        "access-approved" if decision.decision == "approve" else "access-declined"
    )
    put_event(c, caller.user, action, str(item["userId"]), datasetId=dataset_id, **details)
    return _answer(200, _view(AccessRequest, item))


def take_back(c: Clients, caller: Caller, dataset_id: str, sub: str | None) -> dict[str, Any]:
    old = _requested(c, dataset_id, sub)
    if state(old) != "approved":
        raise Refused(409, "only a current approval can be taken back")
    item = {**old, "state": "taken-back", "takenBackBy": caller.user, "takenBackAt": now()}
    _replace(c, item, old, "approved")
    put_event(c, caller.user, "access-taken-back", str(item["userId"]), datasetId=dataset_id)
    return _answer(200, _view(AccessRequest, item))


def _still_admin(c: Clients, env: Env, caller: Caller) -> None:
    """Refuse an admin's token that is older than a disable or a demotion: the token stays valid
    until it expires, so read the mark and the admin group live."""
    profile = c.user_profiles.get_item(Key={"userId": caller.user}).get("Item") or {}
    try:
        people.require_live(
            c.cognito,
            env.user_pool_id,
            caller.user,
            disabled=profile.get("disabled") is True,
            roles={ADMIN},
            refusal="admins only",
        )
    except people.NotAllowed as refused:
        raise Refused(403, str(refused)) from None


def handle(event: dict[str, Any], c: Clients, env: Env) -> dict[str, Any]:
    """Route one API Gateway proxy event by method and resource."""
    claims: dict[str, Any] = event["requestContext"]["authorizer"]["claims"]
    caller = Caller(str(claims["sub"]), frozenset(_groups(claims.get("cognito:groups"))))
    params = event.get("pathParameters") or {}
    sub = params.get("sub")
    query = event.get("queryStringParameters") or {}
    route = (event.get("httpMethod"), event.get("resource"))
    try:
        if str(route[1]).startswith("/api/admin/"):
            caller.need(ADMIN)
            _still_admin(c, env, caller)
        body = json.loads(event.get("body") or "{}")
        if route[0] in ("POST", "PUT") and not isinstance(body, dict):
            raise Refused(400, "the body must be a JSON object")
        match route:
            case ("GET", "/api/admin/people"):
                return list_people(c, env)
            case ("POST", "/api/admin/people"):
                return invite(c, env, caller, body)
            case ("PUT", "/api/admin/people/{sub}/roles"):
                return set_roles(c, env, caller, sub, body)
            case ("POST", "/api/admin/people/{sub}/resend"):
                return resend(c, env, caller, sub)
            case ("POST", "/api/admin/people/{sub}/disable"):
                return disable(c, env, caller, sub)
            case ("POST", "/api/admin/people/{sub}/enable"):
                return enable(c, env, caller, sub)
            case ("GET", "/api/admin/account-events"):
                return account_events(c, query)
            case ("GET", "/api/datasets/{id}/access"):
                return my_access(c, caller, _dataset_id(params.get("id")))
            case ("POST", "/api/datasets/{id}/access-requests"):
                return ask(c, env, caller, _dataset_id(params.get("id")), body)
            case ("GET", "/api/admin/access-requests"):
                return access_requests(c)
            case ("POST", "/api/admin/access-requests/{dataset}/{sub}/decision"):
                return decide(c, caller, _dataset_id(params.get("dataset")), sub, body)
            case ("POST", "/api/admin/access-requests/{dataset}/{sub}/take-back"):
                return take_back(c, caller, _dataset_id(params.get("dataset")), sub)
        return _response(404, {"error": f"no route {route[0]} {route[1]}"})
    except json.JSONDecodeError:
        return _response(400, {"error": "the body must be JSON"})
    except Refused as refused:
        return _response(refused.status, {"error": str(refused)})


def handler(event: dict[str, Any], context: object) -> dict[str, Any]:
    env = Env.from_environ()
    return handle(event, clients(env), env)
