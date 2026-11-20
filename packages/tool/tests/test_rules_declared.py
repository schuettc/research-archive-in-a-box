"""Each rule that checks what the manifest declares, on tiny tables."""

from pathlib import Path
from typing import Any

import pytest

from archive_contract.manifest import Manifest
from cruise.rules import REGISTRY, Context, RuleResult

ALL_NINE = (
    "values.foreign-key-missing",
    "values.required-missing",
    "values.not-unique",
    "values.not-in-enum",
    "values.below-minimum",
    "values.above-maximum",
    "values.too-short",
    "values.too-long",
    "values.pattern-mismatch",
)

Tables = dict[str, tuple[str, dict[str, Any]]]


def run(
    rule: str, tmp_path: Path, tables: Tables, *, formats: dict[str, str] | None = None
) -> RuleResult:
    """The rule run over a package of CSV tables, each given as its text and its schema."""
    resources = []
    for name, (csv, schema) in tables.items():
        (tmp_path / f"{name}.csv").write_text(csv, encoding="utf-8")
        resources.append(
            {
                "name": name,
                "path": f"{name}.csv",
                "type": "table",
                "format": (formats or {}).get(name, "csv"),
                "schema": {"missingValues": ["", "NA"], **schema},
            }
        )
    manifest = Manifest.model_validate({"resources": resources})
    return REGISTRY.get(rule).run(Context.for_package(tmp_path, manifest))


def one(
    tmp_path: Path, rule: str, csv: str, field: dict[str, Any], **constraints: Any
) -> RuleResult:
    """The rule run over one table `t` whose one column carries the constraints."""
    return run(rule, tmp_path, {"t": (csv, {"fields": [{**field, "constraints": constraints}]})})


def only(result: RuleResult) -> tuple[str | None, list[int] | None, list[Any] | None, int | None]:
    assert len(result.findings) == 1, result.findings
    finding = result.findings[0]
    assert finding.target is not None and finding.evidence is not None
    evidence = finding.evidence
    return finding.target.field, evidence.rows, evidence.values, evidence.count


def key(fields: list[str], resource: str | None, to: list[str]) -> dict[str, Any]:
    reference: dict[str, Any] = {"fields": to}
    if resource is not None:
        reference["resource"] = resource
    return {"fields": fields, "reference": reference}


def names(*columns: str) -> list[dict[str, Any]]:
    return [{"name": c} for c in columns]


def test_every_declared_rule_is_a_core_error_about_trust() -> None:
    for rule_id in ALL_NINE:
        rule = REGISTRY.get(rule_id)
        assert (rule.question, rule.scope, rule.severity, rule.core) == (
            "trust",
            "table",
            "error",
            True,
        )


def test_foreign_key_flags_rows_whose_value_is_not_in_the_referenced_column(
    tmp_path: Path,
) -> None:
    tables: Tables = {
        "obs": (
            "id,site\n1,S1\n2,S9\n3,\n4,S2\n",
            {"fields": names("id", "site"), "foreignKeys": [key(["site"], "sites", ["code"])]},
        ),
        "sites": ("code\nS1\nS2\n", {"fields": names("code")}),
    }

    result = run("values.foreign-key-missing", tmp_path, tables)

    assert only(result) == ("site", [2], ["S9"], 1)  # the empty cell in row 3 is not one
    assert result.rule.severity == "error" and result.checks == 1
    finding = result.findings[0]
    assert finding.target is not None and finding.target.resource == "obs"
    assert finding.message == (
        "Column site has 1 row whose value is not in sites.code, which its foreign key points at."
    )
    assert finding.suggested_fix == "Add the missing values to sites, or correct them in obs."


def test_foreign_key_with_every_value_present_passes_its_check(tmp_path: Path) -> None:
    tables: Tables = {
        "obs": (
            "site\nS1\nS2\nS1\n",
            {"fields": names("site"), "foreignKeys": [key(["site"], "sites", ["code"])]},
        ),
        "sites": ("code\nS1\nS2\n", {"fields": names("code")}),
    }

    result = run("values.foreign-key-missing", tmp_path, tables)

    assert result.findings == [] and result.checks == 1


def test_composite_foreign_key_matches_on_every_column_together(tmp_path: Path) -> None:
    tables: Tables = {
        "obs": (
            "site,yr\nS1,2001\nS9,2001\nS1,2003\n,2001\n",
            {
                "fields": names("site", "yr"),
                "foreignKeys": [key(["site", "yr"], "sites", ["code", "year"])],
            },
        ),
        "sites": ("code,year\nS1,2001\nS2,2003\n", {"fields": names("code", "year")}),
    }

    result = run("values.foreign-key-missing", tmp_path, tables)

    assert only(result) == ("site, yr", [2, 3], ["S9, 2001", "S1, 2003"], 2)
    assert result.findings[0].message == (
        "Column site, yr has 2 rows whose value is not in sites.code, year, "
        "which its foreign key points at."
    )


def test_foreign_key_into_the_same_table(tmp_path: Path) -> None:
    tables: Tables = {
        "t": (
            "id,parent\n1,\n2,1\n3,7\n5,5\n",
            {"fields": names("id", "parent"), "foreignKeys": [key(["parent"], None, ["id"])]},
        )
    }

    result = run("values.foreign-key-missing", tmp_path, tables)

    assert only(result) == ("parent", [3], ["7"], 1)
    assert "is not in t.id" in result.findings[0].message


def test_foreign_key_into_an_unreadable_table_applies_no_check(tmp_path: Path) -> None:
    tables: Tables = {
        "obs": (
            "site\nS9\n",
            {"fields": names("site"), "foreignKeys": [key(["site"], "sites", ["code"])]},
        ),
        "sites": ("code\nS1\n", {"fields": names("code")}),
    }

    result = run("values.foreign-key-missing", tmp_path, tables, formats={"sites": "xlsx"})

    assert result.findings == [] and result.checks == 0


def test_foreign_keys_list_no_more_than_the_evidence_limit(tmp_path: Path) -> None:
    rows = "".join(f"X{i}\n" for i in range(30))
    tables: Tables = {
        "obs": (
            "site\n" + rows,
            {"fields": names("site"), "foreignKeys": [key(["site"], "sites", ["code"])]},
        ),
        "sites": ("code\nS1\n", {"fields": names("code")}),
    }

    _, found, values, count = only(run("values.foreign-key-missing", tmp_path, tables))

    assert found == list(range(1, 21)) and count == 30
    assert values is not None and len(values) == 20


def test_a_table_with_no_foreign_key_or_constraint_applies_no_check(tmp_path: Path) -> None:
    for rule in ALL_NINE:
        result = run(rule, tmp_path, {"t": ("a\n1\n", {"fields": names("a")})})
        assert result.findings == [] and result.checks == 0


def test_required_and_unique_set_to_false_apply_no_check(tmp_path: Path) -> None:
    for rule in ("values.required-missing", "values.not-unique"):
        result = one(tmp_path, rule, "a\nx\n\nx\n", {"name": "a"}, required=False, unique=False)
        assert result.findings == [] and result.checks == 0


def test_required_flags_missing_cells_only(tmp_path: Path) -> None:
    result = one(
        tmp_path, "values.required-missing", "a\nx\n\nNA\ny\n", {"name": "a"}, required=True
    )

    [finding] = result.findings
    assert finding.evidence is not None and finding.target is not None
    evidence = finding.evidence
    assert (evidence.rows, evidence.values, evidence.count) == ([2, 3], None, 2)
    assert (finding.target.resource, finding.target.field) == ("t", "a")
    assert finding.message == "Column a is required but has 2 rows with no value."
    assert finding.suggested_fix == (
        "Fill in the missing values, or remove required from the column's constraints."
    )
    assert result.checks == 1


def test_unique_flags_every_row_sharing_a_value_and_ignores_missing_cells(tmp_path: Path) -> None:
    result = one(tmp_path, "values.not-unique", "a\nx\ny\nx\n\n\n", {"name": "a"}, unique=True)

    assert only(result) == ("a", [1, 3], ["x", "x"], 2)
    assert result.findings[0].message == "Column a must be unique but 2 rows repeat a value."
    assert result.findings[0].suggested_fix == (
        "Make every value of a different, or remove unique from the column's constraints."
    )


def test_enum_compares_text_as_text_and_numbers_as_numbers(tmp_path: Path) -> None:
    text = one(tmp_path, "values.not-in-enum", "a\nok\nbad\n\n", {"name": "a"}, enum=["ok", "fine"])
    assert only(text) == ("a", [2], ["bad"], 1)
    assert text.findings[0].message == "Column a has 1 value that is not in its enum."
    assert text.findings[0].suggested_fix == "Correct the values, or add them to the column's enum."

    number = one(
        tmp_path,
        "values.not-in-enum",
        "a\n1.0\n2\n3\n",
        {"name": "a", "type": "number"},
        enum=[1, 2],
    )
    assert only(number) == ("a", [3], ["3"], 1)


def test_enum_on_a_boolean_column_reads_cells_and_entries_as_booleans(tmp_path: Path) -> None:
    field = {"name": "a", "type": "boolean"}
    plain = one(tmp_path, "values.not-in-enum", "a\ntrue\nfalse\n1\n0\n", field, enum=[True, False])
    assert plain.findings == [] and plain.checks == 1

    own = {**field, "trueValues": ["yes"], "falseValues": ["no"]}
    assert (
        one(tmp_path, "values.not-in-enum", "a\nyes\nno\n", own, enum=[True, False]).findings == []
    )
    assert only(one(tmp_path, "values.not-in-enum", "a\nyes\nno\n", own, enum=[True])) == (
        "a",
        [2],
        ["no"],
        1,
    )
    assert only(one(tmp_path, "values.not-in-enum", "a\nyes\nno\n", own, enum=["no"]))[1] == [1]


def test_enum_on_a_date_column_compares_dates_by_the_columns_format(tmp_path: Path) -> None:
    field = {"name": "a", "type": "date", "format": "%d/%m/%Y"}

    result = one(
        tmp_path, "values.not-in-enum", "a\n01/02/2020\n02/02/2020\n", field, enum=["01/02/2020"]
    )

    assert only(result) == ("a", [2], ["02/02/2020"], 1)


def test_an_enum_entry_that_does_not_read_as_the_type_is_a_finding_on_the_constraint(
    tmp_path: Path,
) -> None:
    field = {"name": "a", "type": "integer"}

    result = one(tmp_path, "values.not-in-enum", "a\n1\n7\n", field, enum=[1, "x"])

    [finding] = result.findings
    assert finding.message == (
        "Column a's enum constraint ('x') does not read as integer, so it can't be checked."
    )
    assert finding.suggested_fix == "Correct the constraint in the manifest."
    assert result.checks == 1


def test_an_empty_enum_is_a_finding_on_the_constraint(tmp_path: Path) -> None:
    values: tuple[Any, ...] = ([], "ok")
    for value in values:
        result = one(tmp_path, "values.not-in-enum", "a\nx\n", {"name": "a"}, enum=value)
        assert result.findings[0].message == (
            f"Column a's enum constraint ({value!r}) is not a list of values, "
            "so it can't be checked."
        )
        assert result.checks == 1


@pytest.mark.parametrize(
    ("type_", "fmt", "cells", "low", "high", "below", "above"),
    [
        ("integer", None, ["5", "10", "20"], 10, 10, [1], [3]),
        ("number", None, ["0.5", "1e3", "2000"], "1e3", 1000, [1], [3]),
        (
            "date",
            None,
            ["2019-12-31", "2020-06-01", "2021-01-01"],
            "2020-01-01",
            "2020-12-31",
            [1],
            [3],
        ),
        (
            "date",
            "%d/%m/%Y",
            ["31/12/2019", "01/06/2020", "01/01/2021"],
            "01/01/2020",
            "31/12/2020",
            [1],
            [3],
        ),
        (
            "datetime",
            None,
            ["2019-12-31T23:59:00", "2020-06-01T00:00:00", "2021-01-01T00:00:00"],
            "2020-01-01T00:00:00",
            "2020-12-31T23:59:59",
            [1],
            [3],
        ),
        ("time", None, ["08:00:00", "12:00:00", "18:30:00"], "09:00:00", "17:00:00", [1], [3]),
        ("year", None, ["1999", "2005", "2011"], 2000, "2010", [1], [3]),
    ],
)
def test_minimum_and_maximum_compare_by_the_declared_type(
    tmp_path: Path,
    type_: str,
    fmt: str | None,
    cells: list[str],
    low: Any,
    high: Any,
    below: list[int],
    above: list[int],
) -> None:
    field: dict[str, Any] = {"name": "a", "type": type_}
    if fmt is not None:
        field["format"] = fmt
    csv = "a\n" + "".join(f"{cell}\n" for cell in cells)

    under = one(tmp_path, "values.below-minimum", csv, field, minimum=low, maximum=high)
    over = one(tmp_path, "values.above-maximum", csv, field, minimum=low, maximum=high)

    assert only(under) == ("a", below, [cells[0]], 1)
    assert only(over) == ("a", above, [cells[2]], 1)
    assert under.findings[0].message == f"Column a has 1 value below its minimum of {low}."
    assert over.findings[0].message == f"Column a has 1 value above its maximum of {high}."
    assert under.findings[0].suggested_fix == "Correct the values, or lower the column's minimum."
    assert over.findings[0].suggested_fix == "Correct the values, or raise the column's maximum."


def test_a_bound_equal_to_the_value_is_inside(tmp_path: Path) -> None:
    field = {"name": "a", "type": "integer"}
    for rule in ("values.below-minimum", "values.above-maximum"):
        result = one(tmp_path, rule, "a\n10\n", field, minimum=10, maximum=10)
        assert result.findings == [] and result.checks == 1


def test_a_value_that_does_not_convert_is_left_to_the_type_rule(tmp_path: Path) -> None:
    field = {"name": "a", "type": "integer"}

    for rule, constraints in (
        ("values.below-minimum", {"minimum": 0}),
        ("values.above-maximum", {"maximum": 9}),
        ("values.not-in-enum", {"enum": [5]}),
    ):
        result = one(tmp_path, rule, "a\n5\nn/a\n", field, **constraints)
        assert result.findings == [] and result.checks == 1

    typed = one(tmp_path, "values.not-declared-type", "a\n5\nn/a\n", field, minimum=0)
    assert only(typed)[:2] == ("a", [2])


def test_a_bound_that_does_not_read_as_the_type_is_a_finding_on_the_constraint(
    tmp_path: Path,
) -> None:
    field = {"name": "a", "type": "integer"}

    result = one(tmp_path, "values.below-minimum", "a\n5\n", field, minimum=0.5)

    assert result.findings[0].message == (
        "Column a's minimum constraint (0.5) does not read as integer, so it can't be checked."
    )
    assert result.findings[0].suggested_fix == "Correct the constraint in the manifest."
    assert result.checks == 1
    over = one(
        tmp_path, "values.above-maximum", "a\n5\n", {"name": "a", "type": "date"}, maximum="soon"
    )
    assert over.findings[0].message == (
        "Column a's maximum constraint ('soon') does not read as date, so it can't be checked."
    )


def test_a_whole_number_float_bound_on_an_integer_column_reads_as_that_integer(
    tmp_path: Path,
) -> None:
    field = {"name": "a", "type": "integer"}

    under = one(tmp_path, "values.below-minimum", "a\n5\n10\n", field, minimum=10.0)
    over = one(tmp_path, "values.above-maximum", "a\n10\n11\n", field, maximum=10.0)

    assert only(under) == ("a", [1], ["5"], 1)
    assert under.findings[0].message == "Column a has 1 value below its minimum of 10."
    assert only(over) == ("a", [2], ["11"], 1)


@pytest.mark.parametrize("type_", ["string", "boolean", "yearmonth", "duration", None])
def test_minimum_on_a_column_with_no_checked_type_applies_no_check(
    tmp_path: Path, type_: str | None
) -> None:
    field = {"name": "a", "type": type_} if type_ else {"name": "a"}
    for rule in ("values.below-minimum", "values.above-maximum"):
        result = one(tmp_path, rule, "a\nx\n", field, minimum=1, maximum=2)
        assert result.findings == [] and result.checks == 0


def test_length_counts_characters_of_text_columns(tmp_path: Path) -> None:
    short = one(tmp_path, "values.too-short", "a\nab\nabcd\n\n", {"name": "a"}, minLength=3)
    assert only(short) == ("a", [1], ["ab"], 1)
    assert short.findings[0].message == "Column a has 1 value shorter than its minLength of 3."
    assert short.findings[0].suggested_fix == "Correct the values, or lower the column's minLength."

    field = {"name": "a", "type": "string"}
    long = one(tmp_path, "values.too-long", "a\nab\nabcd\nabcde\n", field, maxLength=3)
    assert only(long) == ("a", [2, 3], ["abcd", "abcde"], 2)
    assert long.findings[0].message == "Column a has 2 values longer than its maxLength of 3."
    assert long.findings[0].suggested_fix == "Correct the values, or raise the column's maxLength."


def test_length_on_a_column_that_is_not_text_applies_no_check(tmp_path: Path) -> None:
    field = {"name": "a", "type": "integer"}
    for rule in ("values.too-short", "values.too-long", "values.pattern-mismatch"):
        result = one(tmp_path, rule, "a\n1\n", field, minLength=2, maxLength=0, pattern="x")
        assert result.findings == [] and result.checks == 0


@pytest.mark.parametrize("bound", ["3", 2.5, True])
def test_a_length_that_is_not_a_whole_number_is_a_finding_on_the_constraint(
    tmp_path: Path, bound: Any
) -> None:
    result = one(tmp_path, "values.too-short", "a\nab\n", {"name": "a"}, minLength=bound)

    assert result.findings[0].message == (
        f"Column a's minLength constraint ({bound!r}) is not a whole number, "
        "so it can't be checked."
    )
    assert result.checks == 1


def test_required_or_unique_that_is_not_true_or_false_is_a_finding_on_the_constraint(
    tmp_path: Path,
) -> None:
    required = one(tmp_path, "values.required-missing", "a\nx\n", {"name": "a"}, required="yes")
    unique = one(tmp_path, "values.not-unique", "a\nx\n", {"name": "a"}, unique=1)

    assert required.findings[0].message == (
        "Column a's required constraint ('yes') is not true or false, so it can't be checked."
    )
    assert unique.findings[0].message == (
        "Column a's unique constraint (1) is not true or false, so it can't be checked."
    )
    assert (required.checks, unique.checks) == (1, 1)


def test_pattern_must_match_the_whole_value_and_says_which_dialect(tmp_path: Path) -> None:
    result = one(
        tmp_path, "values.pattern-mismatch", "a\nS1\nS12\nxS1\n\n", {"name": "a"}, pattern="S[0-9]"
    )

    assert only(result) == ("a", [2, 3], ["S12", "xS1"], 2)
    assert result.findings[0].message == (
        "Column a has 2 values that do not match its pattern S[0-9]. The pattern is read as a "
        "DuckDB (RE2) regular expression and must match the whole value."
    )
    assert result.findings[0].suggested_fix == "Correct the values, or change the column's pattern."


@pytest.mark.parametrize("pattern", ["(unclosed", r"\i\c*", r"\p{IsBasicLatin}+"])
def test_pattern_that_duckdb_cannot_read_is_a_finding_on_the_constraint(
    tmp_path: Path, pattern: str
) -> None:
    result = one(tmp_path, "values.pattern-mismatch", "a\nS1\n", {"name": "a"}, pattern=pattern)

    [finding] = result.findings
    assert finding.rule_id == "values.pattern-mismatch"
    assert finding.message.startswith(
        f"Column a's pattern constraint ({pattern!r}) is not a regular expression DuckDB (RE2) "
        "can read: "
    )
    assert finding.message.endswith(", so it can't be checked.")
    assert "\n" not in finding.message
    assert finding.suggested_fix == "Correct the constraint in the manifest."
    assert result.checks == 1


def test_a_pattern_with_a_quote_in_it_is_read_as_written(tmp_path: Path) -> None:
    result = one(
        tmp_path, "values.pattern-mismatch", "a\nit's\nits\n", {"name": "a"}, pattern="it's"
    )

    assert only(result) == ("a", [2], ["its"], 1)


def test_declared_rules_read_columns_named_like_their_working_names(tmp_path: Path) -> None:
    schema = {
        "fields": [
            {"name": "n", "constraints": {"unique": True, "required": True}},
            {"name": "local", "constraints": {"enum": ["1", "2"], "minLength": 1, "pattern": "."}},
            {"name": "ref", "constraints": {"maxLength": 3}},
            {"name": "t"},
        ],
        "foreignKeys": [key(["local"], None, ["ref"])],
    }
    tables: Tables = {"t": ("n,local,ref,t\n1,1,1,a\n1,2,3,b\n", schema)}

    for rule in ALL_NINE:
        findings = run(rule, tmp_path, tables).findings
        assert not any(f.rule_id.endswith("check-failed") for f in findings), findings
    assert only(run("values.not-unique", tmp_path, tables)) == ("n", [1, 2], ["1", "1"], 2)
    assert only(run("values.foreign-key-missing", tmp_path, tables)) == ("local", [2], ["2"], 1)
