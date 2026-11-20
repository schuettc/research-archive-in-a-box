import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from archive_contract.config import load_config
from archive_contract.findings import Finding
from archive_contract.profile import Profile, load_profile
from cruise import __version__
from cruise.audit import AuditRow, audit
from cruise.diagnose import Diagnosis, diagnose
from cruise.edit import EditError, edit_package
from cruise.rules import CHECK_FAILED, REGISTRY

HEADINGS = {
    "structure": "Structure",
    "failed": "Checks that could not run (a fault in cruise, not in your package)",
    "find": "Can I find, cite and reuse it?",
    "understand": "Can I understand each column?",
    "trust": "Can I trust the values?",
}


class SelectionError(Exception):
    """A profile or archive config that can't be loaded."""


def _selection(args: argparse.Namespace) -> tuple[list[Profile], list[str]]:
    """The profiles and extra required fields from --config and --profile."""
    try:
        return _load_selection(args)
    except (ValueError, OSError) as exc:
        raise SelectionError(str(exc)) from exc


def _load_selection(args: argparse.Namespace) -> tuple[list[Profile], list[str]]:
    profiles: list[Profile] = []
    required: list[str] = []
    if args.config is not None:
        config = load_config(args.config)
        profiles.extend(config.load_profiles())
        required.extend(config.required)
    profiles.extend(load_profile(name) for name in args.profile)
    return profiles, required


def _group(finding: Finding) -> str:
    if finding.rule_id.endswith(f".{CHECK_FAILED}"):
        return "failed"
    try:
        return REGISTRY.get(finding.rule_id).question
    except KeyError:
        return "structure"


def _target(finding: Finding) -> str:
    target = finding.target
    if target is None:
        return "package"
    if target.resource and target.field:
        return f"{target.resource}.{target.field}"
    return target.resource or target.path or target.field or "package"


def _evidence(finding: Finding) -> str | None:
    evidence = finding.evidence
    if evidence is None:
        return None
    parts: list[str] = []
    if evidence.rows:
        rows = ", ".join(str(r) for r in evidence.rows)
        parts.append(f"rows {rows}")
    if evidence.values:
        parts.append("values " + ", ".join(json.dumps(v) for v in evidence.values))
    if evidence.count is not None:
        parts.append(f"{evidence.count} row{'' if evidence.count == 1 else 's'} in all")
    return "; ".join(parts) or None


def verdict(errors: int, warnings: int, notes: int) -> str:
    if errors:
        return f"blocks publishing ({errors})"
    line = f"publishable, with {warnings} warning{'' if warnings == 1 else 's'}"
    if notes:
        line += f" and {notes} note{'' if notes == 1 else 's'}"
    return line


def counts(findings: list[Finding]) -> tuple[int, int, int]:
    """Errors, warnings and notes."""
    errors = sum(1 for f in findings if f.severity == "error")
    warnings = sum(1 for f in findings if f.severity == "warning")
    return errors, warnings, len(findings) - errors - warnings


def _print_text(result: Diagnosis) -> None:
    print(result.path)
    for group, heading in HEADINGS.items():
        findings = [f for f in result.findings if _group(f) == group]
        if not findings:
            continue
        print(f"\n{heading}")
        for finding in findings:
            print(f"  {finding.severity}  {finding.rule_id}  {_target(finding)}")
            print(f"    {finding.message}")
            evidence = _evidence(finding)
            if evidence:
                print(f"    evidence: {evidence}")
            if finding.suggested_fix:
                print(f"    fix: {finding.suggested_fix}")
    print()
    print(f"Score: {result.score.line() if result.score else 'not scored'}")
    print(f"Verdict: {verdict(*counts(result.findings))}")


def _diagnose(args: argparse.Namespace) -> int:
    profiles, required = _selection(args)
    try:
        result = diagnose(args.folder, profiles, required)
    except ValueError as exc:  # a profile switching on a rule that doesn't exist
        raise SelectionError(str(exc)) from exc
    if args.json:
        data = {
            "validation": result.validation.dump(),
            "quality": result.quality.dump() if result.quality else None,
            "findings": [f.dump() for f in result.findings],
        }
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        _print_text(result)
    return 1 if result.blocking else 0


def _audit_cells(row: AuditRow) -> list[str]:
    score = row.diagnosis.score
    return [
        str(row.path),
        str(row.errors),
        str(row.warnings),
        str(row.notes),
        score.line() if score else "not scored",
        row.top_rule or "",
    ]


def _audit_json(row: AuditRow) -> dict[str, object]:
    result = row.diagnosis
    return {
        "path": str(row.path),
        "errors": row.errors,
        "warnings": row.warnings,
        "notes": row.notes,
        "score": result.score.percent if result.score else None,
        "find": result.quality.find.dump() if result.quality and result.quality.find else None,
        "understand": (
            result.quality.understand.dump()
            if result.quality and result.quality.understand
            else None
        ),
        "trust": result.quality.trust.dump() if result.quality and result.quality.trust else None,
        "topRule": row.top_rule,
        "findings": [f.dump() for f in result.findings],
    }


def _audit(args: argparse.Namespace) -> int:
    profiles, required = _selection(args)
    try:
        rows = audit(args.folders, profiles, required)
    except FileNotFoundError as exc:
        raise SelectionError(str(exc)) from exc
    except ValueError as exc:  # a profile switching on a rule that doesn't exist
        raise SelectionError(str(exc)) from exc
    if args.json:
        print(json.dumps({"packages": [_audit_json(r) for r in rows]}, indent=2))
        return 0
    table = [["path", "errors", "warnings", "notes", "score", "most fired"]]
    table += [_audit_cells(r) for r in rows]
    widths = [max(len(line[i]) for line in table) for i in range(len(table[0]))]
    for line in table:
        print(
            "  ".join(cell.ljust(width) for cell, width in zip(line, widths, strict=True)).rstrip()
        )
    return 0


TEXT_TARGETS = frozenset({"title", "description", "archive:methods", "archive:embargoUntil"})
"""Package targets that only hold text, so their value is never read as JSON."""
TEXT_COLUMN_TARGETS = frozenset({"title", "description", "archive:unit"})


def _value(text: str, *, plain: bool = False) -> Any:
    """A value given on the command line: `null` removes; a plain target takes the text itself,
    any other JSON when it parses, else the text itself."""
    if text == "null":
        return None
    if plain:
        return text
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _edits(args: argparse.Namespace) -> list[Any]:
    """The edits `cruise set` was given: one from its arguments, or a list from --file."""
    if args.file is not None:
        if args.target is not None or args.resource or args.column:
            raise SelectionError("give either --file or a target and value, not both")
        try:
            edits = json.loads(args.file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise SelectionError(f"{args.file} can't be read as JSON: {exc}") from exc
        if not isinstance(edits, list):
            raise SelectionError(f"{args.file} must hold a list of edits")
        return edits
    if args.target is None or args.value is None:
        raise SelectionError("give a target and a value, or --file EDITS.json")
    column = args.resource is not None or args.column is not None
    plain = args.target in (TEXT_COLUMN_TARGETS if column else TEXT_TARGETS)
    edit: dict[str, Any] = {"target": args.target, "value": _value(args.value, plain=plain)}
    if args.resource is not None:
        edit["resource"] = args.resource
    if args.column is not None:
        edit["column"] = args.column
    return [edit]


def _set(args: argparse.Namespace) -> int:
    edits = _edits(args)
    try:
        result = edit_package(args.folder, edits)
    except EditError as exc:
        print(f"cruise: {exc}", file=sys.stderr)
        return 1
    print(f"Set {', '.join(result.fields)}.")
    print(f"Wrote {', '.join(result.written)} in {args.folder}.")
    return 0


def _selection_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="print JSON")
    parser.add_argument(
        "--profile", action="append", default=[], metavar="NAME", help="apply a profile"
    )
    parser.add_argument("--config", type=Path, metavar="FILE", help="the archive config")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cruise")
    parser.add_argument("--version", action="version", version=f"cruise {__version__}")
    commands = parser.add_subparsers(dest="command")
    diagnose_parser = commands.add_parser("diagnose", help="check one package folder")
    diagnose_parser.add_argument("folder", type=Path)
    _selection_options(diagnose_parser)
    diagnose_parser.set_defaults(run=_diagnose)
    audit_parser = commands.add_parser("audit", help="rank every package under some folders")
    audit_parser.add_argument("folders", type=Path, nargs="+", metavar="folder")
    _selection_options(audit_parser)
    audit_parser.set_defaults(run=_audit)
    set_parser = commands.add_parser(
        "set",
        help="set fields in a package's manifest, all or nothing",
        description="Set a manifest field, then rewrite README.md and checksums.sha256. The "
        "value of a text field (title, description, archive:methods, archive:embargoUntil, "
        "or a column's title, description or archive:unit) is taken as "
        "text; any other value is read as JSON when it parses (lists, objects, numbers) and as "
        "text otherwise; null removes the field.",
    )
    set_parser.add_argument("folder", type=Path)
    set_parser.add_argument("target", nargs="?", help="the field, such as title")
    set_parser.add_argument("value", nargs="?", help="its value")
    set_parser.add_argument("--resource", metavar="NAME", help="the resource of a column edit")
    set_parser.add_argument("--column", metavar="NAME", help="the column of a column edit")
    set_parser.add_argument(
        "--file",
        type=Path,
        metavar="EDITS.json",
        help="a JSON list of edits, each {target, value, resource, column}",
    )
    set_parser.set_defaults(run=_set)
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    try:
        code: int = args.run(args)
    except SelectionError as exc:
        print(f"cruise: {exc}", file=sys.stderr)
        return 2
    return code
