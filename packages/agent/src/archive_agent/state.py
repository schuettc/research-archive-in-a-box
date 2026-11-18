"""What the server remembers: the archive's URL and the checks it publishes on disk, the sign-in
tokens in memory only."""

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


def saved_url() -> str | None:
    """The saved archive URL, or None when there is none or the file can't be read."""
    url = _saved().get("url")
    return url if isinstance(url, str) and url else None


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


def refresh_checks(url: str) -> None:
    """Save the archive's current checks when they changed; keep the saved ones when the
    archive can't answer them."""
    try:
        current = fetch_checks(url)
    except ArchiveError:
        return
    if current is not None and current != saved_checks():
        save_url(url, current)


def saved_checks() -> dict[str, list[str]] | None:
    """The saved archive's checks, or None when no archive is saved or it publishes none."""
    return checks(_saved().get("checks"))


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
    """One server's state: tokens and the signed-in groups in memory, and the sign-in to run
    (a stand-in in tests)."""

    tokens: Tokens | None = None
    sign_in: Callable[[AuthConfig], Tokens] = field(default=sign_in)
    groups: list[str] = field(default_factory=list)

    def url(self) -> str:
        url = saved_url()
        if url is None:
            raise NotConnected(
                "No archive is set yet. Ask the person for their archive's web address, then "
                "call connect with it."
            )
        return url

    def archive(self) -> Archive:
        return Archive(self.url(), self.tokens)
