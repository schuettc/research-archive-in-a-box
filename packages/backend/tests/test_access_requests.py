import json
import re
from datetime import date
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
MINE = "/api/datasets/{id}/access"
ASK = "/api/datasets/{id}/access-requests"
LIST = "/api/admin/access-requests"
DECIDE = "/api/admin/access-requests/{dataset}/{sub}/decision"
TAKE_BACK = "/api/admin/access-requests/{dataset}/{sub}/take-back"
MOOSE = "moose-tracking-abcdef"
TODAY = date(2026, 11, 16)


def _failed() -> ClientError:
    code = "ConditionalCheckFailedException"
    return ClientError({"Error": {"Code": code, "Message": code}}, "PutItem")


class FakeCognito:
    def __init__(self) -> None:
        self.emails = {"sub-ada": "ada@example.org", "sub-bob": "bob@example.org"}

    def list_users(self, *, UserPoolId: str, Filter: str, **_: Any) -> dict[str, Any]:
        sub = Filter.split('"')[1]
        if sub not in self.emails:
            return {"Users": []}
        attributes = [{"Name": "sub", "Value": sub}, {"Name": "email", "Value": self.emails[sub]}]
        return {"Users": [{"Username": self.emails[sub], "Attributes": attributes}]}

    def admin_list_groups_for_user(self, *, UserPoolId: str, Username: str) -> dict[str, Any]:
        return {"Groups": [{"GroupName": "admin"}] if Username == "ada@example.org" else []}


class FakeSNS:
    def __init__(self) -> None:
        self.published: list[dict[str, Any]] = []

    def publish(self, **kwargs: Any) -> Any:
        self.published.append(kwargs)
        return {"MessageId": "m"}


class FakeSSM:
    def get_parameter(self, *, Name: str) -> dict[str, Any]:
        assert Name == "/catalog-active"
        return {"Parameter": {"Value": "B"}}


def _holds(item: dict[str, Any] | None, condition: str, values: dict[str, Any]) -> bool:
    """The few condition expressions the access function writes with."""
    names = {"#s": "state"}

    def clause(text: str) -> bool:
        text = text.strip().strip("()")
        if text.startswith("attribute_not_exists("):
            return item is None
        name, value = (part.strip() for part in text.split("="))
        return item is not None and item.get(names.get(name, name)) == values[value]

    return any(
        all(clause(part) for part in alternative.split(" AND "))
        for alternative in condition.split(" OR ")
    )


class FakeTable:
    def __init__(self, key: tuple[str, ...]) -> None:
        self.key = key
        self.items: dict[tuple[Any, ...], dict[str, Any]] = {}
        self.scanned = 0

    def _key(self, item: dict[str, Any]) -> tuple[Any, ...]:
        return tuple(item[k] for k in self.key)

    def get_item(self, *, Key: dict[str, Any], **_: Any) -> dict[str, Any]:
        item = self.items.get(self._key(Key))
        return {"Item": dict(item)} if item is not None else {}

    def put_item(self, *, Item: dict[str, Any], **kwargs: Any) -> Any:
        if "ConditionExpression" in kwargs:
            old = self.items.get(self._key(Item))
            if not _holds(
                old, kwargs["ConditionExpression"], kwargs.get("ExpressionAttributeValues", {})
            ):
                raise _failed()
        self.items[self._key(Item)] = dict(Item)

    def update_item(self, **kwargs: Any) -> Any:
        raise AssertionError("not used")

    def query(self, **kwargs: Any) -> dict[str, Any]:
        raise AssertionError("not used")

    def scan(self, **kwargs: Any) -> dict[str, Any]:
        # One item a page, so the function has to follow the pages.
        self.scanned += 1
        items = list(self.items.values())
        start = int(kwargs.get("ExclusiveStartKey", {}).get("n", 0))
        page: dict[str, Any] = {"Items": [dict(i) for i in items[start : start + 1]]}
        if start + 1 < len(items):
            page["LastEvaluatedKey"] = {"n": start + 1}
        return page


def _dataset(dataset_id: str, title: str, level: str) -> dict[str, Any]:
    return {
        "PK": f"DATASET#{dataset_id}",
        "SK": "META",
        "title": title,
        "access": level,
        "currentVersion": 1,
    }


class World:
    def __init__(self) -> None:
        self.cognito = FakeCognito()
        self.sns = FakeSNS()
        self.profiles = FakeTable(("userId",))
        self.events = FakeTable(("subject", "eventKey"))
        self.access = FakeTable(("datasetId", "userId"))
        self.catalog = FakeTable(("PK", "SK"))
        self.catalog.put_item(Item=_dataset(MOOSE, "Moose tracking", "restricted"))
        self.catalog.put_item(Item=_dataset("deer-counts-ghijkl", "Deer counts", "limited"))
        catalogs = {"catalog-b": self.catalog, "catalog-a": FakeTable(("PK", "SK"))}
        self.clients = Clients(
            cognito=cast(access.AdminCognito, self.cognito),
            sns=cast(access.SNS, self.sns),
            user_profiles=cast(Table, self.profiles),
            account_events=cast(Table, self.events),
            access=cast(access.ScanTable, self.access),
            ssm=cast(access.SSM, FakeSSM()),
            table=lambda name: cast(Table, catalogs[name]),
        )

    def call(
        self,
        method: str,
        resource: str,
        user: str = "sub-bob",
        groups: str = "",
        body: Any = None,
        dataset: str = MOOSE,
        sub: str | None = None,
    ) -> tuple[int, Any]:
        params = {"id": dataset} if "{id}" in resource else {"dataset": dataset, "sub": sub}
        event = {
            "httpMethod": method,
            "resource": resource,
            "pathParameters": params,
            "queryStringParameters": None,
            "body": json.dumps(body) if body is not None else None,
            "requestContext": {"authorizer": {"claims": {"sub": user, "cognito:groups": groups}}},
        }
        response = access.handle(event, self.clients, ENV)
        return response["statusCode"], json.loads(response["body"])

    def ask(self, reason: str = "For my thesis on winter range.") -> tuple[int, Any]:
        return self.call("POST", ASK, body={"reason": reason})

    def decide(self, body: dict[str, Any], user: str = "sub-bob") -> tuple[int, Any]:
        return self.call("POST", DECIDE, "sub-ada", "admin", body, sub=user)

    def take_back(self, user: str = "sub-bob") -> tuple[int, Any]:
        return self.call("POST", TAKE_BACK, "sub-ada", "admin", sub=user)

    def mine(self) -> dict[str, Any]:
        status, answer = self.call("GET", MINE)
        assert status == 200, answer
        return cast(dict[str, Any], answer)

    def item(self, user: str = "sub-bob") -> dict[str, Any]:
        return self.access.items[(MOOSE, user)]

    def recorded(self, subject: str) -> list[dict[str, Any]]:
        found = [i for i in self.events.items.values() if i["subject"] == subject]
        return sorted(found, key=lambda i: str(i["eventKey"]))


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> World:
    monkeypatch.setattr(access, "today", lambda: TODAY)
    return World()


def test_a_person_who_never_asked_has_no_request(world: World) -> None:
    assert world.mine() == {"datasetId": MOOSE, "state": "none"}


def test_asking_records_a_waiting_request_and_tells_the_admins(world: World) -> None:
    status, answer = world.ask("  For my thesis on winter range.  ")

    assert status == 201, answer
    assert answer["state"] == "waiting"
    assert answer["reason"] == "For my thesis on winter range."
    item = world.item()
    assert item["state"] == "waiting"
    assert item["email"] == "bob@example.org"
    assert item["datasetTitle"] == "Moose tracking"
    assert world.mine()["state"] == "waiting"
    [message] = world.sns.published
    assert message["TopicArn"] == TOPIC
    assert "Moose tracking" in message["Subject"]
    for part in ("bob@example.org", "Moose tracking", MOOSE, "For my thesis on winter range."):
        assert part in message["Message"]
    [event] = world.recorded("sub-bob")
    assert event["action"] == "access-requested"
    assert event["actor"] == "sub-bob"
    assert event["details"]["datasetId"] == MOOSE
    assert [e["action"] for e in world.recorded("all")] == ["access-requested"]


def test_a_failed_admins_message_is_logged_and_the_saved_request_still_answers_201(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    def publish(**kwargs: Any) -> Any:
        raise ClientError({"Error": {"Code": "Throttled", "Message": "x"}}, "Publish")

    world.sns.publish = publish  # type: ignore[method-assign]

    status, answer = world.ask()

    assert status == 201, answer
    assert world.item()["state"] == "waiting"
    assert [e["action"] for e in world.recorded("all")] == ["access-requested"]
    assert "could not tell the admins" in caplog.text
    status, listed = world.call("GET", LIST, "sub-ada", "admin")
    assert [r["userId"] for r in listed["requests"]] == ["sub-bob"]


def test_the_topic_subject_stays_on_one_short_line(world: World) -> None:
    world.catalog.put_item(Item=_dataset(MOOSE, "A\nvery " + "long " * 40 + "title", "restricted"))

    world.ask()

    subject = world.sns.published[0]["Subject"]
    assert len(subject) <= 100
    assert "\n" not in subject


def test_the_admins_message_labels_the_reason_and_warns_against_its_links(world: World) -> None:
    world.ask("See https://evil.example.org/approve for details.")

    message = world.sns.published[0]["Message"]
    label = message.index("Their reason, in their own words:")
    warning = message.index("Don't follow links in it")
    reason = message.index("https://evil.example.org/approve")
    assert label < reason < warning
    assert "decide from the request under Settings, Access requests" in message


def test_a_disabled_person_cannot_ask(world: World) -> None:
    world.profiles.put_item(Item={"userId": "sub-bob", "disabled": True})

    status, answer = world.ask()

    assert status == 403, answer
    assert world.access.items == {}
    assert world.sns.published == []


def test_only_a_restricted_dataset_takes_requests(world: World) -> None:
    status, answer = world.call("POST", ASK, body={"reason": "x"}, dataset="deer-counts-ghijkl")

    assert status == 409, answer
    assert world.access.items == {}
    assert world.sns.published == []


def test_asking_for_a_dataset_that_does_not_exist_is_404(world: World) -> None:
    status, answer = world.call("POST", ASK, body={"reason": "x"}, dataset="nothing-here")

    assert status == 404, answer


def test_a_dataset_id_that_is_not_one_is_400(world: World) -> None:
    status, answer = world.call("GET", MINE, dataset="DATASET#x")

    assert status == 400, answer


@pytest.mark.parametrize("reason", ["", "   ", "x" * 1001])
def test_the_reason_is_needed_and_at_most_1000_characters(world: World, reason: str) -> None:
    status, answer = world.ask(reason)

    assert status == 400, answer
    assert world.access.items == {}


def test_a_reason_of_1000_characters_is_taken(world: World) -> None:
    status, answer = world.ask("x" * 1000)

    assert status == 201, answer


def test_asking_again_while_a_request_waits_is_refused(world: World) -> None:
    world.ask("first")

    status, answer = world.ask("second")

    assert status == 409, answer
    assert world.item()["reason"] == "first"
    assert len(world.sns.published) == 1


def test_asking_again_while_an_approval_is_current_is_refused(world: World) -> None:
    world.ask()
    world.decide({"decision": "approve"})

    status, answer = world.ask("again")

    assert status == 409, answer
    assert world.item()["state"] == "approved"


def test_approving_without_an_end_lets_the_person_in_until_taken_back(world: World) -> None:
    world.ask()

    status, answer = world.decide({"decision": "approve", "note": "Enjoy."})

    assert status == 200, answer
    assert answer["state"] == "approved"
    item = world.item()
    assert item["state"] == "approved"
    assert item["decidedBy"] == "sub-ada"
    assert "until" not in item
    mine = world.mine()
    assert mine["state"] == "approved"
    assert mine["note"] == "Enjoy."
    assert "until" not in mine
    assert world.recorded("sub-bob")[-1]["action"] == "access-approved"
    assert world.recorded("sub-bob")[-1]["actor"] == "sub-ada"


def test_approving_until_a_date_lasts_through_that_day(world: World, monkeypatch: Any) -> None:
    world.ask()

    status, answer = world.decide({"decision": "approve", "until": "2026-12-31"})

    assert status == 200, answer
    assert world.item()["until"] == "2026-12-31"
    assert world.mine()["until"] == "2026-12-31"
    monkeypatch.setattr(access, "today", lambda: date(2026, 12, 31))
    assert world.mine()["state"] == "approved"
    monkeypatch.setattr(access, "today", lambda: date(2027, 1, 1))
    assert world.mine()["state"] == "ended"


def test_an_end_date_already_past_is_refused(world: World) -> None:
    world.ask()

    status, answer = world.decide({"decision": "approve", "until": "2026-11-15"})

    assert status == 400, answer
    assert world.item()["state"] == "waiting"


def test_an_end_date_of_today_is_taken(world: World) -> None:
    world.ask()

    status, answer = world.decide({"decision": "approve", "until": "2026-11-16"})

    assert status == 200, answer


def test_declining_keeps_the_note_for_the_person(world: World) -> None:
    world.ask()

    status, answer = world.decide({"decision": "decline", "note": "Ask through Audubon VT."})

    assert status == 200, answer
    assert world.item()["state"] == "declined"
    mine = world.mine()
    assert mine["state"] == "declined"
    assert mine["note"] == "Ask through Audubon VT."
    assert world.recorded("sub-bob")[-1]["action"] == "access-declined"


def test_a_decline_takes_no_end_date(world: World) -> None:
    world.ask()

    status, answer = world.decide({"decision": "decline", "until": "2026-12-31"})

    assert status == 400, answer


@pytest.mark.parametrize(
    "body", [{}, {"decision": "maybe"}, {"decision": "approve", "until": "soon"}]
)
def test_a_decision_must_be_approve_or_decline(world: World, body: dict[str, Any]) -> None:
    world.ask()

    status, answer = world.decide(body)

    assert status == 400, answer


def test_a_note_is_at_most_1000_characters(world: World) -> None:
    world.ask()

    status, answer = world.decide({"decision": "decline", "note": "x" * 1001})

    assert status == 400, answer


def test_asking_again_after_a_decline_replaces_the_old_request(world: World) -> None:
    world.ask("first")
    world.decide({"decision": "decline", "note": "No."})

    status, answer = world.ask("second")

    assert status == 201, answer
    item = world.item()
    assert item["state"] == "waiting"
    assert item["reason"] == "second"
    assert "note" not in item
    assert "decidedBy" not in item
    assert len(world.sns.published) == 2


def test_asking_again_after_an_end_replaces_the_old_request(world: World, monkeypatch: Any) -> None:
    world.ask("first")
    world.decide({"decision": "approve", "until": "2026-11-30"})
    monkeypatch.setattr(access, "today", lambda: date(2026, 12, 1))

    status, answer = world.ask("second")

    assert status == 201, answer
    assert world.item()["state"] == "waiting"
    assert "until" not in world.item()


def test_taking_back_an_approval_ends_it(world: World) -> None:
    world.ask()
    world.decide({"decision": "approve"})

    status, answer = world.take_back()

    assert status == 200, answer
    item = world.item()
    assert item["state"] == "taken-back"
    assert item["takenBackBy"] == "sub-ada"
    assert world.mine()["state"] == "taken-back"
    assert world.recorded("sub-bob")[-1]["action"] == "access-taken-back"
    assert [e["action"] for e in world.recorded("all")] == [
        "access-requested",
        "access-approved",
        "access-taken-back",
    ]


def test_asking_again_after_a_take_back_replaces_the_old_request(world: World) -> None:
    world.ask("first")
    world.decide({"decision": "approve"})
    world.take_back()

    status, answer = world.ask("second")

    assert status == 201, answer
    assert world.item()["state"] == "waiting"


def test_only_a_waiting_request_can_be_decided(world: World) -> None:
    world.ask()
    world.decide({"decision": "decline"})

    status, answer = world.decide({"decision": "approve"})

    assert status == 409, answer
    assert world.item()["state"] == "declined"


def test_deciding_a_request_nobody_made_is_404(world: World) -> None:
    status, answer = world.decide({"decision": "approve"})

    assert status == 404, answer
    assert world.access.items == {}


def test_only_a_current_approval_can_be_taken_back(world: World, monkeypatch: Any) -> None:
    world.ask()
    status, answer = world.take_back()
    assert status == 409, answer

    world.decide({"decision": "approve", "until": "2026-11-30"})
    monkeypatch.setattr(access, "today", lambda: date(2026, 12, 1))
    status, answer = world.take_back()
    assert status == 409, answer


def test_a_decision_that_loses_a_race_is_refused(world: World) -> None:
    world.ask()
    real = world.access.get_item

    def stale(**kwargs: Any) -> dict[str, Any]:
        # Read the item as it was, then let someone else decline it first.
        seen = real(**kwargs)
        item = world.access.items[(MOOSE, "sub-bob")]
        world.access.items[(MOOSE, "sub-bob")] = {**item, "state": "declined"}
        return seen

    world.access.get_item = stale  # type: ignore[method-assign]

    status, answer = world.decide({"decision": "approve"})

    assert status == 409, answer
    assert world.item()["state"] == "declined"


def test_the_admin_list_holds_waiting_requests_and_approvals(
    world: World, monkeypatch: Any
) -> None:
    for user, email in (("sub-cy", "cy@example.org"), ("sub-di", "di@example.org")):
        world.cognito.emails[user] = email
    world.cognito.emails["sub-ed"] = "ed@example.org"
    world.cognito.emails["sub-fa"] = "fa@example.org"
    for user in ("sub-bob", "sub-cy", "sub-di", "sub-ed", "sub-fa"):
        world.call("POST", ASK, user, body={"reason": f"from {user}"})
    world.decide({"decision": "approve"}, "sub-cy")
    world.decide({"decision": "approve", "until": "2026-11-20"}, "sub-di")
    world.decide({"decision": "decline"}, "sub-ed")
    world.decide({"decision": "approve"}, "sub-fa")
    world.take_back("sub-fa")
    monkeypatch.setattr(access, "today", lambda: date(2026, 11, 21))

    status, answer = world.call("GET", LIST, "sub-ada", "admin")

    assert status == 200, answer
    states = {r["userId"]: r["state"] for r in answer["requests"]}
    assert states == {
        "sub-bob": "waiting",
        "sub-cy": "approved",
        "sub-di": "ended",
        "sub-fa": "taken-back",
    }
    bob = next(r for r in answer["requests"] if r["userId"] == "sub-bob")
    assert bob["email"] == "bob@example.org"
    assert bob["datasetId"] == MOOSE
    assert bob["datasetTitle"] == "Moose tracking"
    assert bob["reason"] == "from sub-bob"
    assert world.access.scanned > 1


ADMIN_ROUTES: list[tuple[str, str, Any]] = [
    ("GET", LIST, None),
    ("POST", DECIDE, {"decision": "approve"}),
    ("POST", TAKE_BACK, None),
]


@pytest.mark.parametrize(("method", "resource", "body"), ADMIN_ROUTES)
def test_each_admin_route_refuses_a_caller_who_is_not_an_admin(
    world: World, method: str, resource: str, body: Any
) -> None:
    world.ask()
    before = dict(world.item())

    status, answer = world.call(
        method, resource, "sub-cy", "contributor,curator", body, sub="sub-bob"
    )

    assert status == 403, answer
    assert world.item() == before


def test_an_admin_path_with_a_bad_user_id_is_400(world: World) -> None:
    status, answer = world.decide({"decision": "approve"}, user="bad sub!")

    assert status == 400, answer


def test_the_access_routes_are_in_the_openapi_spec() -> None:
    from archive_backend import access_api

    declared, schemas = access_api.paths()

    for path in (MINE, ASK, LIST, DECIDE, TAKE_BACK):
        assert path in declared
    assert "AccessRequestBody" in schemas
    assert "DecisionBody" in schemas
    assert re.search(r"date", json.dumps(schemas["DecisionBody"]))


def test_access_to_a_claim_only_id_is_refused_as_no_dataset(world: World) -> None:
    # A first version being published: the claim, with no currentVersion yet.
    world.catalog.put_item(Item={"PK": "DATASET#stream-abcdef", "SK": "META", "claimedBy": "sub-a"})

    status, answer = world.call("POST", ASK, body={"reason": "x"}, dataset="stream-abcdef")

    assert status == 404, answer
