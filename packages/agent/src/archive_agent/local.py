"""The local tools, which need no network: diagnose and edit_manifest.

diagnose reads the checks `connect` saved from the archive, so it matches the archive's ingest.
edit_manifest edits with cruise's own edit code, which `cruise set` uses too.
"""

from pathlib import Path
from typing import Any

from archive_agent import state
from archive_agent.errors import LocalError
from archive_contract.profile import Profile, load_profile
from cruise.cli import counts, verdict
from cruise.diagnose import diagnose as run_diagnose
from cruise.edit import EditError, edit_package

NO_CHECKS = (
    "The archive's own requirements weren't available (no archive is connected, or it doesn't "
    "publish /archive-checks.json), so only the core rules were checked; the archive may ask "
    "for more."
)


def _folder(folder: str) -> Path:
    root = Path(folder).expanduser().resolve()
    if not root.is_dir():
        raise LocalError(f"There is no folder at {root}.")
    return root


def _selection() -> tuple[list[Profile], list[str], dict[str, Any] | None, str | None]:
    """The saved archive's profiles and required fields, loaded as `cruise diagnose --config`
    loads them, which archive's they are, and a note when they fall short of its own check."""
    archive_checks = state.saved_checks()
    url = state.saved_url()
    if archive_checks is None or url is None:
        return [load_profile("core")], [], None, NO_CHECKS
    used = {"archive": url, **archive_checks}
    profiles: list[Profile] = []
    unknown: list[str] = []
    for name in archive_checks["profiles"]:
        try:
            profiles.append(load_profile(name))
        except ValueError:
            unknown.append(name)
    note = None
    if unknown:
        note = (
            f"The archive also checks the profile(s) {', '.join(unknown)}, which this cruise "
            "doesn't know, so they weren't checked; updating the plugin may add them."
        )
    return profiles, archive_checks["required"], used, note


def diagnose(folder: str) -> dict[str, Any]:
    """`cruise diagnose --json` for the folder under the connected archive's checks, plus the
    verdict line cruise prints, which archive's checks were used and, when those checks fell
    short, a note saying so."""
    root = _folder(folder)
    profiles, required, used, note = _selection()
    result = run_diagnose(root, profiles, required)
    answer: dict[str, Any] = {
        "validation": result.validation.dump(),
        "quality": result.quality.dump() if result.quality else None,
        "findings": [f.dump() for f in result.findings],
        "verdict": verdict(*counts(result.findings)),
    }
    if used is not None:
        answer["checks"] = used
    if note is not None:
        answer["note"] = note
    return answer


def edit_manifest(folder: str, edits: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply approved edits through the contract's Manifest, all or none, with cruise's
    `edit_package`: if any edit fails, nothing is written and every failing edit is named.
    Otherwise `datapackage.json`, `README.md` and `checksums.sha256` are each replaced whole.
    """
    try:
        result = edit_package(_folder(folder), list(edits))
    except EditError as exc:
        raise LocalError(str(exc)) from exc
    return {"applied": result.applied, "written": result.written}
