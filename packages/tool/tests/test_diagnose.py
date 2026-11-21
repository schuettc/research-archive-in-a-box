import hashlib
import json
import re
import shutil
import socket
from pathlib import Path
from typing import Any

import duckdb
import pytest

from archive_contract.findings import Finding
from archive_contract.manifest import CheckCount, Manifest
from archive_contract.profile import load_profile
from archive_contract.resources import Resource
from cruise.diagnose import diagnose, diagnose_manifest
from cruise.rules import CHECK_FAILED, REGISTRY, Context, Outcome, Problem, Registry, failed_id
from cruise.score import completeness
from cruise.tables import UnreadableTable, read_table, select

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"


MESSY = Path(__file__).parent / "fixtures" / "messy-package"
NO_FORMAT = Path(__file__).parents[2] / "contract" / "tests" / "fixtures" / "valid"
"""The contract's valid fixture: its two tables have `.csv` paths and state no format."""


def targets(findings: list[Finding]) -> list[tuple[str, str]]:
    """Each finding as its rule id and target, written `resource.field` or `package`."""
    named = []
    for f in findings:
        target = f.target
        where = f"{target.resource}.{target.field}" if target and target.field else "package"
        named.append((f.rule_id, where))
    return sorted(named)


def planted(gaps: Path) -> list[tuple[str, str]]:
    """The rule and target of each row of a GAPS.md table, once each."""
    rows = re.findall(r"^\|[^|]*\| `([^`]+)` +\| `([^`]+)` +\|$", gaps.read_text(), re.M)
    return sorted(set(rows))


def test_sample_package_gives_exactly_its_four_planted_findings() -> None:
    result = diagnose(SAMPLE)

    assert targets(result.findings) == [
        ("field.codes-undocumented", "logger.qc_flag"),
        ("field.description-missing", "logger.battery_v"),
        ("field.description-repeats-name", "logger.depth_cm"),
        ("values.constant", "logger.logger_model"),
    ]
    assert result.quality is not None and result.quality.errors == 0
    assert result.quality.score is not None


def test_messy_package_gives_exactly_the_findings_its_gaps_list_names() -> None:
    result = diagnose(MESSY, [load_profile("ecology")])

    assert result.structure == []
    assert targets(result.findings) == planted(MESSY / "_build" / "GAPS.md")
    assert result.blocking == 2


def test_diagnose_runs_with_the_network_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket, "socket", refuse)

    assert diagnose(SAMPLE).quality is not None


def test_diagnose_stops_when_the_manifest_cannot_be_read(tmp_path: Path) -> None:
    (tmp_path / "datapackage.json").write_text("{not json", encoding="utf-8")

    result = diagnose(tmp_path)

    assert [f.rule_id for f in result.findings] == ["structure.manifest-invalid"]
    assert result.quality is None


def test_diagnose_reads_no_table_whose_files_failed_the_structure_check(tmp_path: Path) -> None:
    package = tmp_path / "sample"
    shutil.copytree(SAMPLE, package)
    with (package / "data" / "logger.csv").open("a", encoding="utf-8") as stream:
        stream.write("2024-06-02T00:00:00,S1,9.0,0.20,ok,C,TL-100,3.5,30\n")

    result = diagnose(package)

    assert result.structure
    assert result.findings[: len(result.structure)] == result.structure
    codes = next(f for f in result.findings if f.rule_id == "field.codes-undocumented")
    assert codes.evidence is None
    assert not [f for f in result.findings if f.rule_id == "values.unreadable"]


def test_score_is_the_share_of_checks_passed_rounded_down_per_question() -> None:
    registry = Registry()

    @registry.rule("a.find", question="find", scope="package", severity="error")
    def find(ctx: Context) -> Outcome:
        return Outcome([Problem("missing")], 3)

    @registry.rule("a.trust", question="trust", scope="table", severity="warning")
    def trust(ctx: Context) -> Outcome:
        return Outcome([], 0)

    ctx = Context.for_package(Path("."), Manifest())
    score = completeness([rule.run(ctx) for rule in registry.select([])])

    assert score.percent == 66
    assert score.parts == {
        "find": CheckCount(passed=2, applicable=3),
        "understand": CheckCount(passed=0, applicable=0),
        "trust": CheckCount(passed=0, applicable=0),
    }
    assert score.line() == "66% (find 2 of 3, understand 0 of 0, trust 0 of 0)"


def test_messy_package_tables_are_all_readable() -> None:
    manifest = Manifest.model_validate_json((MESSY / "datapackage.json").read_text())

    for resource in manifest.resources:
        read_table(MESSY, resource)


@pytest.mark.parametrize("name", ["t*.csv", "t?.csv", "t[1].csv", "t{1}.csv"])
def test_table_reader_refuses_glob_characters_in_the_path(tmp_path: Path, name: str) -> None:
    (tmp_path / name).write_text("n\n1\n", encoding="utf-8")
    resource = Resource.model_validate(
        {
            "name": "t",
            "path": name,
            "type": "table",
            "format": "csv",
            "schema": {"fields": [{"name": "n"}]},
        }
    )

    with pytest.raises(UnreadableTable, match="glob"):
        read_table(tmp_path, resource)


def test_table_reader_refuses_formats_other_than_csv() -> None:
    resource = Resource.model_validate(
        {"name": "t", "path": "t.xlsx", "type": "table", "format": "xlsx"}
    )

    with pytest.raises(UnreadableTable, match="xlsx"):
        read_table(Path("."), resource)


def test_table_reader_reads_text_with_declared_missing_values_as_null(tmp_path: Path) -> None:
    (tmp_path / "t.csv").write_text("n\n1\nNA\n007\n", encoding="utf-8")
    resource = Resource.model_validate(
        {
            "name": "t",
            "path": "t.csv",
            "type": "table",
            "format": "csv",
            "schema": {"fields": [{"name": "n", "type": "integer"}], "missingValues": ["NA"]},
        }
    )

    relation = read_table(tmp_path, resource)

    assert select(relation, 'SELECT "n" FROM t') == [("1",), (None,), ("007",)]


def _sample_manifest(**changes: Any) -> dict[str, Any]:
    raw: dict[str, Any] = json.loads((SAMPLE / "datapackage.json").read_text())
    logger = next(r for r in raw["resources"] if r["name"] == "logger")
    for name, props in changes.items():
        column = next(f for f in logger["schema"]["fields"] if f["name"] == name)
        for key, value in props.items():
            if value is None:
                column.pop(key, None)
            else:
                column[key] = value
    return raw


def _seen(findings: list[Finding]) -> list[tuple[str, str]]:
    return sorted((f.rule_id, f.message) for f in findings)


def test_manifest_check_answers_the_field_and_package_rules_only() -> None:
    raw = _sample_manifest(timestamp={"description": None})

    findings = diagnose_manifest(Manifest.model_validate(raw))

    assert ("field.description-missing", "logger.timestamp") in targets(findings)
    assert not any(f.rule_id.startswith("values.") for f in findings)


def test_manifest_check_matches_diagnose_on_the_same_manifest(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    shutil.copytree(SAMPLE, package)
    raw = _sample_manifest(timestamp={"description": None})
    body = json.dumps(raw, indent=2).encode()
    (package / "datapackage.json").write_bytes(body)
    sums = package / "checksums.sha256"
    digest = hashlib.sha256(body).hexdigest()
    sums.write_text(
        re.sub(r"^\w+(  datapackage\.json)$", rf"{digest}\1", sums.read_text(), flags=re.M)
    )
    profiles = [load_profile("ecology")]

    full = diagnose(package, profiles, ["archive:funding"])
    assert full.structure == []
    scoped = {r.id for r in REGISTRY if r.scope in ("field", "package")}
    expected = [f for f in full.findings if f.rule_id in scoped]

    found = diagnose_manifest(Manifest.model_validate(raw), profiles, ["archive:funding"])
    assert _seen(found) == _seen(expected)


def test_a_rule_that_fails_becomes_one_blocking_finding_and_the_rest_still_run() -> None:
    registry = Registry()

    @registry.rule("values.broken", question="trust", scope="table", severity="warning")
    def broken(ctx: Context) -> Outcome:
        raise duckdb.BinderException('Binder Error: column "b" must appear\nLINE 1: SELECT')

    @registry.rule("field.fine", question="understand", scope="field", severity="warning")
    def fine(ctx: Context) -> Outcome:
        return Outcome([Problem("still here")], 3)

    result = diagnose(SAMPLE, registry=registry)

    failed = next(f for f in result.findings if f.rule_id == "values.check-failed")
    assert failed.severity == "error" and failed.target is None
    assert failed.message == (
        "The check values.broken could not run on this package, so what it looks at was not "
        "checked. This is a fault in cruise, not a problem in your data: "
        'BinderException: Binder Error: column "b" must appear'
    )
    assert failed.suggested_fix == (
        "Send this message to the archive's maintainers. Every other check's result still stands."
    )
    assert failed.evidence is not None and failed.evidence.values == ["values.broken"]
    assert [f.message for f in result.findings if f.rule_id == "field.fine"] == ["still here"]
    assert result.blocking == 1
    assert result.score is not None
    assert result.score.parts["trust"] == CheckCount(passed=0, applicable=1)
    assert result.score.parts["understand"] == CheckCount(passed=2, applicable=3)


def test_a_rule_reporting_more_problems_than_checks_is_a_failed_check() -> None:
    registry = Registry()

    @registry.rule("package.greedy", question="find", scope="package", severity="note")
    def greedy(ctx: Context) -> Outcome:
        return Outcome([Problem("a"), Problem("b")], 1)

    [finding] = diagnose_manifest(Manifest.model_validate(_sample_manifest()), registry=registry)

    assert finding.rule_id == "package.check-failed" and finding.severity == "error"


def test_a_failed_checks_cause_is_one_line_of_at_most_300_characters() -> None:
    registry = Registry()

    @registry.rule("field.long", question="understand", scope="field", severity="note")
    def long(ctx: Context) -> Outcome:
        raise ValueError("x" * 500)

    [finding] = diagnose_manifest(Manifest.model_validate(_sample_manifest()), registry=registry)

    assert finding.rule_id == "field.check-failed"
    assert finding.message.endswith(
        "not a problem in your data: " + ("ValueError: " + "x" * 500)[:300]
    )


def test_a_failed_checks_id_keeps_the_rules_prefix() -> None:
    assert CHECK_FAILED == "check-failed"
    assert [failed_id(r) for r in ("values.constant", "field.unit-missing", "package.x.y")] == [
        "values.check-failed",
        "field.check-failed",
        "package.check-failed",
    ]


def test_a_rule_does_not_swallow_an_interrupt() -> None:
    registry = Registry()

    @registry.rule("values.stopped", question="trust", scope="table", severity="note")
    def stopped(ctx: Context) -> Outcome:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        diagnose(SAMPLE, registry=registry)


def test_a_csv_path_with_no_format_is_read_as_csv() -> None:
    result = diagnose(NO_FORMAT)

    assert result.structure == []
    assert not [f for f in result.findings if f.rule_id == "values.unreadable"]
    constant = REGISTRY.get("values.constant").run(
        Context.for_package(
            NO_FORMAT,
            Manifest.model_validate(json.loads((NO_FORMAT / "datapackage.json").read_text())),
        )
    )
    assert constant.checks == 6  # three columns in each of the two tables


def test_a_csv_path_with_another_format_is_still_not_read() -> None:
    resource = Resource.model_validate(
        {
            "name": "t",
            "path": "data/readings.csv",
            "type": "table",
            "format": "json",
            "schema": {"fields": [{"name": "site"}]},
        }
    )

    with pytest.raises(UnreadableTable, match="only csv and tsv tables are read"):
        read_table(NO_FORMAT, resource)


def test_the_declared_rules_come_after_the_rules_that_were_there_before() -> None:
    ids = [rule.id for rule in REGISTRY]

    assert (
        ids.index("package.creator-orcid-missing")
        < ids.index("values.not-declared-type")
        < ids.index("values.unreadable")
        < ids.index("values.foreign-key-missing")
    )
