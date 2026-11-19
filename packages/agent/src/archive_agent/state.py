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


def refresh_checks(url: str) -> int | None:
    """Save the archive's current checks and package limit when they changed; keep the saved
    ones when the archive can't answer them. Answers the limit in bytes, or None when the
    archive publishes none or can't be reached."""
    try:
        current, limit = fetch_published(url)
    except ArchiveError:
        return None
    if current is not None and (current, limit) != (saved_checks(), saved_limit_gib()):
        save_url(url, current, limit)
    return limit * 1024**3 if limit is not None else None


def saved_checks() -> dict[str, list[str]] | None:
    """The saved archive's checks, or None when no archive is saved or it publishes none."""
    return checks(_saved().get("checks"))


def saved_limit_gib() -> int | None:
    """The saved archive's package limit in GiB, or None when it publishes none."""
    return limit_gib(_saved())


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
