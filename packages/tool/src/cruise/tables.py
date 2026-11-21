"""Reading a table resource with DuckDB, the one place a file format appears.

Every value is read as text and the schema's missing values read as null, so a value that
doesn't fit its declared type becomes a finding in a rule's SQL rather than a failed read.
Parquet later is one more branch here.
"""

import codecs
import contextlib
import os
import tempfile
import weakref
from pathlib import Path
from typing import Any

import duckdb

from archive_contract.resources import Resource
from archive_contract.validate import (
    is_csv_table,
    is_tsv_table,
    readable_member,
    table_codec,
    table_dialect,
)

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
    """A CSV or TSV table the reader tried to read and could not parse."""


NATIVE = frozenset({"utf-8", "ascii"})
"""Python's names for the encodings DuckDB reads straight from the file, as UTF-8. Every
other encoding Python knows is first copied to a temporary UTF-8 file."""

NOT_TEXT = "the file is not "
NOT_KNOWN_ENCODING = "the reader does not know the encoding "
ENCODING_REASONS = (NOT_TEXT, NOT_KNOWN_ENCODING)
"""How the reason begins when a table is malformed because of its bytes, not its rows."""

CHUNK = 1 << 20
"""How many bytes of a file are decoded at a time."""

_copies: "weakref.WeakKeyDictionary[duckdb.DuckDBPyConnection, dict[tuple[Any, ...], str]]" = (
    weakref.WeakKeyDictionary()
)
"""Each connection's UTF-8 copies, by the file and encoding each was made from. A copy is
deleted when its connection is, which outlives every relation that reads it."""


def _codec(resource: Resource) -> tuple[str, str]:
    """Python's name for the resource's declared encoding (UTF-8 when it declares none), and the
    name a message gives it."""
    declared = resource.encoding or "utf-8"
    name = table_codec(resource)
    if name is None:
        raise MalformedTable(
            f"{NOT_KNOWN_ENCODING}{declared}; name one such as utf-8, latin-1 or cp1252"
        )
    return name, "UTF-8" if name == "utf-8" else declared


def _is_utf8_text(path: Path) -> bool:
    """Whether the file decodes as UTF-8 and holds no NUL, which UTF-16 text and binary do."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    try:
        with path.open("rb") as stream:
            while chunk := stream.read(CHUNK):
                if b"\0" in chunk:
                    return False
                decoder.decode(chunk)
            decoder.decode(b"", final=True)
    except (UnicodeDecodeError, OSError):
        return False
    return True


def _remove(name: str) -> None:
    with contextlib.suppress(FileNotFoundError):
        os.remove(name)


def _decoded(decoder: codecs.IncrementalDecoder, chunk: bytes, offset: int, label: str) -> str:
    """The chunk decoded; `offset` is where it starts in the file, for the message when a byte
    doesn't decode."""
    try:
        text = decoder.decode(chunk, final=not chunk)
    except UnicodeDecodeError as exc:
        # The decoder may hold bytes from the chunk before, which come first in exc.object.
        at = offset - (len(exc.object) - len(chunk)) + exc.start
        raise MalformedTable(f"{NOT_TEXT}{label} text ({exc.reason} at byte {at})") from exc
    if "\0" in text:
        raise MalformedTable(f"{NOT_TEXT}{label} text (it holds a NUL character)")
    return text


def _utf8_copy(path: Path, codec: str, label: str, connection: duckdb.DuckDBPyConnection) -> str:
    """A temporary UTF-8 copy of the file, decoded strictly from `codec`, made once per
    connection and deleted with it."""
    stat = path.stat()
    key = (str(path.resolve()), codec, stat.st_mtime_ns, stat.st_size)
    made = _copies.setdefault(connection, {})
    if key in made:
        return made[key]
    descriptor, name = tempfile.mkstemp(prefix="cruise-", suffix=".csv")
    try:
        decoder = codecs.getincrementaldecoder(codec)("strict")
        offset = 0
        with path.open("rb") as source, open(descriptor, "w", encoding="utf-8", newline="") as out:
            while chunk := source.read(CHUNK):
                out.write(_decoded(decoder, chunk, offset, label))
                offset += len(chunk)
            out.write(_decoded(decoder, b"", offset, label))
    except BaseException:
        _remove(name)
        raise
    made[key] = name
    weakref.finalize(connection, _remove, name)
    return name


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

    The columns take the schema's field names in order. Only CSV and TSV are read: a resource
    whose format says csv or tsv, or that states no format and has a path ending in `.csv` or
    `.tsv`. The file is read in the resource's declared encoding, UTF-8 when it declares none:
    DuckDB reads UTF-8 and ASCII from the file itself, and any other encoding from a UTF-8 copy.
    """
    if not is_csv_table(resource) and not is_tsv_table(resource):
        raise UnreadableTable(
            f"{resource.name} is {resource.format!r}; only csv and tsv tables are read"
        )
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
    delimiter, quote, header = table_dialect(resource)
    codec, label = _codec(resource)
    missing = [str(v) for v in (schema.missing_values or DEFAULT_MISSING_VALUES)]
    columns = "{" + ", ".join(f"{quote_literal(f.name)}: 'VARCHAR'" for f in schema.fields) + "}"
    con = connection if connection is not None else connect()
    source = root / resource.path
    native = codec in NATIVE
    path = source.as_posix() if native else _utf8_copy(source, codec, label, con)
    sql = (
        f"SELECT row_number() OVER () AS {quote_identifier(ROW)}, * FROM read_csv("
        f"{quote_literal(path)}, auto_detect = false, header = {str(header).lower()}, "
        f"columns = {columns}, delim = {quote_literal(delimiter)}, "
        f"quote = {quote_literal(quote)}, escape = {quote_literal(quote)}, "
        f"nullstr = {_literal_list(missing)}, encoding = 'utf-8')"
    )
    try:
        relation = con.sql(sql)
        # Read every column once, so a bad file or a cell not in the encoding fails here.
        relation.aggregate("count(COLUMNS(*))").fetchall()
        return relation
    except duckdb.Error as exc:
        if native and not _is_utf8_text(source):
            raise MalformedTable(f"{NOT_TEXT}{label} text") from exc
        # DuckDB ends its message with advice on reader options, which nobody here can set,
        # and the file's path on this machine.
        reason = " ".join(str(exc).split("\nPossible ", 1)[0].split())
        raise MalformedTable(reason) from exc
