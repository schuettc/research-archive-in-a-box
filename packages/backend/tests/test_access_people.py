import json
import uuid
from datetime import UTC, datetime
from typing import Any, cast

import pytest
from botocore.exceptions import ClientError

from archive_backend import access
from archive_backend.access import Clients, Env
from archive_backend.submissions import Table

TOPIC = "arn:aws:sns:us-east-1:1:Admins"
ENV = Env(
    user_pool_id="pool",
    user_profiles_table="profiles",
    account_events_table="events",
    admins_topic_arn=TOPIC,
    access_table="access",
    active_catalog_parameter="/catalog-active",
    catalog_tables={"A": "catalog-a", "B": "catalog-b"},
)
PEOPLE = "/api/admin/people"
ROLES = "/api/admin/people/{sub}/roles"
RESEND = "/api/admin/people/{sub}/resend"
DISABLE = "/api/admin/people/{sub}/disable"
ENABLE = "/api/admin/people/{sub}/enable"
EVENTS = "/api/admin/account-events"


def _error(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, operation)


class FakeCognito:
    """A pool of users keyed by username, answering the calls the access function makes."""

    PAGE = 2

    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.groups: dict[str, set[str]] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def add(
        self,
        sub: str,
        email: str,
        *groups: str,
        status: str = "CONFIRMED",
        enabled: bool = True,
    ) -> None:
        self.users[email] = {
            "Username": email,
            "Attributes": [{"Name": "sub", "Value": sub}, {"Name": "email", "Value": email}],
            "UserStatus": status,
            "Enabled": enabled,
            "UserCreateDate": datetime(2026, 11, 1, 12, 0, tzinfo=UTC),
        }
        self.groups[email] = set(groups)

    def made(self, name: str) -> list[dict[str, Any]]:
        return [kwargs for call, kwargs in self.calls if call == name]

    def _user(self, username: str) -> dict[str, Any]:
        if username not in self.users:
            raise _error("UserNotFoundException", "AdminGetUser")
        return self.users[username]

    def list_users(self, *, UserPoolId: str, **kwargs: Any) -> dict[str, Any]:
        assert UserPoolId == "pool"
        users = list(self.users.values())
        if "Filter" in kwargs:
            sub = kwargs["Filter"].split('"')[1]
            matching = [u for u in users if u["Attributes"][0]["Value"] == sub]
            return {"Users": [dict(u) for u in matching[: kwargs.get("Limit", 60)]]}
        start = int(kwargs.get("PaginationToken", 0))
        page: dict[str, Any] = {"Users": [dict(u) for u in users[start : start + self.PAGE]]}
        if start + self.PAGE < len(users):
            page["PaginationToken"] = str(start + self.PAGE)
        return page

    def admin_list_groups_for_user(self, *, UserPoolId: str, Username: str) -> dict[str, Any]:
        return {"Groups": [{"GroupName": g} for g in sorted(self.groups[Username])]}

    def admin_create_user(self, *, UserPoolId: str, Username: str, **kwargs: Any) -> Any:
        self.calls.append(("admin_create_user", {"Username": Username, **kwargs}))
        if kwargs.get("MessageAction") == "RESEND":
            return {"User": dict(self._user(Username))}
        if Username in self.users:
            raise _error("UsernameExistsException", "AdminCreateUser")
        self.add(str(uuid.uuid4()), Username, status="FORCE_CHANGE_PASSWORD")
        return {"User": dict(self.users[Username])}

    def admin_add_user_to_group(self, *, UserPoolId: str, Username: str, GroupName: str) -> Any:
        self.calls.append(("admin_add_user_to_group", {"Username": Username, "Group": GroupName}))
        self.groups[Username].add(GroupName)

    def admin_remove_user_from_group(
        self, *, UserPoolId: str, Username: str, GroupName: str
    ) -> Any:
        self.calls.append(
            ("admin_remove_user_from_group", {"Username": Username, "Group": GroupName})
        )
        self.groups[Username].discard(GroupName)

    def admin_disable_user(self, *, UserPoolId: str, Username: str) -> Any:
        self.calls.append(("admin_disable_user", {"Username": Username}))
        self._user(Username)["Enabled"] = False

    def admin_enable_user(self, *, UserPoolId: str, Username: str) -> Any:
        self.calls.append(("admin_enable_user", {"Username": Username}))
        self._user(Username)["Enabled"] = True

    def admin_user_global_sign_out(self, *, UserPoolId: str, Username: str) -> Any:
        self.calls.append(("admin_user_global_sign_out", {"Username": Username}))


class FakeSNS:
    """The Admins topic's subscriptions, listed a page at a time."""

    def __init__(self) -> None:
        self.subscriptions: list[dict[str, str]] = []
        self.unsubscribed: list[str] = []

    def confirmed(self, email: str) -> str:
        arn = f"{TOPIC}:{uuid.uuid4()}"
        self.subscriptions.append({"SubscriptionArn": arn, "Protocol": "email", "Endpoint": email})
        return arn

    def subscribe(self, *, TopicArn: str, Protocol: str, Endpoint: str, **_: Any) -> Any:
        assert TopicArn == TOPIC
        self.subscriptions.append(
            {"SubscriptionArn": "PendingConfirmation", "Protocol": Protocol, "Endpoint": Endpoint}
        )
        return {"SubscriptionArn": "pending confirmation"}

    def list_subscriptions_by_topic(self, *, TopicArn: str, **kwargs: Any) -> dict[str, Any]:
        assert TopicArn == TOPIC
        start = int(kwargs.get("NextToken", 0))
        page: dict[str, Any] = {"Subscriptions": self.subscriptions[start : start + 1]}
        if start + 1 < len(self.subscriptions):
            page["NextToken"] = str(start + 1)
        return page

    def unsubscribe(self, *, SubscriptionArn: str) -> Any:
        self.unsubscribed.append(SubscriptionArn)
        self.subscriptions = [
            s for s in self.subscriptions if s["SubscriptionArn"] != SubscriptionArn
        ]

    def emails(self) -> list[str]:
        return [s["Endpoint"] for s in self.subscriptions]


class FakeTable:
    def __init__(self, key: tuple[str, ...]) -> None:
        self.key = key
        self.items: dict[tuple[Any, ...], dict[str, Any]] = {}

    def get_item(self, *, Key: dict[str, Any]) -> dict[str, Any]:
        item = self.items.get(tuple(Key[k] for k in self.key))
        return {"Item": dict(item)} if item is not None else {}

    def put_item(self, *, Item: dict[str, Any]) -> Any:
        self.items[tuple(Item[k] for k in self.key)] = dict(Item)

    def update_item(self, *, Key: dict[str, Any], UpdateExpression: str, **kwargs: Any) -> Any:
        item = self.items.setdefault(tuple(Key[k] for k in self.key), dict(Key))
        assert UpdateExpression.startswith("SET ")
        for assignment in UpdateExpression[4:].split(","):
            name, value = (part.strip() for part in assignment.split("="))
            item[kwargs["ExpressionAttributeNames"][name]] = kwargs["ExpressionAttributeValues"][
                value
            ]

    def query(self, **kwargs: Any) -> dict[str, Any]:
        wanted = kwargs["ExpressionAttributeValues"][":k"]
        found = sorted(
            (dict(i) for i in self.items.values() if i[self.key[0]] == wanted),
            key=lambda i: str(i[self.key[1]]),
            reverse=not kwargs.get("ScanIndexForward", True),
        )
        return {"Items": found[: kwargs.get("Limit", len(found))]}


class World:
    def __init__(self) -> None:
        self.cognito = FakeCognito()
        self.sns = FakeSNS()
        self.profiles = FakeTable(("userId",))
        self.events = FakeTable(("subject", "eventKey"))
        self.clients = Clients(
            cognito=cast(access.AdminCognito, self.cognito),
            sns=cast(access.SNS, self.sns),
            user_profiles=cast(Table, self.profiles),
            account_events=cast(Table, self.events),
            access=cast(access.ScanTable, FakeTable(("datasetId", "userId"))),
            ssm=cast(access.SSM, None),
            table=lambda name: cast(Table, FakeTable(("PK", "SK"))),
        )
        self.cognito.add("sub-ada", "ada@example.org", "admin")
        self.cognito.add("sub-bob", "bob@example.org", "contributor")

    def call(
        self,
        method: str,
        resource: str,
        user: str = "sub-ada",
        groups: str = "admin",
        body: Any = None,
        sub: str | None = None,
        query: dict[str, str] | None = None,
    ) -> tuple[int, Any]:
        event = {
            "httpMethod": method,
            "resource": resource,
            "pathParameters": {"sub": sub} if sub else None,
            "queryStringParameters": query,
            "body": json.dumps(body) if body is not None else None,
            "requestContext": {"authorizer": {"claims": {"sub": user, "cognito:groups": groups}}},
        }
        response = access.handle(event, self.clients, ENV)
        return response["statusCode"], json.loads(response["body"])

    def recorded(self, subject: str) -> list[dict[str, Any]]:
        return [i for i in self.events.items.values() if i["subject"] == subject]


@pytest.fixture
def world() -> World:
    return World()


ADMIN_ROUTES: list[tuple[str, str, Any]] = [
    ("GET", PEOPLE, None),
    ("POST", PEOPLE, {"email": "new@example.org", "roles": []}),
    ("PUT", ROLES, {"roles": []}),
    ("POST", RESEND, None),
    ("POST", DISABLE, None),
    ("POST", ENABLE, None),
    ("GET", EVENTS, None),
]


@pytest.mark.parametrize(("method", "resource", "body"), ADMIN_ROUTES)
def test_each_route_refuses_a_caller_who_is_not_an_admin(
    world: World, method: str, resource: str, body: Any
) -> None:
    status, answer = world.call(
        method, resource, "sub-bob", "contributor,curator", body, sub="sub-ada"
    )

    assert status == 403, answer
    assert world.cognito.calls == []
    assert world.events.items == {}


@pytest.mark.parametrize(("method", "resource", "body"), ADMIN_ROUTES)
def test_each_route_refuses_a_disabled_admin_whose_token_still_says_admin(
    world: World, method: str, resource: str, body: Any
) -> None:
    world.profiles.put_item(Item={"userId": "sub-ada", "disabled": True})

    status, answer = world.call(method, resource, body=body, sub="sub-bob")

    assert status == 403, answer
    assert world.cognito.calls == []
    assert world.events.items == {}


@pytest.mark.parametrize(("method", "resource", "body"), ADMIN_ROUTES)
def test_each_route_refuses_a_demoted_admin_whose_token_still_says_admin(
    world: World, method: str, resource: str, body: Any
) -> None:
    world.cognito.groups["ada@example.org"] = {"curator"}

    status, answer = world.call(method, resource, body=body, sub="sub-bob")

    assert status == 403, answer
    assert world.cognito.calls == []
    assert world.events.items == {}


def test_list_names_every_account_with_its_roles_status_and_creation(world: World) -> None:
    world.cognito.add("sub-cy", "cy@example.org", status="FORCE_CHANGE_PASSWORD")
    world.cognito.add("sub-di", "di@example.org", status="UNCONFIRMED")
    world.cognito.add("sub-ed", "ed@example.org", "curator", enabled=False)

    status, answer = world.call("GET", PEOPLE)

    assert status == 200, answer
    assert answer["people"] == [
        {
            "sub": "sub-ada",
            "email": "ada@example.org",
            "roles": ["admin"],
            "status": "active",
            "created": "2026-11-01T12:00:00Z",
        },
        {
            "sub": "sub-bob",
            "email": "bob@example.org",
            "roles": ["contributor"],
            "status": "active",
            "created": "2026-11-01T12:00:00Z",
        },
        {
            "sub": "sub-cy",
            "email": "cy@example.org",
            "roles": [],
            "status": "invited",
            "created": "2026-11-01T12:00:00Z",
        },
        {
            "sub": "sub-di",
            "email": "di@example.org",
            "roles": [],
            "status": "signed-up",
            "created": "2026-11-01T12:00:00Z",
        },
        {
            "sub": "sub-ed",
            "email": "ed@example.org",
            "roles": ["curator"],
            "status": "disabled",
            "created": "2026-11-01T12:00:00Z",
        },
    ]


def test_invite_creates_the_account_with_its_roles_and_records_it(world: World) -> None:
    status, answer = world.call(
        "POST", PEOPLE, body={"email": " New@Example.org ", "roles": ["contributor", "curator"]}
    )

    assert status == 201, answer
    assert answer["email"] == "new@example.org"
    assert answer["roles"] == ["contributor", "curator"]
    assert answer["status"] == "invited"
    [create] = world.cognito.made("admin_create_user")
    assert create == {
        "Username": "new@example.org",
        "UserAttributes": [
            {"Name": "email", "Value": "new@example.org"},
            {"Name": "email_verified", "Value": "true"},
        ],
        "DesiredDeliveryMediums": ["EMAIL"],
    }
    assert world.cognito.groups["new@example.org"] == {"contributor", "curator"}
    assert world.sns.subscriptions == []
    for subject in (answer["sub"], "all"):
        [event] = world.recorded(subject)
        assert event["actor"] == "sub-ada"
        assert event["action"] == "invited"
        assert event["userId"] == answer["sub"]
        assert event["details"] == {"email": "new@example.org", "roles": ["contributor", "curator"]}
        assert event["eventKey"].startswith(event["at"] + "#")


def test_inviting_an_admin_subscribes_their_email_to_the_admins_topic(world: World) -> None:
    status, answer = world.call(
        "POST", PEOPLE, body={"email": "boss@example.org", "roles": ["admin"]}
    )

    assert status == 201, answer
    assert world.sns.subscriptions == [
        {
            "SubscriptionArn": "PendingConfirmation",
            "Protocol": "email",
            "Endpoint": "boss@example.org",
        }
    ]


def test_invite_refuses_an_email_that_already_has_an_account(world: World) -> None:
    status, answer = world.call("POST", PEOPLE, body={"email": "bob@example.org", "roles": []})

    assert status == 409, answer
    assert world.events.items == {}


@pytest.mark.parametrize(
    "body",
    [
        {"email": "not an address", "roles": []},
        {"email": "new@example.org", "roles": ["owner"]},
        {"email": "new@example.org", "roles": ["admin", "admin"]},
    ],
)
def test_invite_refuses_a_bad_body(world: World, body: dict[str, Any]) -> None:
    status, answer = world.call("POST", PEOPLE, body=body)

    assert status == 400, answer
    assert world.cognito.calls == []


def test_set_roles_makes_them_exactly_the_list_and_records_the_change(world: World) -> None:
    world.cognito.add("sub-cy", "cy@example.org", "contributor", "curator")

    status, answer = world.call("PUT", ROLES, body={"roles": ["curator", "admin"]}, sub="sub-cy")

    assert status == 200, answer
    assert answer["roles"] == ["admin", "curator"]
    assert world.cognito.groups["cy@example.org"] == {"curator", "admin"}
    assert world.sns.emails() == ["cy@example.org"]
    for subject in ("sub-cy", "all"):
        [event] = world.recorded(subject)
        assert event["action"] == "roles-set"
        assert event["details"] == {
            "email": "cy@example.org",
            "before": ["contributor", "curator"],
            "after": ["admin", "curator"],
        }


def test_removing_the_admin_role_unsubscribes_that_email_only(world: World) -> None:
    world.cognito.add("sub-cy", "cy@example.org", "admin")
    world.sns.confirmed("ada@example.org")
    cy = world.sns.confirmed("cy@example.org")

    status, answer = world.call("PUT", ROLES, body={"roles": ["curator"]}, sub="sub-cy")

    assert status == 200, answer
    assert world.sns.unsubscribed == [cy]
    assert world.sns.emails() == ["ada@example.org"]


def test_set_roles_refuses_to_drop_the_callers_own_admin_role(world: World) -> None:
    status, answer = world.call("PUT", ROLES, body={"roles": ["curator"]}, sub="sub-ada")

    assert status == 409, answer
    assert world.cognito.groups["ada@example.org"] == {"admin"}
    assert world.cognito.calls == []
    assert world.events.items == {}


def test_set_roles_answers_404_for_an_unknown_account_and_400_for_a_bad_id(world: World) -> None:
    assert world.call("PUT", ROLES, body={"roles": []}, sub="sub-nobody")[0] == 404
    assert world.call("PUT", ROLES, body={"roles": []}, sub='x" or sub = "y')[0] == 400


def test_resend_sends_the_invite_again_and_keeps_the_account(world: World) -> None:
    world.cognito.add("sub-cy", "cy@example.org", "contributor", status="FORCE_CHANGE_PASSWORD")

    status, answer = world.call("POST", RESEND, sub="sub-cy")

    assert status == 200, answer
    assert answer["sub"] == "sub-cy"
    assert world.cognito.made("admin_create_user") == [
        {
            "Username": "cy@example.org",
            "MessageAction": "RESEND",
            "DesiredDeliveryMediums": ["EMAIL"],
        }
    ]
    [event] = world.recorded("all")
    assert event["action"] == "invite-resent"


def test_resend_refuses_an_account_that_has_signed_in(world: World) -> None:
    status, answer = world.call("POST", RESEND, sub="sub-bob")

    assert status == 409, answer
    assert world.cognito.calls == []


def test_disable_disables_signs_out_and_marks_the_profile(world: World) -> None:
    status, answer = world.call("POST", DISABLE, sub="sub-bob")

    assert status == 200, answer
    assert answer["status"] == "disabled"
    assert [call for call, _ in world.cognito.calls] == [
        "admin_disable_user",
        "admin_user_global_sign_out",
    ]
    assert world.profiles.items[("sub-bob",)]["disabled"] is True
    [event] = world.recorded("sub-bob")
    assert event["action"] == "disabled"
    assert event["details"] == {"email": "bob@example.org"}


def test_disable_marks_the_profile_before_disabling_the_account(world: World) -> None:
    marked: list[bool] = []
    disable_user = world.cognito.admin_disable_user

    def disable_after_the_mark(**kwargs: Any) -> Any:
        marked.append(world.profiles.items.get(("sub-bob",), {}).get("disabled") is True)
        return disable_user(**kwargs)

    world.cognito.admin_disable_user = disable_after_the_mark  # type: ignore[method-assign]

    status, answer = world.call("POST", DISABLE, sub="sub-bob")

    assert status == 200, answer
    assert marked == [True]


def test_disable_refuses_the_caller_themselves(world: World) -> None:
    status, answer = world.call("POST", DISABLE, sub="sub-ada")

    assert status == 409, answer
    assert world.cognito.calls == []
    assert world.profiles.items == {}


def test_enable_refuses_the_caller_themselves(world: World) -> None:
    status, answer = world.call("POST", ENABLE, sub="sub-ada")

    assert status == 409, answer
    assert world.cognito.calls == []
    assert world.profiles.items == {}


def test_enable_enables_the_account_and_clears_the_mark(world: World) -> None:
    world.cognito.add("sub-cy", "cy@example.org", enabled=False)
    world.profiles.put_item(Item={"userId": "sub-cy", "disabled": True, "other": "kept"})

    status, answer = world.call("POST", ENABLE, sub="sub-cy")

    assert status == 200, answer
    assert answer["status"] == "active"
    assert world.cognito.made("admin_enable_user") == [{"Username": "cy@example.org"}]
    assert world.profiles.items[("sub-cy",)] == {
        "userId": "sub-cy",
        "disabled": False,
        "other": "kept",
    }
    [event] = world.recorded("all")
    assert event["action"] == "enabled"


def test_account_events_are_the_recent_changes_newest_first(world: World) -> None:
    world.call("POST", DISABLE, sub="sub-bob")
    world.call("POST", ENABLE, sub="sub-bob")
    world.call("PUT", ROLES, body={"roles": ["curator"]}, sub="sub-bob")

    status, answer = world.call("GET", EVENTS, query={"limit": "2"})

    assert status == 200, answer
    assert [e["action"] for e in answer["events"]] == ["roles-set", "enabled"]
    assert answer["events"][0]["userId"] == "sub-bob"
    assert set(answer["events"][0]) == {"actor", "action", "userId", "details", "at"}
    assert [e["action"] for e in world.call("GET", EVENTS)[1]["events"]] == [
        "roles-set",
        "enabled",
        "disabled",
    ]


@pytest.mark.parametrize("limit", ["0", "201", "many"])
def test_account_events_refuse_a_bad_limit(world: World, limit: str) -> None:
    assert world.call("GET", EVENTS, query={"limit": limit})[0] == 400
