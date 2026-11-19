import hashlib
import json
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from archive_contract import write_checksums
from archive_contract.findings import Finding, Target
from archive_contract.resources import Resource
from archive_contract.validate import is_csv_table, validate_package

FIXTURES = Path(__file__).parent / "fixtures"


def rule_ids(findings: list[Finding]) -> list[str]:
    return [f.rule_id for f in findings]


def edited(
    tmp_path: Path, edit: Callable[[dict[str, Any]], None], *, refresh_checksums: bool = True
) -> Path:
    """A copy of the valid fixture with its manifest edited and its checksums rewritten."""
    root = tmp_path / "package"
    shutil.copytree(FIXTURES / "valid", root)
    manifest_path = root / "datapackage.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    edit(manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if refresh_checksums:
        write_checksums(root)
    return root


def test_valid_package_has_no_findings() -> None:
    assert validate_package(FIXTURES / "valid") == []


@pytest.mark.parametrize(
    ("fixture", "rule"),
    [
        ("fk-missing-resource", "structure.foreign-key"),
        ("member-missing", "structure.file-missing"),
        ("wrong-hash", "structure.hash-mismatch"),
        ("stale-checksums", "structure.checksums-mismatch"),
    ],
)
def test_each_broken_fixture_gives_its_one_finding(fixture: str, rule: str) -> None:
    findings = validate_package(FIXTURES / fixture)

    assert rule_ids(findings) == [rule]
    assert findings[0].severity == "error"


def test_finding_names_its_target() -> None:
    [finding] = validate_package(FIXTURES / "member-missing")

    assert finding.target is not None
    assert finding.target.resource == "sites"
    assert finding.target.path == "data/sites/sites.dbf"


def test_missing_manifest(tmp_path: Path) -> None:
    assert rule_ids(validate_package(tmp_path)) == ["structure.manifest-missing"]


def test_manifest_that_is_not_json(tmp_path: Path) -> None:
    (tmp_path / "datapackage.json").write_text("{not json", encoding="utf-8")

    assert rule_ids(validate_package(tmp_path)) == ["structure.manifest-invalid"]


def test_manifest_that_breaks_the_model(tmp_path: Path) -> None:
    (tmp_path / "datapackage.json").write_text('{"version": "1.0.0"}', encoding="utf-8")

    [finding] = validate_package(tmp_path)

    assert finding.rule_id == "structure.manifest-invalid"
    assert "version" in finding.message


def test_foreign_key_to_a_missing_field(tmp_path: Path) -> None:
    def edit(m: dict[str, Any]) -> None:
        m["resources"][1]["schema"]["foreignKeys"][0]["reference"]["fields"] = ["nope"]

    assert rule_ids(validate_package(edited(tmp_path, edit))) == ["structure.foreign-key"]


def test_foreign_key_from_a_missing_local_field(tmp_path: Path) -> None:
    def edit(m: dict[str, Any]) -> None:
        m["resources"][1]["schema"]["foreignKeys"][0]["fields"] = ["nope"]

    assert rule_ids(validate_package(edited(tmp_path, edit))) == ["structure.foreign-key"]


def test_alternate_of_a_missing_resource(tmp_path: Path) -> None:
    def edit(m: dict[str, Any]) -> None:
        m["resources"][3]["archive:alternateOf"] = "nothing-here"

    assert rule_ids(validate_package(edited(tmp_path, edit))) == ["structure.alternate-of"]


def test_alternate_of_itself(tmp_path: Path) -> None:
    def edit(m: dict[str, Any]) -> None:
        m["resources"][3]["archive:alternateOf"] = "methods"

    assert rule_ids(validate_package(edited(tmp_path, edit))) == ["structure.alternate-of"]


def test_listed_file_without_size_and_hash(tmp_path: Path) -> None:
    def edit(m: dict[str, Any]) -> None:
        del m["resources"][3]["hash"]
        del m["resources"][2]["archive:files"][1]["bytes"]

    assert rule_ids(validate_package(edited(tmp_path, edit))) == [
        "structure.size-hash-missing",
        "structure.size-hash-missing",
    ]


def test_wrong_size(tmp_path: Path) -> None:
    def edit(m: dict[str, Any]) -> None:
        m["resources"][3]["bytes"] = 1

    assert rule_ids(validate_package(edited(tmp_path, edit))) == ["structure.size-mismatch"]


def test_main_file_not_among_members(tmp_path: Path) -> None:
    def edit(m: dict[str, Any]) -> None:
        m["resources"][2]["archive:files"] = m["resources"][2]["archive:files"][1:]

    assert rule_ids(validate_package(edited(tmp_path, edit))) == ["structure.main-not-member"]


def test_path_outside_the_package_is_refused_and_not_read(tmp_path: Path) -> None:
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")

    def edit(m: dict[str, Any]) -> None:
        m["resources"][3]["path"] = "../secret.txt"

    assert rule_ids(validate_package(edited(tmp_path, edit))) == ["structure.path-unsafe"]


def test_linked_resource_is_not_looked_for_on_disk(tmp_path: Path) -> None:
    def edit(m: dict[str, Any]) -> None:
        m["resources"].append(
            {
                "name": "discharge",
                "path": "https://example.org/discharge.csv",
                "archive:kind": "linked",
            }
        )

    assert validate_package(edited(tmp_path, edit)) == []


def test_missing_checksums_file(tmp_path: Path) -> None:
    root = edited(tmp_path, lambda m: None)
    (root / "checksums.sha256").unlink()

    assert rule_ids(validate_package(root)) == ["structure.checksums-missing"]


def test_file_with_no_checksums_line(tmp_path: Path) -> None:
    root = edited(tmp_path, lambda m: None)
    (root / "docs" / "extra.txt").write_text("not listed", encoding="utf-8")

    assert rule_ids(validate_package(root)) == ["structure.checksums-unlisted"]


def test_checksums_line_for_a_missing_file(tmp_path: Path) -> None:
    root = edited(tmp_path, lambda m: None)
    with (root / "checksums.sha256").open("a", encoding="utf-8") as out:
        out.write(f"{'0' * 64}  docs/gone.txt\n")

    assert rule_ids(validate_package(root)) == ["structure.checksums-orphan"]


def test_only_the_top_level_build_folder_is_exempt_from_checksums(tmp_path: Path) -> None:
    root = edited(tmp_path, lambda m: None)
    (root / "_build").mkdir()
    (root / "_build" / "make.py").write_text("print()", encoding="utf-8")

    assert validate_package(root) == []


@pytest.mark.parametrize("extra", [".DS_Store", "data/_readings.csv", "docs/_build/x.txt"])
def test_hidden_and_underscore_files_need_a_checksums_line(tmp_path: Path, extra: str) -> None:
    root = edited(tmp_path, lambda m: None)
    (root / extra).parent.mkdir(parents=True, exist_ok=True)
    (root / extra).write_text("x", encoding="utf-8")

    findings = validate_package(root)

    assert rule_ids(findings) == ["structure.checksums-unlisted"]
    assert findings[0].target is not None and findings[0].target.path == extra


def outside_copy(tmp_path: Path, relative: str) -> Path:
    """A copy of a fixture file or folder outside the package, for a symlink to point at."""
    source = FIXTURES / "valid" / relative
    target = tmp_path / "outside" / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target)
    else:
        shutil.copy(source, target)
    return target


@pytest.mark.parametrize(
    "relative",
    [
        "datapackage.json",
        "checksums.sha256",
        "docs/methods.md",
        "data/sites",
        "data/sites/sites.dbf",
    ],
)
def test_symlink_is_refused_and_not_followed(tmp_path: Path, relative: str) -> None:
    root = edited(tmp_path, lambda m: None)
    target = outside_copy(tmp_path, relative)
    link = root / relative
    if link.is_dir():
        shutil.rmtree(link)
    else:
        link.unlink()
    link.symlink_to(target)

    findings = validate_package(root)

    assert rule_ids(findings) == ["structure.symlink"]
    assert findings[0].target is not None and findings[0].target.path == relative


def test_unlisted_symlink_is_refused(tmp_path: Path) -> None:
    root = edited(tmp_path, lambda m: None)
    (root / "docs" / "elsewhere").symlink_to(outside_copy(tmp_path, "docs/methods.md"))

    assert rule_ids(validate_package(root)) == ["structure.symlink"]


def _hash_of(path: Path, algorithm: str) -> str:
    return hashlib.new(algorithm, path.read_bytes()).hexdigest()


@pytest.mark.parametrize(
    "recorded",
    [
        lambda p: f"md5:{_hash_of(p, 'md5')}",
        lambda p: _hash_of(p, "md5"),
        lambda p: f"sha1:{_hash_of(p, 'sha1')}",
        lambda p: f"SHA256:{_hash_of(p, 'sha256')}",
        lambda p: f"sha512:{_hash_of(p, 'sha512')}",
    ],
)
def test_the_four_frictionless_hash_algorithms_are_accepted(
    tmp_path: Path, recorded: Callable[[Path], str]
) -> None:
    methods = FIXTURES / "valid" / "docs" / "methods.md"

    def edit(m: dict[str, Any]) -> None:
        m["resources"][3]["hash"] = recorded(methods)

    assert validate_package(edited(tmp_path, edit)) == []


@pytest.mark.parametrize("algorithm", ["shake_128", "shake_256", "sha224", "blake2b", "nope"])
def test_other_hash_algorithms_are_a_finding_not_an_exception(
    tmp_path: Path, algorithm: str
) -> None:
    def edit(m: dict[str, Any]) -> None:
        m["resources"][3]["hash"] = f"{algorithm}:abcdef"

    assert rule_ids(validate_package(edited(tmp_path, edit))) == ["structure.hash-algorithm"]


SITES_DBF = FIXTURES / "dbf" / "sites.dbf"
"""A real dBASE file with the columns site_id and elev_m."""


def with_attributes(tmp_path: Path, fields: list[dict[str, Any]], *, dbf: Path = SITES_DBF) -> Path:
    """The valid fixture with `dbf` as the sites shapefile's .dbf, described by `fields`."""

    def edit(m: dict[str, Any]) -> None:
        sites = m["resources"][2]
        sites["archive:attributes"] = {"fields": fields}
        member = next(f for f in sites["archive:files"] if f["path"].endswith(".dbf"))
        member["bytes"] = dbf.stat().st_size
        member["hash"] = f"sha256:{_hash_of(dbf, 'sha256')}"

    root = tmp_path / "package"
    shutil.copytree(FIXTURES / "valid", root)
    shutil.copy(dbf, root / "data" / "sites" / "sites.dbf")
    manifest_path = root / "datapackage.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    edit(manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    write_checksums(root)
    return root


SITE_ID = {"name": "site_id", "type": "string"}
ELEV_M = {"name": "elev_m", "type": "number"}


def test_attributes_matching_the_dbf_have_no_findings(tmp_path: Path) -> None:
    assert validate_package(with_attributes(tmp_path, [SITE_ID, ELEV_M])) == []


def test_attribute_matched_by_its_source_name(tmp_path: Path) -> None:
    renamed = {"name": "elevation_m", "type": "number", "archive:sourceName": "elev_m"}

    assert validate_package(with_attributes(tmp_path, [SITE_ID, renamed])) == []


def test_attribute_described_but_absent_from_the_dbf(tmp_path: Path) -> None:
    extra = {"name": "habitat", "type": "string"}

    findings = validate_package(with_attributes(tmp_path, [SITE_ID, ELEV_M, extra]))

    assert rule_ids(findings) == ["structure.attributes-mismatch"]
    target = findings[0].target
    assert target is not None
    assert (target.resource, target.field, target.path) == (
        "sites",
        "habitat",
        "data/sites/sites.dbf",
    )


def test_dbf_column_not_described(tmp_path: Path) -> None:
    findings = validate_package(with_attributes(tmp_path, [SITE_ID]))

    assert rule_ids(findings) == ["structure.attributes-mismatch"]
    assert findings[0].target is not None and findings[0].target.field == "elev_m"


def test_unreadable_dbf_is_a_finding_not_an_exception(tmp_path: Path) -> None:
    findings = validate_package(
        with_attributes(tmp_path, [SITE_ID], dbf=FIXTURES / "valid" / "data/sites/sites.dbf")
    )

    assert rule_ids(findings) == ["structure.attributes-mismatch"]


def test_symlinked_dbf_is_refused_and_not_read(tmp_path: Path) -> None:
    root = with_attributes(tmp_path, [SITE_ID])
    outside = tmp_path / "outside.dbf"
    shutil.copy(SITES_DBF, outside)
    link = root / "data" / "sites" / "sites.dbf"
    link.unlink()
    link.symlink_to(outside)

    assert rule_ids(validate_package(root)) == ["structure.symlink"]


def test_vector_with_no_dbf_member_is_not_checked(tmp_path: Path) -> None:
    def edit(m: dict[str, Any]) -> None:
        sites = m["resources"][2]
        sites["archive:files"] = sites["archive:files"][:1]
        sites["archive:attributes"] = {"fields": [SITE_ID]}

    root = edited(tmp_path, edit)

    assert "structure.attributes-mismatch" not in rule_ids(validate_package(root))


def with_table(
    tmp_path: Path,
    csv: bytes,
    fields: list[str],
    *,
    dialect: dict[str, Any] | None = None,
    primary_key: Any = None,
    table_format: str | None = "csv",
    path: str = "data/t.csv",
) -> Path:
    """The valid fixture with one more table `t`, its file holding the bytes given."""

    def edit(manifest: dict[str, Any]) -> None:
        file = tmp_path / "package" / path
        file.write_bytes(csv)
        schema: dict[str, Any] = {"fields": [{"name": name} for name in fields]}
        if primary_key is not None:
            schema["primaryKey"] = primary_key
        resource: dict[str, Any] = {
            "name": "t",
            "path": path,
            "type": "table",
            "bytes": len(csv),
            "hash": f"sha256:{hashlib.sha256(csv).hexdigest()}",
            "schema": schema,
        }
        if table_format is not None:
            resource["format"] = table_format
        if dialect is not None:
            resource["dialect"] = dialect
        manifest["resources"].append(resource)

    return edited(tmp_path, edit)


def test_header_matching_the_manifest_has_no_findings(tmp_path: Path) -> None:
    assert validate_package(with_table(tmp_path, b"a,b\n1,2\n", ["a", "b"])) == []


def test_header_in_another_order_names_the_column_and_both_names(tmp_path: Path) -> None:
    [finding] = validate_package(with_table(tmp_path, b"b,a\n1,2\n", ["a", "b"]))

    assert finding.rule_id == "structure.header-mismatch" and finding.severity == "error"
    assert finding.message == (
        "data/t.csv: column 1 is named 'b' in the file's header row, but the manifest names it 'a'"
    )
    assert finding.target == Target(resource="t", field="a", path="data/t.csv")
    assert finding.evidence is not None and finding.evidence.values == ["b", "a"]


def test_header_with_fewer_columns_names_the_missing_field(tmp_path: Path) -> None:
    [finding] = validate_package(with_table(tmp_path, b"a\n1\n", ["a", "b"]))

    assert finding.message == (
        "data/t.csv: the header row has 1 columns, but the manifest describes 2; "
        "the file has no column for 'b'"
    )
    assert finding.target == Target(resource="t", field="b", path="data/t.csv")
    assert finding.evidence is not None and finding.evidence.values == [1, 2]


def test_an_empty_table_file_has_a_header_of_no_columns(tmp_path: Path) -> None:
    [finding] = validate_package(with_table(tmp_path, b"", ["a", "b"]))

    assert finding.message == (
        "data/t.csv: the header row has 0 columns, but the manifest describes 2; "
        "the file has no column for 'a'"
    )


def test_header_with_more_columns_names_the_extra_column(tmp_path: Path) -> None:
    [finding] = validate_package(with_table(tmp_path, b"a,b,c\n", ["a", "b"]))

    assert finding.rule_id == "structure.header-mismatch"
    assert finding.message.endswith("the manifest has no field for the file's column 'c'")
    assert finding.target == Target(resource="t", path="data/t.csv")
    assert finding.evidence is not None and finding.evidence.values == [3, 2]


def test_header_after_a_byte_order_mark_matches(tmp_path: Path) -> None:
    root = with_table(tmp_path, b"\xef\xbb\xbfa,b\n1,2\n", ["a", "b"])

    assert validate_package(root) == []


def test_header_with_a_space_around_a_name_is_a_mismatch(tmp_path: Path) -> None:
    [finding] = validate_package(with_table(tmp_path, b"a, b\n1,2\n", ["a", "b"]))

    assert finding.evidence is not None and finding.evidence.values == [" b", "b"]


def test_header_differing_only_in_case_is_a_mismatch(tmp_path: Path) -> None:
    assert rule_ids(validate_package(with_table(tmp_path, b"A,b\n", ["a", "b"]))) == [
        "structure.header-mismatch"
    ]


@pytest.mark.parametrize("header", [False, 0])
def test_a_table_with_no_header_row_is_not_compared(tmp_path: Path, header: Any) -> None:
    root = with_table(tmp_path, b"1,2\n", ["a", "b"], dialect={"header": header})

    assert validate_package(root) == []


def test_header_is_read_with_the_dialects_delimiter(tmp_path: Path) -> None:
    root = with_table(tmp_path, b"a;b\n1;2\n", ["a", "b"], dialect={"delimiter": ";"})

    assert validate_package(root) == []


def test_header_is_read_with_the_dialects_quote_character(tmp_path: Path) -> None:
    root = with_table(tmp_path, b"'a,x',b\n1,2\n", ["a,x", "b"], dialect={"quoteChar": "'"})

    assert validate_package(root) == []


def test_comment_line_before_the_header_is_a_mismatch(tmp_path: Path) -> None:
    root = with_table(tmp_path, b"# Monthly means\na,b\n1,2\n", ["a", "b"])

    assert rule_ids(validate_package(root)) == ["structure.header-mismatch"]


def test_a_table_that_is_not_utf8_is_left_to_the_reader(tmp_path: Path) -> None:
    assert validate_package(with_table(tmp_path, b"\xe9,b\n\xff,2\n", ["a", "b"])) == []


@pytest.mark.parametrize("dialect", [{"delimiter": "||"}, {"delimiter": ""}, {"quoteChar": "''"}])
def test_a_two_character_delimiter_gets_no_header_finding_and_no_traceback(
    tmp_path: Path, dialect: dict[str, Any]
) -> None:
    root = with_table(tmp_path, b"b||a\n1||2\n", ["a", "b"], dialect=dialect)

    assert validate_package(root) == []


def test_a_csv_path_with_no_format_gets_the_header_check(tmp_path: Path) -> None:
    root = with_table(tmp_path, b"b,a\n", ["a", "b"], table_format=None)

    assert rule_ids(validate_package(root)) == ["structure.header-mismatch"]


def test_renaming_a_field_of_a_table_with_no_format_is_a_header_mismatch(tmp_path: Path) -> None:
    def edit(manifest: dict[str, Any]) -> None:
        assert "format" not in manifest["resources"][1]
        manifest["resources"][1]["schema"]["fields"][0]["name"] = "station"

    [finding] = validate_package(edited(tmp_path, edit))

    assert finding.rule_id == "structure.header-mismatch"
    assert finding.target == Target(resource="readings", field="station", path="data/readings.csv")


@pytest.mark.parametrize(
    ("table_format", "path", "expected"),
    [
        ("csv", "data/t.csv", True),
        ("CSV", "data/t.txt", True),
        (None, "data/t.csv", True),
        (None, "data/t.CSV", True),
        (None, "data/t.txt", False),
        ("json", "data/t.csv", False),
        ("", "data/t.csv", False),
    ],
)
def test_is_csv_table(table_format: str | None, path: str, expected: bool) -> None:
    resource = Resource.model_validate({"name": "t", "path": path, "format": table_format})

    assert is_csv_table(resource) is expected


def test_a_csv_path_with_another_format_gets_no_header_check(tmp_path: Path) -> None:
    root = with_table(tmp_path, b"b,a\n", ["a", "b"], table_format="json")

    assert validate_package(root) == []


def test_primary_key_naming_a_missing_field(tmp_path: Path) -> None:
    root = with_table(tmp_path, b"a,b\n", ["a", "b"], primary_key=["zzz"])

    [finding] = validate_package(root)

    assert finding.rule_id == "structure.primary-key" and finding.severity == "error"
    assert finding.message == "primary key uses 'zzz', which is not a field of this table"
    assert finding.target == Target(resource="t", field="zzz")


def test_primary_key_given_as_one_name_is_checked_too(tmp_path: Path) -> None:
    root = with_table(tmp_path, b"a,b\n", ["a", "b"], primary_key="zzz")

    assert rule_ids(validate_package(root)) == ["structure.primary-key"]


def test_primary_key_naming_its_tables_fields_has_no_findings(tmp_path: Path) -> None:
    root = with_table(tmp_path, b"a,b\n", ["a", "b"], primary_key=["a", "b"])

    assert validate_package(root) == []


def test_foreign_key_with_field_lists_of_different_lengths(tmp_path: Path) -> None:
    def edit(manifest: dict[str, Any]) -> None:
        manifest["resources"][1]["schema"]["foreignKeys"][0]["fields"] = ["condition", "site"]

    [finding] = validate_package(edited(tmp_path, edit))

    assert finding.rule_id == "structure.foreign-key"
    assert finding.message == "foreign key on condition, site names 2 fields but points at 1"
    assert finding.target == Target(resource="readings", field="condition")
