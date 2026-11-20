"""Each value rule on a tiny table."""

from pathlib import Path
from typing import Any

import pytest

from archive_contract.manifest import Manifest
from cruise.rules import REGISTRY, Context, RuleResult


def run(
    rule: str,
    tmp_path: Path,
    csv: str,
    fields: list[dict[str, Any]],
    *,
    primary_key: list[str] | None = None,
    package: dict[str, Any] | None = None,
) -> RuleResult:
    (tmp_path / "t.csv").write_text(csv, encoding="utf-8")
    schema: dict[str, Any] = {"fields": fields, "missingValues": ["", "NA"]}
    if primary_key:
        schema["primaryKey"] = primary_key
    resource = {"name": "t", "path": "t.csv", "type": "table", "format": "csv", "schema": schema}
    manifest = Manifest.model_validate({"resources": [resource], **(package or {})})
    return REGISTRY.get(rule).run(Context.for_package(tmp_path, manifest))


def context_of(tmp_path: Path, fields: list[dict[str, Any]]) -> Context:
    schema = {"fields": fields}
    resource = {"name": "t", "path": "t.csv", "type": "table", "format": "csv", "schema": schema}
    return Context.for_package(tmp_path, Manifest.model_validate({"resources": [resource]}))


def only(result: RuleResult) -> tuple[str | None, list[int] | None, list[Any] | None, int | None]:
    assert len(result.findings) == 1, result.findings
    finding = result.findings[0]
    assert finding.target is not None and finding.evidence is not None
    evidence = finding.evidence
    return finding.target.field, evidence.rows, evidence.values, evidence.count


def test_not_declared_type_flags_values_that_do_not_read_as_the_type(tmp_path: Path) -> None:
    csv = "n,x,d,s\n1,1.5,2024-06-01,a\nn/a,2,2024-13-01,b\n3,NA,2024-06-03,c\n4.0,x,,d\n"
    fields = [
        {"name": "n", "type": "integer"},
        {"name": "x", "type": "number"},
        {"name": "d", "type": "date"},
        {"name": "s", "type": "string"},
    ]

    result = run("values.not-declared-type", tmp_path, csv, fields)

    found = {f.target.field: f.evidence.rows for f in result.findings if f.target and f.evidence}
    assert found == {"n": [2, 4], "x": [4], "d": [2]}
    assert result.checks == 3


def test_placeholder_flags_fixed_codes_and_a_repeated_lone_negative(tmp_path: Path) -> None:
    csv = "a,b,c\n1,-1,-3.5\n-999,2,4\n3,-1,-2\n4,0,1\n"
    fields = [{"name": n, "type": "number"} for n in "abc"]

    result = run("values.placeholder", tmp_path, csv, fields)

    found = {f.target.field: f.evidence.rows for f in result.findings if f.target and f.evidence}
    assert found == {"a": [2], "b": [1, 3]}
    assert result.checks == 3


def test_constant_flags_a_column_with_one_value_in_every_row(tmp_path: Path) -> None:
    csv = "a,b,c\nx,1,\nx,2,z\nx,3,z\n"
    fields = [{"name": n} for n in "abc"]

    result = run("values.constant", tmp_path, csv, fields)

    assert only(result) == ("a", [1, 2, 3], ["x"], 3)
    assert result.checks == 3


def test_constant_does_not_apply_to_a_single_row(tmp_path: Path) -> None:
    result = run("values.constant", tmp_path, "a\nx\n", [{"name": "a"}])

    assert result.findings == [] and result.checks == 0


def test_mixed_date_formats_flags_the_rows_in_the_rarer_pattern(tmp_path: Path) -> None:
    csv = "when,other\n2024-06-01,x\n2024-06-02,y\n06/03/2024,z\n2024-06-04,w\n"
    fields = [{"name": "when", "type": "string"}, {"name": "other", "type": "string"}]

    result = run("values.mixed-date-formats", tmp_path, csv, fields)

    assert only(result) == ("when", [3], ["06/03/2024"], 1)
    assert result.checks == 2


def test_dates_outside_coverage_with_an_end_and_ongoing(tmp_path: Path) -> None:
    csv = "d,y\n2019-12-31,2019\n2020-06-01,2020\n2022-01-01,2022\n"
    fields = [{"name": "d", "type": "date"}, {"name": "y", "type": "year"}]
    ended = {"archive:temporalCoverage": {"start": "2020-01-01", "end": "2021-12-31"}}
    ongoing = {"archive:temporalCoverage": {"start": "2020-01-01", "ongoing": True}}

    closed = run("values.dates-outside-coverage", tmp_path, csv, fields, package=ended)
    open_ = run("values.dates-outside-coverage", tmp_path, csv, fields, package=ongoing)

    found = {f.target.field: f.evidence.rows for f in closed.findings if f.target and f.evidence}
    assert found == {"d": [1, 3], "y": [1, 3]}
    assert {f.evidence.rows[0] for f in open_.findings if f.evidence and f.evidence.rows} == {1}
    assert closed.checks == 2


def test_coverage_gap_notes_whole_years_with_no_rows(tmp_path: Path) -> None:
    csv = "d\n2018-03-01\n2019-07-01\n2021-07-01\n2023-02-01\n"
    coverage = {"archive:temporalCoverage": {"start": "2018-03-01", "end": "2023-06-30"}}

    result = run(
        "values.coverage-gap", tmp_path, csv, [{"name": "d", "type": "date"}], package=coverage
    )

    assert result.findings[0].severity == "note"
    assert only(result)[2] == [2020, 2022]


def test_coverage_gap_when_ongoing_runs_to_the_last_year_with_rows(tmp_path: Path) -> None:
    csv = "d\n2018-01-01\n2020-07-01\n"
    coverage = {"archive:temporalCoverage": {"start": "2018-01-01", "ongoing": True}}

    result = run(
        "values.coverage-gap", tmp_path, csv, [{"name": "d", "type": "date"}], package=coverage
    )

    assert only(result)[2] == [2019]


def test_coordinates_out_of_range_and_swapped(tmp_path: Path) -> None:
    csv = "Latitude,lon\n44.3,-72.7\n95.0,-150.0\n-120.0,44.2\n44.2,-200\n"
    fields = [{"name": "Latitude", "type": "number"}, {"name": "lon", "type": "number"}]

    result = run("values.coordinates-out-of-range", tmp_path, csv, fields)

    found = {f.target.field: f for f in result.findings if f.target}
    assert found["Latitude"].evidence is not None and found["Latitude"].evidence.rows == [2, 3]
    assert "row 3 looks swapped" in found["Latitude"].message
    assert found["lon"].evidence is not None and found["lon"].evidence.rows == [4]
    assert result.checks == 2


def test_coordinates_outside_the_coverage_box_and_swapped_into_it(tmp_path: Path) -> None:
    csv = "lat,longitude\n44.3,-72.7\n-72.7,44.3\n44.25,-73.5\n"
    fields = [{"name": "lat", "type": "number"}, {"name": "longitude", "type": "number"}]
    box = {"archive:spatialCoverage": {"bbox": [-72.8, 44.2, -72.6, 44.4]}}

    result = run("values.coordinates-out-of-range", tmp_path, csv, fields, package=box)

    found = {f.target.field: f for f in result.findings if f.target}
    assert found["lat"].evidence is not None and found["lat"].evidence.rows == [2]
    assert "row 2 looks swapped" in found["lat"].message
    assert found["longitude"].evidence is not None and found["longitude"].evidence.rows == [3]


def test_coordinates_in_a_geopoint_column(tmp_path: Path) -> None:
    csv = 'where\n"-72.7, 44.3"\n"-72.7, 91"\n'

    result = run(
        "values.coordinates-out-of-range", tmp_path, csv, [{"name": "where", "type": "geopoint"}]
    )

    assert only(result)[:2] == ("where", [2])


def test_duplicate_key_flags_every_row_sharing_a_key(tmp_path: Path) -> None:
    csv = "id,v\n1,a\n2,b\n1,c\n3,d\n"
    fields = [{"name": "id", "type": "integer"}, {"name": "v"}]

    result = run("values.duplicate-key", tmp_path, csv, fields, primary_key=["id"])

    assert only(result) == ("id", [1, 3], ["1", "1"], 2)
    assert result.checks == 1


def test_wrong_type_message_says_the_value_does_not_read_as_the_type(tmp_path: Path) -> None:
    result = run(
        "values.not-declared-type", tmp_path, "n\n1\nn/a\n", [{"name": "n", "type": "integer"}]
    )

    assert "1 value that does not read as integer" in result.findings[0].message


def test_mixed_date_formats_tells_month_first_from_day_first(tmp_path: Path) -> None:
    csv = "a,b,c\n06/18/2024,06/07/2024,06/07/2024\n19/06/2024,05/04/2024,06/18/2024\n"
    fields = [{"name": n, "type": "string"} for n in "abc"]

    result = run("values.mixed-date-formats", tmp_path, csv, fields)

    assert only(result)[:2] == ("a", [2])


def test_a_csv_that_cannot_be_parsed_is_an_error_and_a_failed_check(tmp_path: Path) -> None:
    csv = "code,name\nNR1,North Run, lower pool\n"
    fields = [{"name": "code", "type": "string"}, {"name": "name", "type": "string"}]

    result = run("values.malformed", tmp_path, csv, fields)

    finding = result.findings[0]
    assert (finding.severity, finding.target and finding.target.resource) == ("error", "t")
    assert finding.message.count("can't be read") == 1
    assert "Expected Number of Columns: 2 Found: 3" in finding.message
    # None of the reader's own advice or options, and no path on this machine.
    for leaked in ("Possible", "strict_mode", "ignore_errors", str(tmp_path)):
        assert leaked not in finding.message
    assert "well-formed CSV" in (finding.suggested_fix or "")
    assert (len(result.findings), result.checks, result.passed) == (1, 1, 0)
    assert run("values.unreadable", tmp_path, csv, fields).findings == []


@pytest.mark.parametrize(
    "data",
    [
        "a,b\n1,\u00f6k\n".encode("latin-1"),
        "a,b\n1,ok\n".encode("utf-16"),
        "a,b\n1,ok\n".encode("utf-16-le"),
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR",
    ],
    ids=["latin-1", "utf-16", "utf-16 without a mark", "an image"],
)
def test_a_table_that_is_not_utf8_text_is_told_to_be_saved_as_utf8(
    tmp_path: Path, data: bytes
) -> None:
    fields = [{"name": "a", "type": "string"}, {"name": "b", "type": "string"}]
    run("values.malformed", tmp_path, "", fields)
    (tmp_path / "t.csv").write_bytes(data)

    finding = REGISTRY.get("values.malformed").run(context_of(tmp_path, fields)).findings[0]

    assert finding.suggested_fix == "Save the file as UTF-8 text."
    assert "is not UTF-8 text" in finding.message and "Possible" not in finding.message


def test_a_ragged_row_past_the_readers_sample_is_still_malformed(tmp_path: Path) -> None:
    csv = "a,b\n" + "1,x\n" * 25_000 + "1,x,y\n"
    fields = [{"name": "a", "type": "string"}, {"name": "b", "type": "string"}]

    assert len(run("values.malformed", tmp_path, csv, fields).findings) == 1


def test_a_table_left_unread_on_purpose_is_a_note_not_an_error(tmp_path: Path) -> None:
    fields = [{"name": "cruise:row"}]

    assert run("values.malformed", tmp_path, "cruise:row\na\n", fields).findings == []
    note = run("values.unreadable", tmp_path, "cruise:row\na\n", fields)
    assert [(f.rule_id, f.severity) for f in note.findings] == [("values.unreadable", "note")]


def test_placeholder_reads_a_column_named_n(tmp_path: Path) -> None:
    fields = [{"name": "n", "type": "number"}, {"name": "b", "type": "number"}]

    result = run("values.placeholder", tmp_path, "n,b\n-1,2\n-1,3\n4,5\n", fields)

    assert only(result)[0] == "n" and result.checks == 2


def test_working_names_do_not_collide_with_columns_of_the_same_name(tmp_path: Path) -> None:
    csv = "n,p,k,y\n2020-01-01,2020-01-01,1,1\n01/02/2020,01/02/2020,1,2\n"
    fields = [{"name": c, "type": "string"} for c in "npky"]

    for rule in ("values.mixed-date-formats", "values.constant"):
        findings = run(rule, tmp_path, csv, fields).findings
        assert not any(f.rule_id.endswith("check-failed") for f in findings)
    dup = run("values.duplicate-key", tmp_path, csv, fields, primary_key=["k"])
    assert only(dup)[1] == [1, 2]


def test_a_column_in_the_readers_namespace_is_unreadable_not_a_failure(tmp_path: Path) -> None:
    result = run("values.unreadable", tmp_path, "cruise:row\na\n", [{"name": "cruise:row"}])

    assert "names that start with 'cruise:' are kept for the reader" in result.findings[0].message
    assert result.findings[0].rule_id == "values.unreadable"


def test_a_table_that_is_not_utf8_is_malformed_not_a_failed_check(tmp_path: Path) -> None:
    (tmp_path / "t.csv").write_bytes("a,b\n1,ok\n2,\u00f6k\n".encode("latin-1"))
    fields = [{"name": "a", "type": "integer"}, {"name": "b", "type": "string"}]
    resource = {
        "name": "t",
        "path": "t.csv",
        "type": "table",
        "format": "csv",
        "schema": {"fields": fields},
    }
    context = Context.for_package(tmp_path, Manifest.model_validate({"resources": [resource]}))

    malformed = REGISTRY.get("values.malformed").run(context)
    constant = REGISTRY.get("values.constant").run(context)

    assert [f.rule_id for f in malformed.findings] == ["values.malformed"]
    assert "UTF-8" in (malformed.findings[0].suggested_fix or "")
    assert not any(f.rule_id.endswith("check-failed") for f in constant.findings)
