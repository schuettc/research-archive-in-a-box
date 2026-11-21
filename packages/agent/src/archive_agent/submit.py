"""Submitting and reviewing: submit, submissions, submission_files, read_submission_file and
decide.

The request and answer shapes are those of `archive_backend.submissions` (Plan 7).
"""

import base64
import hashlib
import json
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from archive_agent import local, state
from archive_agent.archive import Archive
from archive_agent.errors import ArchiveError, Conflict, LocalError, NotAllowed, Refused
from archive_agent.state import Session
from archive_contract.validate import CHECKSUMS

CONTRIBUTOR = "contributor"
CURATOR = "curator"
DECISIONS = ("approve", "reject", "request-changes")
DATASET_ID = re.compile(r"[A-Za-z0-9_-]{1,200}")
"""The dataset ids the archive's create takes (`archive_backend.submissions.create`)."""
CHUNK = 1024 * 1024
MANIFEST = "datapackage.json"
MANIFEST_CAP = 1024 * 1024
"""The largest manifest read_submission_file answers whole."""
SAMPLE = 64 * 1024
"""How much of any other file read_submission_file asks for: the first 64 KiB."""


def _quote(segment: str) -> str:
    return urllib.parse.quote(segment, safe="")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _file(root: Path, path: str) -> Path:
    pure = PurePosixPath(path)
    target = (root / Path(*pure.parts)).resolve()
    if pure.is_absolute() or ".." in pure.parts or not target.is_relative_to(root):
        raise LocalError(f"{CHECKSUMS} lists {path}, which is outside {root}; nothing was sent.")
    if not target.is_file():
        raise LocalError(f"{CHECKSUMS} lists {path}, but there is no such file; nothing was sent.")
    return target


def _files(root: Path) -> list[dict[str, Any]]:
    """The files in checksums.sha256, then checksums.sha256 itself, with sizes and SHA-256."""
    try:
        text = (root / CHECKSUMS).read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise LocalError(
            f"{root} has no {CHECKSUMS}, so nothing was sent. Call edit_manifest to write it."
        ) from exc
    paths: list[str] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        _, _, path = line.partition("  ")
        if path and path not in paths and path != CHECKSUMS:
            paths.append(path)
    paths.append(CHECKSUMS)
    files = []
    for path in paths:
        target = _file(root, path)
        files.append({"path": path, "size": target.stat().st_size, "sha256": _sha256(target)})
    return files


@dataclass(frozen=True)
class Package:
    """A package folder checked and ready to send: its files, their total size in bytes, the
    archive it goes to and the published dataset it versions, if any."""

    root: Path
    files: list[dict[str, Any]]
    total: int
    archive: str
    version_of: str | None = None


def _dataset_id(root: Path) -> str | None:
    """The manifest's id when the archive takes it as a dataset id, else None."""
    dataset_id = json.loads((root / MANIFEST).read_text(encoding="utf-8")).get("id")
    if isinstance(dataset_id, str) and DATASET_ID.fullmatch(dataset_id):
        return dataset_id
    return None


def _published(session: Session, dataset_id: str | None) -> str | None:
    """The dataset id when the archive has published it, so the submit is its new version."""
    if dataset_id is None:
        return None
    try:
        session.archive().get(f"/api/datasets/{_quote(dataset_id)}")
    except ArchiveError:
        # Not published (404), or not readable now: the dialog says no more than before.
        return None
    return dataset_id


def prepare(session: Session, folder: str) -> Package:
    """Check the folder and list its files with their sizes and SHA-256. Refuses on an error
    finding or a package over the archive's limit. Sends nothing of the person's."""
    # The archive may have changed what it checks since connect; check what it checks now.
    limit = state.refresh_checks(session)
    findings = local.diagnose(session, folder)["findings"]
    errors = sum(1 for f in findings if f.get("severity") == "error")
    if errors:
        noun = "error finding" if errors == 1 else "error findings"
        raise Refused(
            f"The package has {errors} {noun}, so nothing was sent. Call diagnose to see "
            "them, fix them, then submit again."
        )
    root = Path(folder).expanduser().resolve()
    files = _files(root)
    total = sum(int(entry["size"]) for entry in files)
    if limit is not None and total > limit:
        raise Refused(
            f"The package's files total {total:,} bytes, more than the {limit // 1024**3} GiB "
            "this archive takes, so nothing was sent."
        )
    version_of = _published(session, _dataset_id(root))
    return Package(
        root=root, files=files, total=total, archive=session.url(), version_of=version_of
    )


def send(session: Session, package: Package, submission: str | None = None) -> dict[str, Any]:
    """Upload every file of a prepared package and send it to review.

    With no `submission`, a new submission; else the next round of that one. A failure part
    way answers the plain error; nothing is retried.
    """
    root, files = package.root, package.files
    archive = session.archive()
    if submission is None:
        # The manifest's id names the dataset: a published one gets its next version. An id
        # the archive doesn't take as a dataset id is left out; the archive assigns one.
        body: dict[str, Any] = {"files": files}
        dataset_id = _dataset_id(root)
        if dataset_id is not None:
            body["datasetId"] = dataset_id
        started = archive.post("/api/submissions", body, group=CONTRIBUTOR)
    else:
        started = archive.post(
            f"/api/submissions/{_quote(submission)}/uploads", {"files": files}, group=CONTRIBUTOR
        )
    sid = str(started["submissionId"])
    links = {upload["path"]: upload for upload in started.get("uploads", [])}
    for f in files:
        upload = links.get(f["path"])
        if upload is None:
            raise Refused(
                f"The archive gave no upload link for {f['path']}; nothing was submitted."
            )
        # The archive signs each PUT with the file's SHA-256; S3 refuses a file that differs.
        checksum = base64.b64encode(bytes.fromhex(f["sha256"])).decode()
        headers = {**upload.get("headers", {}), "x-amz-checksum-sha256": checksum}
        with (root / f["path"]).open("rb") as stream:
            archive.put(upload["url"], stream, f["size"], headers)
    sent = archive.post(f"/api/submissions/{_quote(sid)}/submit", {}, group=CONTRIBUTOR)
    return {
        "id": sid,
        "round": sent.get("round"),
        "status": sent.get("status"),
        "archive": archive.url,
    }


def submit(session: Session, folder: str, submission: str | None = None) -> dict[str, Any]:
    """Check the folder, upload every file in checksums.sha256 and send it to review."""
    return send(session, prepare(session, folder), submission)


def _report(archive: Archive, link: str) -> tuple[Any, str | None]:
    """The findings report behind its short-lived link, or None and why it can't be read."""
    try:
        return json.loads(archive.fetch(link)), None
    except ArchiveError as exc:
        return None, str(exc)
    except ValueError:
        return None, "The findings report isn't JSON, so it can't be read."


def submissions(session: Session, id: str | None = None, queue: bool = False) -> dict[str, Any]:
    """One submission with its events and findings report, the curator queue, or your own."""
    archive = session.archive()
    if id is not None:
        one: dict[str, Any] = archive.get(f"/api/submissions/{_quote(id)}", signed_in=True)
        if one.get("reportUrl"):
            one["report"], error = _report(archive, str(one["reportUrl"]))
            if error is not None:
                one["report_error"] = error
        return one
    if queue:
        if session.tokens is not None and CURATOR not in session.groups:
            have = ", ".join(f"`{g}`" for g in session.groups) or "no groups"
            raise NotAllowed(
                f"The review queue needs an account in the `{CURATOR}` group; yours has "
                f"{have}. Ask the archive's admin if you should have access."
            )
        found: dict[str, Any] = archive.get(
            "/api/submissions", params={"status": "in-review"}, signed_in=True, group=CURATOR
        )
        rows = found.get("submissions", [])
        # Stale ones first, then the longest waiting.
        rows.sort(key=lambda r: (not r.get("stale"), str(r.get("createdAt", ""))))
        return {"submissions": rows}
    mine: dict[str, Any] = archive.get(
        "/api/submissions", params={"mine": "1"}, signed_in=True, group=CONTRIBUTOR
    )
    return mine


def submission_files(session: Session, id: str) -> dict[str, Any]:
    """The current round's files of a submission in review, each with a five-minute link."""
    try:
        files: dict[str, Any] = session.archive().get(
            f"/api/submissions/{_quote(id)}/files", signed_in=True, group=CURATOR
        )
    except Conflict as exc:
        raise Conflict(
            f"Submission {id} isn't in review, so its files can't be read. Call submissions "
            f"with its id to see where it stands. ({exc})"
        ) from exc
    return files


def _text(data: bytes, cut: bool) -> tuple[str, bool] | None:
    """The bytes as text and whether they were UTF-8, or None when they aren't text (a NUL
    byte). A sample cut in the middle of a character keeps the whole characters before it;
    text in another encoding, such as Latin-1, is read with each character UTF-8 can't
    decode replaced."""
    if b"\x00" in data:
        return None
    try:
        return data.decode("utf-8"), True
    except UnicodeDecodeError as exc:
        if cut and exc.start >= len(data) - 3:
            try:
                return data[: exc.start].decode("utf-8"), True
            except UnicodeDecodeError:
                pass
        return data.decode("utf-8", "replace"), False


def read_submission_file(session: Session, id: str, path: str, rows: int = 20) -> dict[str, Any]:
    """One file of a submission in review: datapackage.json whole, any other file as its first
    `rows` lines, read from at most its first 64 KiB."""
    if rows < 1:
        raise Refused(f"rows is {rows}; give 1 or more.")
    archive = session.archive()
    for attempt in (1, 2):
        listing = submission_files(session, id)
        entry = next((f for f in listing.get("files", []) if f.get("path") == path), None)
        if entry is None:
            raise Refused(
                f"Submission {id}'s current round has no file {path}. Call submission_files "
                "for its paths."
            )
        size = int(entry.get("size", 0))
        whole = path == MANIFEST
        if whole and size > MANIFEST_CAP:
            raise Refused(
                f"Submission {id}'s {MANIFEST} is {size:,} bytes, more than the 1 MiB this tool "
                "reads, so it wasn't read."
            )
        headers = {} if whole else {"Range": f"bytes=0-{SAMPLE - 1}"}
        try:
            data = archive.fetch(str(entry["url"]), headers)
            break
        except NotAllowed:
            # The link lasts five minutes; an expired one gets a fresh list, once.
            if attempt == 2:
                raise
    # A storage that ignores the Range answers the whole file; keep only the sample.
    cut = not whole and (len(data) > SAMPLE or size > SAMPLE)
    read = _text(data[:SAMPLE] if not whole else data, cut)
    if read is None:
        raise Refused(f"Submission {id}'s {path} isn't text, so it can't be read here.")
    text, utf8 = read
    answer = {"id": id, "round": listing.get("round"), "path": path, "size": size, "utf8": utf8}
    if whole:
        return {**answer, "text": text, "cut": False}
    lines = text.splitlines(keepends=True)
    return {**answer, "text": "".join(lines[:rows]), "cut": cut or len(lines) > rows}


def decide(session: Session, id: str, decision: str, note: str) -> dict[str, Any]:
    """Post a curator's decision and note on a submission in review."""
    if decision not in DECISIONS:
        raise Refused(f"{decision!r} isn't a decision; give approve, reject or request-changes.")
    archive = session.archive()
    answer: dict[str, Any] = archive.post(
        f"/api/submissions/{_quote(id)}/decision",
        {"decision": decision, "note": note},
        group=CURATOR,
    )
    return {**answer, "archive": archive.url}
