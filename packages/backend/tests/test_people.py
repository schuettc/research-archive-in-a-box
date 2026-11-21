import json
from typing import Any, cast

import pytest

from archive_backend import submissions
from archive_backend.submissions import Clients, Env

ENV = Env(
    submissions_table="submissions",
    reviews_table="reviews",
    settings_table="settings",
    staging_bucket="staging",
    ingest_alias_arn="alias",
    active_catalog_parameter="parameter",
    catalog_tables={"A": "catalog-a", "B": "catalog-b"},
    user_pool_id="pool",
    archive_config_parameter="config",
    user_profiles_table="user-profiles",
)

USERS = {
    "sub-alice": "alice@example.org",
    "sub-carol": "carol@example.org",
    "sub-dave": "dave@example.org",
}
CURATORS = ["sub-carol", "sub-dave"]


def _user(sub: str) -> dict[str, Any]:
    return {
        "Username": sub,
        "Attributes": [{"Name": "sub", "Value": sub}, {"Name": "email", "Value": USERS[sub]}],
    }


class FakeCognito:
    """ListUsers with a `sub = "<id>"` filter, and ListUsersInGroup a page at a time."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        # The caller's id and the groups the pool has for them, set by `call` from the token.
        self.caller = ""
        self.groups: list[str] = []

    def list_users(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("list_users", kwargs))
        assert kwargs["UserPoolId"] == "pool"
        prefix, sub = kwargs["Filter"].split(" = ")
        assert prefix == "sub"
        sub = json.loads(sub)
        if sub == self.caller:
            return {"Users": [{"Username": sub, "Attributes": [{"Name": "sub", "Value": sub}]}]}
        return {"Users": [_user(sub)] if sub in USERS else []}

    def admin_list_groups_for_user(self, **kwargs: Any) -> dict[str, Any]:
        assert (kwargs["UserPoolId"], kwargs["Username"]) == ("pool", self.caller)
        return {"Groups": [{"GroupName": name} for name in self.groups]}

    def list_users_in_group(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("list_users_in_group", kwargs))
        assert (kwargs["UserPoolId"], kwargs["GroupName"]) == ("pool", "curator")
        # One user per page, so the route has to follow NextToken.
        index = int(kwargs.get("NextToken", "0"))
        page: dict[str, Any] = {"Users": [_user(CURATORS[index])]}
        if index + 1 < len(CURATORS):
            page["NextToken"] = str(index + 1)
        return page


class NoProfiles:
    """A profile table with no profile for anyone."""

    def get_item(self, **kwargs: Any) -> dict[str, Any]:
        return {}


@pytest.fixture
def cognito() -> FakeCognito:
    return FakeCognito()


def call(
    cognito: FakeCognito,
    resource: str,
    groups: str,
    subs: list[str] | None = None,
    user: str = "sub-carol",
) -> tuple[int, Any]:
    none = cast(Any, None)
    c = Clients(
        s3=none,
        lambda_=none,
        ssm=none,
        submissions=none,
        reviews=none,
        settings=none,
        table=none,
        cognito=cast(submissions.Cognito, cognito),
        profiles=cast(submissions.Table, NoProfiles()),
    )
    cognito.caller = user
    cognito.groups = [g for g in groups.split(",") if g]
    event = {
        "httpMethod": "GET",
        "resource": resource,
        "pathParameters": None,
        "queryStringParameters": {"sub": subs[-1]} if subs else None,
        "multiValueQueryStringParameters": {"sub": subs} if subs else None,
        "body": None,
        "requestContext": {"authorizer": {"claims": {"sub": user, "cognito:groups": groups}}},
    }
    response = submissions.handle(event, c, ENV)
    # The caller's own lookup comes first; the assertions count only the route's lookups.
    own = ("list_users", {"UserPoolId": "pool", "Filter": f'sub = "{user}"', "Limit": 1})
    if cognito.calls[:1] == [own]:
        del cognito.calls[0]
    return response["statusCode"], json.loads(response["body"])


@pytest.mark.parametrize("groups", ["curator", "admin"])
def test_people_answers_emails_and_leaves_out_an_unknown_id(
    cognito: FakeCognito, groups: str
) -> None:
    status, body = call(cognito, "/api/people", groups, ["sub-alice", "sub-nobody", "sub-dave"])

    assert status == 200, body
    assert body == {
        "people": {
            "sub-alice": {"email": "alice@example.org"},
            "sub-dave": {"email": "dave@example.org"},
        }
    }
    assert [kwargs["Filter"] for _, kwargs in cognito.calls] == [
        'sub = "sub-alice"',
        'sub = "sub-nobody"',
        'sub = "sub-dave"',
    ]


def test_people_is_refused_to_a_contributor(cognito: FakeCognito) -> None:
    status, body = call(cognito, "/api/people", "contributor", ["sub-alice"])

    assert status == 403, body
    assert cognito.calls == []


def test_people_refuses_more_than_50_ids(cognito: FakeCognito) -> None:
    status, body = call(cognito, "/api/people", "curator", [f"sub-{i}" for i in range(51)])

    assert status == 400, body
    assert cognito.calls == []


@pytest.mark.parametrize("sub", ['a" or email ^= "', "a\\b", ""])
def test_people_refuses_an_id_that_could_change_the_filter(cognito: FakeCognito, sub: str) -> None:
    status, body = call(cognito, "/api/people", "curator", [sub])

    assert status == 400, body
    assert cognito.calls == []


def test_people_with_no_ids_answers_nobody(cognito: FakeCognito) -> None:
    status, body = call(cognito, "/api/people", "curator")

    assert (status, body) == (200, {"people": {}})


def test_curators_lists_the_curator_group_to_an_admin(cognito: FakeCognito) -> None:
    status, body = call(cognito, "/api/curators", "admin")

    assert status == 200, body
    assert body == [
        {"sub": "sub-carol", "email": "carol@example.org"},
        {"sub": "sub-dave", "email": "dave@example.org"},
    ]


@pytest.mark.parametrize("groups", ["curator", "contributor", "contributor,curator"])
def test_curators_is_refused_to_anyone_but_an_admin(cognito: FakeCognito, groups: str) -> None:
    status, body = call(cognito, "/api/curators", groups)

    assert status == 403, body
    assert cognito.calls == []


class _Pool:
    """A user pool with one account, in the curator group."""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def list_users(self, **kwargs: Any) -> Any:
        sub = "11111111-2222-3333-4444-555555555555"
        attributes = [{"Name": "sub", "Value": sub}]
        return {"Users": [{"Username": "carol", "Enabled": self.enabled, "Attributes": attributes}]}

    def admin_list_groups_for_user(self, **kwargs: Any) -> Any:
        return {"Groups": [{"GroupName": "curator"}]}


def test_an_account_disabled_in_cognito_itself_is_refused_though_it_keeps_its_group() -> None:
    from archive_backend import people

    sub = "11111111-2222-3333-4444-555555555555"

    def ask(pool: _Pool) -> set[str]:
        return people.require_live(
            cast(Any, pool), "pool", sub, disabled=False, roles={"curator"}, refusal="no"
        )

    assert ask(_Pool(True)) == {"curator"}
    with pytest.raises(people.NotAllowed, match="disabled"):
        ask(_Pool(False))
