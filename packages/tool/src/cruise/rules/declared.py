"""Does the data keep what the manifest declares? Foreign keys and field constraints.

Each rule applies one check per foreign key or per column that declares the constraint, on a
table that can be read, so a package that declares nothing gains no checks. An empty cell
breaks only `required`. A constraint that can't be applied (a bound that doesn't read as the
column's type, a pattern DuckDB can't read) is itself the problem, on that column.

| Rule | Catches | Severity |
| --- | --- | --- |
| `values.foreign-key-missing` | Rows whose foreign-key value is not in the column the key \
points at. Keys compare as text; a row with an empty cell in the key is not checked. | error |
| `values.required-missing` | Empty cells in a column whose constraints say `required`. | error |
| `values.not-unique` | Rows that repeat a value in a column whose constraints say `unique`. \
| error |
| `values.not-in-enum` | Values that are not in the column's `enum`, compared by the column's \
declared type. | error |
| `values.below-minimum` | Values below the column's `minimum`, compared by its declared type \
(number, integer, date, datetime, time or year). | error |
| `values.above-maximum` | Values above the column's `maximum`, compared the same way. | error |
| `values.too-short` | Text values with fewer characters than the column's `minLength`. | error |
| `values.too-long` | Text values with more characters than the column's `maxLength`. | error |
| `values.pattern-mismatch` | Text values that don't match the column's `pattern`, read as a \
DuckDB (RE2) regular expression that must match the whole value. | error |
"""

from collections.abc import Iterator
from typing import Any

import duckdb

from archive_contract.fields import Field
from archive_contract.resources import Resource
from cruise.rules.registry import EVIDENCE_LIMIT, Context, Outcome, Problem, rule
from cruise.rules.values import ROW_SQL, _agree, _columns, _evidence, _plural, _typed
from cruise.tables import quote_identifier, quote_literal, select, working

BOUNDED_TYPES = frozenset({"number", "integer", "date", "datetime", "time", "year"})
"""The types `minimum` and `maximum` are checked on."""

TEXT_TYPES = frozenset({None, "string"})
"""The types `minLength`, `maxLength` and `pattern` are checked on."""


def _declared(
    ctx: Context, key: str
) -> Iterator[tuple[Resource, duckdb.DuckDBPyRelation, Field, str, Any]]:
    """Every column of a readable table that declares the constraint, with what it declares."""
    for resource, _, relation, column, value in _columns(ctx):
        declared = (column.constraints or {}).get(key)
        if declared is not None:
            yield resource, relation, column, value, declared


def _unusable(resource: Resource, column: Field, key: str, value: Any, reason: str) -> Problem:
    """The problem for a constraint that can't be applied: the column's one failed check."""
    return Problem(
        f"Column {column.name}'s {key} constraint ({value!r}) {reason}, so it can't be checked.",
        resource=resource.name,
        field=column.name,
        fix="Correct the constraint in the manifest.",
    )


def _text(column: Field, entry: Any) -> str:
    """A bound or enum entry as the text a cell would hold. A whole-number float on an integer
    column (JSON's `10.0`) is that integer."""
    if column.type == "integer" and isinstance(entry, float) and entry.is_integer():
        return str(int(entry))
    return str(entry)


def _typed_entry(column: Field, entry: Any) -> str | None:
    """SQL for a bound or enum entry read as the column's declared type, as its cells are;
    None when the type is one `_typed` doesn't read."""
    if column.type == "boolean" and isinstance(entry, bool):
        return "true" if entry else "false"
    return _typed(column, quote_literal(_text(column, entry)))


def _reads(relation: duckdb.DuckDBPyRelation, typed: str) -> bool:
    """Whether the typed SQL of a bound or enum entry has a value."""
    return bool(select(relation, f"SELECT ({typed}) IS NOT NULL")[0][0])


def _first_line(exc: Exception) -> str:
    lines = str(exc).splitlines()
    return lines[0] if lines else type(exc).__name__


@rule("values.foreign-key-missing", question="trust", scope="table", severity="error")
def foreign_key_missing(ctx: Context) -> Outcome:
    problems: list[Problem] = []
    checks = 0
    by_name = {r.name: r for r in ctx.manifest.resources}
    local, ref = working("local"), working("ref")
    for resource, schema, here in ctx.tables():
        for key in schema.foreign_keys or []:
            names, pointed = key.field_names(), key.reference.field_names()
            ref_name = key.reference.resource or resource.name
            target = by_name.get(ref_name)
            there = ctx.read(target) if target is not None else None
            if there is None or not names or len(names) != len(pointed):
                continue  # the structure check or values.unreadable already says why
            checks += 1
            on = " AND ".join(
                f"{local}.{quote_identifier(a)} = {ref}.{quote_identifier(b)}"
                for a, b in zip(names, pointed, strict=True)
            )
            missing = here.set_alias("cruise:local").join(
                there.set_alias("cruise:ref"), on, how="anti"
            )
            columns = ", ".join(quote_identifier(n) for n in names)
            present = " AND ".join(f"{quote_identifier(n)} IS NOT NULL" for n in names)
            rows, values, count = _evidence(missing, f"concat_ws(', ', {columns})", present)
            if count:
                label = ", ".join(names)
                problems.append(
                    Problem(
                        f"Column {label} has {_plural(count, 'row')} whose value is not in "
                        f"{ref_name}.{', '.join(pointed)}, which its foreign key points at.",
                        resource=resource.name,
                        field=label,
                        rows=rows,
                        values=values,
                        count=count,
                        fix=f"Add the missing values to {ref_name}, or correct them in "
                        f"{resource.name}.",
                    )
                )
    return Outcome(problems, checks)


@rule("values.required-missing", question="trust", scope="table", severity="error")
def required_missing(ctx: Context) -> Outcome:
    problems: list[Problem] = []
    checks = 0
    for resource, relation, column, value, required in _declared(ctx, "required"):
        if required is False:
            continue
        checks += 1
        if required is not True:
            reason = "is not true or false"
            problems.append(_unusable(resource, column, "required", required, reason))
            continue
        rows, _, count = _evidence(relation, value, f"{value} IS NULL")
        if count:
            problems.append(
                Problem(
                    f"Column {column.name} is required but has {_plural(count, 'row')} with "
                    "no value.",
                    resource=resource.name,
                    field=column.name,
                    rows=rows,
                    count=count,
                    fix="Fill in the missing values, or remove required from the column's "
                    "constraints.",
                )
            )
    return Outcome(problems, checks)


@rule("values.not-unique", question="trust", scope="table", severity="error")
def not_unique(ctx: Context) -> Outcome:
    problems: list[Problem] = []
    checks = 0
    n = working("n")
    for resource, relation, column, value, unique in _declared(ctx, "unique"):
        if unique is False:
            continue
        checks += 1
        if unique is not True:
            problems.append(_unusable(resource, column, "unique", unique, "is not true or false"))
            continue
        found = select(
            relation,
            f"SELECT {ROW_SQL}, {value}, count(*) OVER () FROM ("
            f"SELECT {ROW_SQL}, {value}, count(*) OVER (PARTITION BY {value}) AS {n} "
            f"FROM t WHERE {value} IS NOT NULL) WHERE {n} > 1 "
            f"ORDER BY {ROW_SQL} LIMIT {EVIDENCE_LIMIT}",
        )
        if found:
            count = int(found[0][2])
            problems.append(
                Problem(
                    f"Column {column.name} must be unique but {_plural(count, 'row')} repeat "
                    "a value.",
                    resource=resource.name,
                    field=column.name,
                    rows=[r[0] for r in found],
                    values=[r[1] for r in found],
                    count=count,
                    fix=f"Make every value of {column.name} different, or remove unique from "
                    "the column's constraints.",
                )
            )
    return Outcome(problems, checks)


@rule("values.not-in-enum", question="trust", scope="table", severity="error")
def not_in_enum(ctx: Context) -> Outcome:
    problems: list[Problem] = []
    checks = 0
    for resource, relation, column, value, entries in _declared(ctx, "enum"):
        checks += 1
        if not isinstance(entries, list) or not entries:
            reason = "is not a list of values"
            problems.append(_unusable(resource, column, "enum", entries, reason))
            continue
        typed = _typed(column, value)
        if typed is None:
            listed = ", ".join(quote_literal(str(entry)) for entry in entries)
            where = f"{value} NOT IN ({listed})"
        else:
            literals = [_typed_entry(column, entry) or "NULL" for entry in entries]
            unread = [
                e for e, lit in zip(entries, literals, strict=True) if not _reads(relation, lit)
            ]
            if unread:
                reason = f"does not read as {column.type}"
                problems.append(_unusable(resource, column, "enum", unread[0], reason))
                continue
            where = f"({typed}) NOT IN ({', '.join(literals)})"
        rows, values, count = _evidence(relation, value, where)
        if count:
            problems.append(
                Problem(
                    f"Column {column.name} has {_plural(count, 'value')} that "
                    f"{_agree(count, 'is', 'are')} not in its enum.",
                    resource=resource.name,
                    field=column.name,
                    rows=rows,
                    values=values,
                    count=count,
                    fix="Correct the values, or add them to the column's enum.",
                )
            )
    return Outcome(problems, checks)


def _bound(ctx: Context, key: str, compare: str, side: str, move: str) -> Outcome:
    """`minimum` or `maximum`: the cells on the wrong side of the bound, both read as the
    column's declared type."""
    problems: list[Problem] = []
    checks = 0
    for resource, relation, column, value, bound in _declared(ctx, key):
        if column.type not in BOUNDED_TYPES:
            continue
        checks += 1
        typed, limit = _typed(column, value), _typed_entry(column, bound)
        if typed is None or limit is None or not _reads(relation, limit):
            reason = f"does not read as {column.type}"
            problems.append(_unusable(resource, column, key, bound, reason))
            continue
        rows, values, count = _evidence(relation, value, f"({typed}) {compare} ({limit})")
        if count:
            problems.append(
                Problem(
                    f"Column {column.name} has {_plural(count, 'value')} {side} its {key} of "
                    f"{_text(column, bound)}.",
                    resource=resource.name,
                    field=column.name,
                    rows=rows,
                    values=values,
                    count=count,
                    fix=f"Correct the values, or {move} the column's {key}.",
                )
            )
    return Outcome(problems, checks)


@rule("values.below-minimum", question="trust", scope="table", severity="error")
def below_minimum(ctx: Context) -> Outcome:
    return _bound(ctx, "minimum", "<", "below", "lower")


@rule("values.above-maximum", question="trust", scope="table", severity="error")
def above_maximum(ctx: Context) -> Outcome:
    return _bound(ctx, "maximum", ">", "above", "raise")


def _whole(bound: Any) -> int | None:
    """A length bound as a whole number, or None when it isn't one. A bool is not one."""
    if isinstance(bound, bool):
        return None
    if isinstance(bound, int):
        return bound
    if isinstance(bound, float) and bound.is_integer():
        return int(bound)
    return None


def _length(ctx: Context, key: str, compare: str, side: str, move: str) -> Outcome:
    """`minLength` or `maxLength`: the text cells with too few or too many characters."""
    problems: list[Problem] = []
    checks = 0
    for resource, relation, column, value, bound in _declared(ctx, key):
        if column.type not in TEXT_TYPES:
            continue
        checks += 1
        length = _whole(bound)
        if length is None:
            problems.append(_unusable(resource, column, key, bound, "is not a whole number"))
            continue
        rows, values, count = _evidence(relation, value, f"length({value}) {compare} {length}")
        if count:
            problems.append(
                Problem(
                    f"Column {column.name} has {_plural(count, 'value')} {side} than its "
                    f"{key} of {length}.",
                    resource=resource.name,
                    field=column.name,
                    rows=rows,
                    values=values,
                    count=count,
                    fix=f"Correct the values, or {move} the column's {key}.",
                )
            )
    return Outcome(problems, checks)


@rule("values.too-short", question="trust", scope="table", severity="error")
def too_short(ctx: Context) -> Outcome:
    return _length(ctx, "minLength", "<", "shorter", "lower")


@rule("values.too-long", question="trust", scope="table", severity="error")
def too_long(ctx: Context) -> Outcome:
    return _length(ctx, "maxLength", ">", "longer", "raise")


def _unreadable_pattern(relation: duckdb.DuckDBPyRelation, pattern: Any) -> str | None:
    """Why DuckDB can't read the pattern, or None when it can."""
    if not isinstance(pattern, str):
        return "it is not text"
    try:
        select(relation, f"SELECT regexp_full_match('', {quote_literal(pattern)})")
    except duckdb.Error as exc:
        return _first_line(exc)
    return None


@rule("values.pattern-mismatch", question="trust", scope="table", severity="error")
def pattern_mismatch(ctx: Context) -> Outcome:
    problems: list[Problem] = []
    checks = 0
    for resource, relation, column, value, pattern in _declared(ctx, "pattern"):
        if column.type not in TEXT_TYPES:
            continue
        checks += 1
        why = _unreadable_pattern(relation, pattern)
        if why is not None:
            reason = f"is not a regular expression DuckDB (RE2) can read: {why}"
            problems.append(_unusable(resource, column, "pattern", pattern, reason))
            continue
        rows, values, count = _evidence(
            relation, value, f"NOT regexp_full_match({value}, {quote_literal(pattern)})"
        )
        if count:
            problems.append(
                Problem(
                    f"Column {column.name} has {_plural(count, 'value')} that "
                    f"{_agree(count, 'does', 'do')} not match its pattern {pattern}. The "
                    "pattern is read as a DuckDB (RE2) regular expression and must match the "
                    "whole value.",
                    resource=resource.name,
                    field=column.name,
                    rows=rows,
                    values=values,
                    count=count,
                    fix="Correct the values, or change the column's pattern.",
                )
            )
    return Outcome(problems, checks)
