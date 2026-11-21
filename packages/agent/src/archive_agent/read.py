"""Finding and fetching data: search, get_dataset and download."""

import hashlib
import os
import tempfile
import urllib.parse
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic import ValidationError

from archive_agent.errors import LocalError, Refused
from archive_agent.state import Session
from archive_contract.exports.readme import citation
from archive_contract.manifest import Manifest
from archive_contract.validate import is_hidden


def search(
    session: Session,
    q: str | None = None,
    access: list[str] | None = None,
    license: list[str] | None = None,
    format: list[str] | None = None,
    project: list[str] | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    bbox: list[float] | None = None,
    page: int | None = None,
    size: int | None = None,
) -> dict[str, Any]:
    """One page of matching datasets: rows, total and a count per facet value."""
    if bbox is not None and len(bbox) != 4:
        raise Refused("bbox is four numbers: west, south, east, north.")
    params = {
        "q": q,
        "access": access,
        "license": license,
        "format": format,
        "project": project,
        "from": from_date,
        "to": to_date,
        "bbox": ",".join(str(v) for v in bbox) if bbox is not None else None,
        "page": page,
        "size": size,
    }
    archive = session.archive()
    answer: dict[str, Any] = archive.get("/api/search", params=params)
    return {**answer, "archive": archive.url}


def _quote(segment: str) -> str:
    return urllib.parse.quote(segment, safe="")


def _citation(manifest: dict[str, Any]) -> str | None:
    try:
        return citation(Manifest.model_validate(manifest))
    except ValidationError:
        return None


def get_dataset(session: Session, id: str, version: int | None = None) -> dict[str, Any]:
    """The dataset, one version's manifest and files (the current one by default), a citation."""
    archive = session.archive()
    dataset: dict[str, Any] = archive.get(f"/api/datasets/{_quote(id)}")
    if version is None or version == dataset.get("currentVersion"):
        number = dataset.get("currentVersion")
        manifest, files = dataset.get("manifest", {}), dataset.get("files", [])
    else:
        found: dict[str, Any] = archive.get(f"/api/datasets/{_quote(id)}/versions/{version}")
        number, manifest, files = found.get("version"), found.get("manifest", {}), found["files"]
    return {
        "id": dataset.get("id", id),
        "title": dataset.get("title"),
        "access": dataset.get("access"),
        "project": dataset.get("project"),
        "currentVersion": dataset.get("currentVersion"),
        "version": number,
        "manifest": manifest,
        "files": files,
        "citation": _citation(manifest),
    }


AGENT_FILES = ("CLAUDE.md", "CLAUDE.local.md", "AGENTS.md")
"""File names a coding agent reads as instructions. download never writes one, at any depth,
whatever the letters' case."""

HIDDEN = (
    "its name has a part that starts with a dot, and download never writes hidden files or folders"
)
AGENT_FILE = (
    "download never writes a file named CLAUDE.md, CLAUDE.local.md or AGENTS.md; "
    "get it from the dataset's page in a browser if you want it"
)
EXISTS = "a file is already there; call download again with overwrite set to true to replace it"


def _folder(to: str) -> Path:
    """The folder to write under. One inside a hidden folder (`.claude`, `.git/hooks`) is refused,
    since a plain name such as `settings.json` would become that tool's own file there. The
    parts are judged below the working folder when `to` is inside it, so a project kept under a
    hidden folder can still be downloaded into."""
    root = Path(to).expanduser().resolve()
    here = Path.cwd().resolve()
    below = root.relative_to(here) if root.is_relative_to(here) else root
    if any(part.startswith(".") for part in below.parts):
        raise LocalError(
            f"{root} is, or is inside, a hidden folder (one whose name starts with a dot), and "
            "download never writes there, so nothing was downloaded. Choose another folder."
        )
    return root


def _target(root: Path, path: str) -> Path:
    pure = PurePosixPath(path)
    target = (root / Path(*pure.parts)).resolve() if pure.parts else root
    if pure.is_absolute() or "\\" in path or ".." in pure.parts or not target.is_relative_to(root):
        raise LocalError(f"{path} would be written outside {root}, so nothing was downloaded.")
    return target


def _write(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".download.", delete=False) as out:
        out.write(data)
    os.replace(out.name, target)


def download(
    session: Session, id: str, version: int, paths: list[str], to: str, overwrite: bool = False
) -> dict[str, Any]:
    """Write the named files of one version under `to`, each checked against its SHA-256.

    Open files come from `/data/...`; restricted ones through the signed-in link route. A file
    whose hash doesn't match is not kept and is listed under `failed`. A file with no SHA-256
    of its own (none recorded, or one shared by several files) is written and listed under
    `not_checked`. A hidden name, an agent instruction file and, unless `overwrite` is set, a
    file already there are not fetched and are listed under `skipped` with the reason; a file
    that was there and was written over is listed under `replaced`.
    """
    root = _folder(to)
    targets = {path: _target(root, path) for path in paths}
    archive = session.archive()
    found: dict[str, Any] = archive.get(f"/api/datasets/{_quote(id)}/versions/{version}")
    items = {item["path"]: item for item in found.get("files", [])}
    missing = [path for path in paths if path not in items]
    if missing:
        raise Refused(f"Version {version} of {id} has no file {', '.join(missing)}.")
    is_open = found.get("prefix") == "open"
    # A multi-file resource's one hash is stamped on every part of it, so a hash several
    # files share checks none of them (as the contract's validate skips it).
    hashes = Counter(item.get("hash") for item in items.values() if item.get("hash"))
    agent_files = {name.casefold() for name in AGENT_FILES}
    skipped: list[dict[str, str]] = []
    wanted: dict[str, Path] = {}
    existing: list[str] = []
    for path, target in targets.items():
        # A link already in the folder can lead a name somewhere else, so the place the file
        # would land is judged as well as the name the archive gave.
        landing = target.relative_to(root).as_posix()
        if is_hidden(path) or is_hidden(landing):
            skipped.append({"path": path, "reason": HIDDEN})
        elif {PurePosixPath(path).name.casefold(), target.name.casefold()} & agent_files:
            skipped.append({"path": path, "reason": AGENT_FILE})
        elif target.exists() and not overwrite:
            skipped.append({"path": path, "reason": EXISTS})
        else:
            wanted[path] = target
            if target.exists():
                existing.append(path)
    written: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    for path, target in wanted.items():
        if is_open:
            data = archive.fetch(f"/data/{_quote(id)}/{version}/{urllib.parse.quote(path)}")
        else:
            link: dict[str, Any] = archive.get(
                f"/api/datasets/{_quote(id)}/versions/{version}/download",
                params={"path": path},
                signed_in=True,
            )
            data = archive.fetch(link["url"])
        recorded = items[path].get("hash")
        checked = (
            isinstance(recorded, str)
            and recorded.lower().startswith("sha256:")
            and hashes[recorded] == 1
        )
        if checked:
            actual = "sha256:" + hashlib.sha256(data).hexdigest()
            if actual != str(recorded).lower():
                failed.append({"path": path, "reason": f"its hash is {actual}, not {recorded}"})
                continue
        _write(target, data)
        written.append({"path": path, "to": str(target), "bytes": len(data), "checked": checked})
    not_checked = [w["path"] for w in written if not w["checked"]]
    done = {w["path"] for w in written}
    return {
        "written": written,
        "failed": failed,
        "not_checked": not_checked,
        "skipped": skipped,
        "replaced": [path for path in existing if path in done],
    }
