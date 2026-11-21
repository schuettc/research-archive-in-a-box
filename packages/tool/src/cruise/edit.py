"""Edit a package's manifest, all or nothing, and rewrite what is generated from it.

Both `cruise set` and the plugin's `edit_manifest` tool edit through `edit_package`.
"""

import copy
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from archive_contract import checksums_text
from archive_contract.exports.readme import render_readme
from archive_contract.manifest import Manifest, bare_orcid
from archive_contract.project import Project
from archive_contract.validate import BUILD, CHECKSUMS, MANIFEST, plain_errors

README = "README.md"
PROJECT = "project.json"
"""A package built from an imported record keeps its project record at `_build/project.json`."""

PACKAGE_TARGETS = frozenset(
    {
        "title",
        "description",
        "keywords",
        "licenses",
        "archive:rightsStatus",
        "archive:temporalCoverage",
        "archive:spatialCoverage",
        "archive:methods",
        "archive:embargoUntil",
        "contributors",
    }
)
COLUMN_TARGETS = frozenset({"title", "description", "archive:unit"})


class EditError(Exception):
    """The edits can't be applied, so nothing was written; the message says why."""


@dataclass(frozen=True)
class EditResult:
    applied: int
    fields: list[str]
    """The targets edited, in edit order, a column's written `resource.column.target`."""
    written: list[str]


def _column(document: dict[str, Any], resource: object, column: object) -> dict[str, Any]:
    """The field named `column` in the resource's table schema or vector attributes."""
    if resource is None:
        raise ValueError("a column edit names its resource as well as its column")
    found = next(
        (r for r in document.get("resources", []) if r.get("name") == resource and resource),
        None,
    )
    if found is None:
        raise ValueError(f"there is no resource {resource!r}")
    for key in ("schema", "archive:attributes"):
        schema = found.get(key)
        if not isinstance(schema, dict):
            continue
        for field in schema.get("fields", []):
            if field.get("name") == column:
                result: dict[str, Any] = field
                return result
    raise ValueError(f"resource {resource!r} has no column {column!r}")


def _apply(document: dict[str, Any], edit: object) -> str:
    """Apply one edit to the manifest's JSON form and name the field it edited; raise
    ValueError when it can't be applied."""
    if not isinstance(edit, dict) or "target" not in edit or "value" not in edit:
        raise ValueError("an edit is an object with a target and a value")
    target, value = edit["target"], edit["value"]
    if not isinstance(target, str):
        raise ValueError(f"a target is one name, such as title, not {target!r}")
    name = str(target)
    if "resource" in edit or "column" in edit:
        if target not in COLUMN_TARGETS:
            allowed = ", ".join(sorted(COLUMN_TARGETS))
            raise ValueError(f"a column's {target!r} can't be edited here; only {allowed}")
        owner = _column(document, edit.get("resource"), edit.get("column"))
        name = f"{edit.get('resource')}.{edit.get('column')}.{target}"
    elif target in PACKAGE_TARGETS:
        owner = document
    else:
        allowed = ", ".join(sorted(PACKAGE_TARGETS))
        raise ValueError(f"{target!r} can't be edited here; only {allowed}, or a column's text")
    if value is None:
        owner.pop(target, None)
    else:
        owner[target] = value
    return name


def _bare_orcids(document: dict[str, Any]) -> None:
    """Write each contributor's ORCID iD bare, as the manifest stores it, not as an address."""
    for contributor in document.get("contributors") or []:
        if isinstance(contributor, dict) and isinstance(contributor.get("orcid"), str):
            contributor["orcid"] = bare_orcid(contributor["orcid"])


def _reason(error: Exception) -> str:
    if isinstance(error, ValidationError):
        return plain_errors(error)
    return str(error)


def _replace(target: Path, data: str) -> None:
    """Write `data` to a temporary name beside `target`, then move it into place."""
    try:
        mode = target.stat().st_mode & 0o777
    except FileNotFoundError:
        mode = 0o644
    with tempfile.NamedTemporaryFile(
        dir=target.parent, prefix=f".{target.name}.", delete=False
    ) as out:
        out.write(data.encode("utf-8"))
    os.chmod(out.name, mode)
    os.replace(out.name, target)


def _project(root: Path) -> Project | None:
    path = root / BUILD / PROJECT
    if not path.is_file():
        return None
    try:
        return Project.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (ValueError, ValidationError):
        return None


def edit_package(root: Path, edits: list[Any]) -> EditResult:
    """Apply edits through the contract's Manifest, all or none.

    Every edit is applied and the manifest validated after each; if any fails, nothing is
    written and every failing edit is named. Otherwise `datapackage.json`, `README.md` and
    `checksums.sha256` are each replaced whole.
    """
    path = root / MANIFEST
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        Manifest.model_validate(document)
    except FileNotFoundError as exc:
        raise EditError(f"{root} has no {MANIFEST}.") from exc
    except (ValueError, ValidationError) as exc:
        raise EditError(f"{path} can't be read as a manifest: {_reason(exc)}") from exc
    if not edits:
        raise EditError("No edits were given, so nothing was written.")
    failures: list[str] = []
    fields: list[str] = []
    for number, edit in enumerate(edits, start=1):
        attempt = copy.deepcopy(document)
        try:
            name = _apply(attempt, edit)
            Manifest.model_validate(attempt)
            _bare_orcids(attempt)
        except (ValueError, ValidationError) as exc:
            failures.append(f"edit {number}: {_reason(exc)}")
            continue
        document = attempt
        fields.append(name)
    if failures:
        raise EditError("Nothing was written. " + " ".join(failures))
    # Validated through the model, but the edited document itself is written, so nothing the
    # person didn't approve is normalised. Every file is built before any is written.
    manifest = Manifest.model_validate(document)
    manifest_text = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
    readme_text = render_readme(manifest, _project(root))
    sums = checksums_text(
        root, {MANIFEST: manifest_text.encode("utf-8"), README: readme_text.encode("utf-8")}
    )
    _replace(path, manifest_text)
    _replace(root / README, readme_text)
    _replace(root / CHECKSUMS, sums)
    return EditResult(applied=len(edits), fields=fields, written=[MANIFEST, README, CHECKSUMS])
