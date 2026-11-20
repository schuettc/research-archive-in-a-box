"""What the server remembers: this window's archive and its checks in memory, fixed at first use
or at its own connect; the sign-in tokens in memory only, each with the archive that issued it;
and on disk the default archive for new windows."""

import json
import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from archive_agent.archive import Archive
from archive_agent.errors import ArchiveError, NotAllowed, NotConnected, Refused
from archive_client.signin import AuthConfig, Tokens, sign_in

LIMIT = "maxPackageGiB"


def config_file() -> Path:
    """`archive.json` under `$XDG_CONFIG_HOME/research-archive-in-a-box`, else `~/.config/...`."""
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "research-archive-in-a-box" / "archive.json"


def _saved() -> dict[str, Any]:
    """The saved archive file, or {} when there is none or it can't be read."""
    try:
        document = json.loads(config_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return document if isinstance(document, dict) else {}


def saved() -> tuple[str | None, dict[str, list[str]] | None, int | None]:
    """The default archive's URL, its checks and its package limit in GiB, from one read of the
    saved file; each is None when the file doesn't hold it."""
    document = _saved()
    url = document.get("url")
    return (
        (url if isinstance(url, str) and url else None),
        checks(document.get("checks")),
        limit_gib(document),
    )


def saved_url() -> str | None:
    """The saved archive URL, or None when there is none or the file can't be read."""
    return saved()[0]


def checks(document: object) -> dict[str, list[str]] | None:
    """`/archive-checks.json`'s profiles and required fields, or None when it isn't that."""
    if not isinstance(document, dict):
        return None
    fields = {key: document.get(key) for key in ("profiles", "required")}
    lists: dict[str, list[str]] = {}
    for key, value in fields.items():
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            return None
        lists[key] = list(value)
    return lists


def limit_gib(document: object) -> int | None:
    """`/archive-checks.json`'s `maxPackageGiB`, the most a package's files may total, or None
    when the archive publishes none."""
    value = document.get(LIMIT) if isinstance(document, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def fetch_published(url: str) -> tuple[dict[str, list[str]] | None, int | None]:
    """The profiles and required fields the archive at `url` publishes, and its package limit
    in GiB, each None when it publishes none. An archive deployed before /archive-checks.json
    existed answers 404 (or 403) for it. Unreachable still raises."""
    try:
        document = Archive(url).get("/archive-checks.json")
    except (Refused, NotAllowed):
        return None, None
    return checks(document), limit_gib(document)


def saved_checks() -> dict[str, list[str]] | None:
    """The saved archive's checks, or None when no archive is saved or it publishes none."""
    return saved()[1]


def save_url(
    url: str, archive_checks: dict[str, list[str]] | None = None, limit: int | None = None
) -> Path:
    """Save the archive URL with the checks and the package limit (GiB) it publishes, if any,
    replacing the file whole."""
    document: dict[str, Any] = {"url": url}
    if archive_checks is not None:
        document["checks"] = archive_checks
    if limit is not None:
        document[LIMIT] = limit
    path = config_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=".archive.", delete=False
    ) as stream:
        json.dump(document, stream)
        stream.write("\n")
    os.replace(stream.name, path)
    return path


@dataclass
class Session:
    """One window's state: its archive and that archive's checks, the tokens and the signed-in
    groups, all in memory, and the sign-in to run (a stand-in in tests)."""

    tokens: Tokens | None = None
    sign_in: Callable[[AuthConfig], Tokens] = field(default=sign_in)
    groups: list[str] = field(default_factory=list)
    address: str | None = None
    """This window's archive, fixed at its first use or its own connect."""
    checks: dict[str, list[str]] | None = None
    """The requirement sets that archive publishes, as this window last read them."""
    limit: int | None = None
    """The most a package's files may total there, in GiB, as this window last read it."""

    def known(self) -> str | None:
        """This window's archive, taken with its checks from the saved default in one read when
        the window has none yet. None when nothing is saved: nothing is fixed, and the next call
        looks again."""
        if self.address is None:
            url, archive_checks, limit = saved()
            if url is None:
                return None
            self.address, self.checks, self.limit = url, archive_checks, limit
        return self.address

    def use(
        self, address: str, checks: dict[str, list[str]] | None, limit: int | None = None
    ) -> None:
        """Move this window to another archive, signed out. Only connect calls it."""
        self.address, self.checks, self.limit = address, checks, limit
        self.tokens = None
        self.groups = []

    def url(self) -> str:
        url = self.known()
        if url is None:
            raise NotConnected(
                "No archive is set yet. Ask the person for their archive's web address, then "
                "call connect with it."
            )
        return url

    def archive(self) -> Archive:
        return Archive(self.url(), self.tokens)


def refresh_checks(session: Session) -> int | None:
    """Take the session's archive's current checks and package limit when they changed; keep
    what the session has when the archive can't answer them. The saved file is rewritten only
    while that archive is still the default, so a window on another archive leaves the default
    alone. Answers the limit in bytes, or None when the archive publishes none."""
    url = session.url()
    try:
        current, limit = fetch_published(url)
    except ArchiveError:
        current, limit = None, session.limit
    if current is not None and (current, limit) != (session.checks, session.limit):
        session.checks, session.limit = current, limit
        if saved_url() == session.address:
            save_url(url, current, limit)
    return session.limit * 1024**3 if session.limit is not None else None
