"""Cognito lookups: user ids to email addresses, the curators, and every account.

The token carries only the caller's own id and email; events and submissions name people by
their Cognito `sub`. These read the user pool with `ListUsers` (one call per id, filtered on
`sub`, or a page at a time for every account), `ListUsersInGroup` and `AdminListGroupsForUser`.
"""

from __future__ import annotations

import re
from typing import Any, Protocol

MAX_PEOPLE = 50
CURATOR_GROUP = "curator"
# Cognito's subs are UUIDs; anything else could change the filter's meaning.
SUB = re.compile(r"[A-Za-z0-9-]{1,128}")


class Cognito(Protocol):
    def list_users(self, **kwargs: Any) -> dict[str, Any]: ...
    def list_users_in_group(self, **kwargs: Any) -> dict[str, Any]: ...


class Groups(Protocol):
    def list_users(self, **kwargs: Any) -> dict[str, Any]: ...
    def admin_list_groups_for_user(self, **kwargs: Any) -> dict[str, Any]: ...


def _attributes(user: dict[str, Any]) -> dict[str, str]:
    return {a["Name"]: a["Value"] for a in user.get("Attributes", [])}


def attribute(user: dict[str, Any], name: str) -> str:
    """One of a ListUsers or AdminCreateUser user's attributes, or "" when it has none."""
    return _attributes(user).get(name, "")


def find(cognito: Groups, pool: str, sub: str) -> dict[str, Any] | None:
    """The account whose id is `sub` (which must match `SUB`), or None."""
    for user in cognito.list_users(UserPoolId=pool, Filter=f'sub = "{sub}"', Limit=1)["Users"]:
        if attribute(user, "sub") == sub:
            return dict(user)
    return None


def every(cognito: Groups, pool: str) -> list[dict[str, Any]]:
    """Every account in the pool, a page at a time."""
    found: list[dict[str, Any]] = []
    query: dict[str, Any] = {"UserPoolId": pool}
    while True:
        page = cognito.list_users(**query)
        found.extend(page.get("Users", []))
        token = page.get("PaginationToken")
        if not token:
            return found
        query["PaginationToken"] = token


def groups(cognito: Groups, pool: str, username: str) -> list[str]:
    """The groups an account is in, by its Cognito username."""
    names: list[str] = []
    query: dict[str, Any] = {"UserPoolId": pool, "Username": username}
    while True:
        page = cognito.admin_list_groups_for_user(**query)
        names.extend(group["GroupName"] for group in page.get("Groups", []))
        token = page.get("NextToken")
        if not token:
            return names
        query["NextToken"] = token


class NotAllowed(Exception):
    """The caller's token names a role their account no longer has, or is disabled."""


def require_live(
    cognito: Groups, pool: str, sub: str, *, disabled: bool, roles: set[str], refusal: str
) -> None:
    """Refuse a token older than a disable or a demotion: it stays valid until it expires, so
    take the UserProfiles `disabled` mark as read by the caller, and read the account's groups
    live; one of `roles` must be among them. Raise NotAllowed with the reason."""
    if disabled:
        raise NotAllowed("your account is disabled")
    user = find(cognito, pool, sub) if SUB.fullmatch(sub) else None
    if user is None or not roles & set(groups(cognito, pool, user["Username"])):
        raise NotAllowed(refusal)


def emails(cognito: Cognito, pool: str, subs: list[str]) -> dict[str, dict[str, str]]:
    """Each known id's email; an id the pool doesn't know, or without an email, is left out."""
    found: dict[str, dict[str, str]] = {}
    for sub in dict.fromkeys(subs):
        users = cognito.list_users(UserPoolId=pool, Filter=f'sub = "{sub}"', Limit=1)["Users"]
        for user in users:
            attributes = _attributes(user)
            if attributes.get("sub") == sub and "email" in attributes:
                found[sub] = {"email": attributes["email"]}
    return found


def curators(cognito: Cognito, pool: str) -> list[dict[str, str]]:
    """Every member of the curator group, as its id and email."""
    listed: list[dict[str, str]] = []
    query: dict[str, Any] = {"UserPoolId": pool, "GroupName": CURATOR_GROUP}
    while True:
        page = cognito.list_users_in_group(**query)
        for user in page.get("Users", []):
            attributes = _attributes(user)
            if "sub" in attributes:
                listed.append({"sub": attributes["sub"], "email": attributes.get("email", "")})
        token = page.get("NextToken")
        if not token:
            return listed
        query["NextToken"] = token
