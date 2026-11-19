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


def saved() -> tuple[str | None, dict[str, list[str]] | None]:
    """The default archive's URL and its checks, from one read of the saved file; each is None
    when the file doesn't hold it."""
    document = _saved()
    url = document.get("url")
    return (url if isinstance(url, str) and url else None), checks(document.get("checks"))


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


def fetch_checks(url: str) -> dict[str, list[str]] | None:
    """The profiles and required fields the archive at `url` publishes, or None when it
    publishes none. An archive deployed before /archive-checks.json existed answers 404 (or 403)
    for it. Unreachable still raises."""
    try:
        return checks(Archive(url).get("/archive-checks.json"))
    except (Refused, NotAllowed):
        return None


def saved_checks() -> dict[str, list[str]] | None:
    """The saved archive's checks, or None when no archive is saved or it publishes none."""
    return saved()[1]


def save_url(url: str, archive_checks: dict[str, list[str]] | None = None) -> Path:
    """Save the archive URL and the checks it publishes, if any, replacing the file whole."""
    document: dict[str, Any] = {"url": url}
    if archive_checks is not None:
        document["checks"] = archive_checks
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

    def known(self) -> str | None:
        """This window's archive, taken with its checks from the saved default in one read when
        the window has none yet. None when nothing is saved: nothing is fixed, and the next call
        looks again."""
        if self.address is None:
            url, archive_checks = saved()
            if url is None:
                return None
            self.address, self.checks = url, archive_checks
        return self.address

    def use(self, address: str, checks: dict[str, list[str]] | None) -> None:
        """Move this window to another archive, signed out. Only connect calls it."""
        self.address, self.checks = address, checks
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


def refresh_checks(session: Session) -> None:
    """Take the session's archive's current checks when they changed; keep what the session has
    when the archive can't answer them. The saved file is rewritten only while that archive is
    still the default, so a window on another archive leaves the default alone."""
    url = session.url()
    try:
        current = fetch_checks(url)
    except ArchiveError:
        return
    if current is None or current == session.checks:
        return
    session.checks = current
    if saved_url() == session.address:
        save_url(url, current)
