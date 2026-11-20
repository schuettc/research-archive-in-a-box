"""Reading a table resource with DuckDB, the one place a file format appears.

Every value is read as text and the schema's missing values read as null, so a value that
doesn't fit its declared type becomes a finding in a rule's SQL rather than a failed read.
Parquet later is one more branch here.
"""

import codecs
from pathlib import Path
from typing import Any

import duckdb

from archive_contract.resources import Resource
from archive_contract.validate import is_csv_table, readable_member

RESERVED = "cruise:"
"""The prefix of every name the reader and the rules give a column of their own. No column of
a table may start with it, so a working name can never be one of the table's."""

ROW = RESERVED + "row"
"""The column holding each row's 1-based number among the data rows."""

GLOB_CHARACTERS = frozenset("*?[{}")
"""Characters DuckDB would expand in a path, reading files the resource doesn't list."""

DEFAULT_MISSING_VALUES = [""]
"""Table Schema's missing values when a schema states none."""


class UnreadableTable(ValueError):
    """A table resource this reader can't open."""


class MalformedTable(UnreadableTable):
    """A CSV table the reader tried to read and could not parse."""


NOT_UTF8 = "the file is not UTF-8 text"
"""Why a table is malformed when its bytes, not its rows, are the cause."""


def _is_utf8_text(path: Path) -> bool:
    """Whether the file decodes as UTF-8 and holds no NUL, which UTF-16 text and binary do."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    try:
        with path.open("rb") as stream:
            while chunk := stream.read(1 << 20):
                if b"\0" in chunk:
                    return False
                decoder.decode(chunk)
            decoder.decode(b"", final=True)
    except (UnicodeDecodeError, OSError):
        return False
    return True


def connect() -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB that never installs or loads an extension, so never fetches one."""
    return duckdb.connect(
        ":memory:",
        config={"autoinstall_known_extensions": False, "autoload_known_extensions": False},
    )


def quote_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def working(name: str) -> str:
    """A working name for a rule's SQL, quoted: one no column of a table can have."""
    return quote_identifier(RESERVED + name)


def quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def select(relation: duckdb.DuckDBPyRelation, sql: str) -> list[tuple[Any, ...]]:
    """The rows of `sql` run over the relation, which it names `t`."""
    result = relation.query("t", sql)
    return [] if result is None else result.fetchall()


def _literal_list(values: list[str]) -> str:
    return "[" + ", ".join(quote_literal(v) for v in values) + "]"


def read_table(
    root: Path, resource: Resource, connection: duckdb.DuckDBPyConnection | None = None
) -> duckdb.DuckDBPyRelation:
    """A relation over the resource's file, every column as text, with its row number in `ROW`.

    The columns take the schema's field names in order. Only CSV is read: a resource whose
    format says csv, or that states no format and has a path ending in `.csv`.
    """
    if not is_csv_table(resource):
        raise UnreadableTable(f"{resource.name} is {resource.format!r}; only csv tables are read")
    if not isinstance(resource.path, str) or not readable_member(root, resource.path):
        raise UnreadableTable(f"{resource.name} has no single file inside the package to read")
    if GLOB_CHARACTERS & set(resource.path):
        raise UnreadableTable(
            f"{resource.name}'s path {resource.path} holds a glob character (* ? [ {{ }}), "
            "which the reader would expand"
        )
    schema = resource.table_schema
    if schema is None or not schema.fields:
        raise UnreadableTable(f"{resource.name} has no schema to read it by")
    for name in schema.field_names():
        if name.startswith(RESERVED):
            raise UnreadableTable(
                f"{resource.name} has a column named {name!r}; names that start with "
                f"{RESERVED!r} are kept for the reader"
            )
    dialect = resource.dialect or {}
    delimiter = str(dialect.get("delimiter", ","))
    quote = str(dialect.get("quoteChar", '"'))
    header = bool(dialect.get("header", True))
    missing = [str(v) for v in (schema.missing_values or DEFAULT_MISSING_VALUES)]
    columns = "{" + ", ".join(f"{quote_literal(f.name)}: 'VARCHAR'" for f in schema.fields) + "}"
    path = (root / resource.path).as_posix()
    sql = (
        f"SELECT row_number() OVER () AS {quote_identifier(ROW)}, * FROM read_csv("
        f"{quote_literal(path)}, auto_detect = false, header = {str(header).lower()}, "
        f"columns = {columns}, delim = {quote_literal(delimiter)}, "
        f"quote = {quote_literal(quote)}, escape = {quote_literal(quote)}, "
        f"nullstr = {_literal_list(missing)}, encoding = 'utf-8')"
    )
    con = connection if connection is not None else connect()
    try:
        relation = con.sql(sql)
        # Read every column once, so a bad file or a cell that is not UTF-8 fails here.
        relation.aggregate("count(COLUMNS(*))").fetchall()
        return relation
    except duckdb.Error as exc:
        if not _is_utf8_text(root / resource.path):
            raise MalformedTable(NOT_UTF8) from exc
        # DuckDB ends its message with advice on reader options, which nobody here can set,
        # and the file's path on this machine.
        reason = " ".join(str(exc).split("\nPossible ", 1)[0].split())
        raise MalformedTable(reason) from exc
