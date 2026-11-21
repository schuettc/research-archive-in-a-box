import json
import shutil
from functools import partial
from pathlib import Path
from typing import Any

import pytest

from archive_contract.findings import Finding
from archive_contract.manifest import QualityVerdict, ValidationVerdict
from cruise.cli import main
from cruise.diagnose import diagnose
from cruise.rules import Context, Outcome, Registry

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"


def test_version_prints_name_and_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["--version"])

    assert exit_info.value.code == 0
    assert capsys.readouterr().out == "cruise 0.1.3\n"


def test_diagnose_prints_findings_by_question_then_score_and_verdict(
    capsys: pytest.CaptureFixture[str],
) -> None:
    code = main(["diagnose", str(SAMPLE)])

    out = capsys.readouterr().out
    assert code == 0
    assert "Can I understand each column?" in out
    assert "logger.battery_v" in out
    assert "fix: " in out
    lines = out.rstrip().splitlines()
    assert lines[-2].startswith("Score: ") and "(find 5 of 5, understand " in lines[-2]
    assert lines[-1].startswith("Verdict: publishable, with ")


def test_diagnose_json_round_trips_through_the_contract(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["diagnose", str(SAMPLE), "--json"]) == 0

    data = json.loads(capsys.readouterr().out)
    assert ValidationVerdict.model_validate(data["validation"]).valid
    assert QualityVerdict.model_validate(data["quality"]).errors == 0
    findings = [Finding.model_validate(f) for f in data["findings"]]
    assert [f.dump() for f in findings] == data["findings"]
    assert len(findings) >= 3


def test_diagnose_exits_1_when_a_finding_blocks_publishing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(["diagnose", str(tmp_path)])

    assert code == 1
    assert "Verdict: blocks publishing (1)" in capsys.readouterr().out


def test_diagnose_profile_requires_its_fields(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config = tmp_path / "archive.yaml"
    config.write_text("publisher: Example\nprofiles: [core]\nrequired: [keywords]\n")

    assert main(["diagnose", str(SAMPLE), "--profile", "ecology", "--config", str(config)]) == 0
    assert "(find 9 of 9, " in capsys.readouterr().out


def test_diagnose_refuses_an_unknown_profile(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["diagnose", str(SAMPLE), "--profile", "astronomy"]) == 2
    assert "no profile named" in capsys.readouterr().err


WRITTEN = ("datapackage.json", "README.md", "checksums.sha256")


@pytest.fixture
def package(tmp_path: Path) -> Path:
    root = tmp_path / "sample"
    shutil.copytree(SAMPLE, root)
    return root


def manifest_json(root: Path) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((root / "datapackage.json").read_text())
    return data


def snapshot(root: Path) -> dict[str, bytes]:
    return {name: (root / name).read_bytes() for name in WRITTEN}


def test_set_writes_a_plain_string_value(package: Path, capsys: pytest.CaptureFixture[str]) -> None:
    before = snapshot(package)

    assert main(["set", str(package), "archive:embargoUntil", "2027-06-01"]) == 0

    assert manifest_json(package)["archive:embargoUntil"] == "2027-06-01"
    assert "archive:embargoUntil" in capsys.readouterr().out
    after = snapshot(package)
    assert all(after[name] != before[name] for name in ("datapackage.json", "checksums.sha256"))


def test_set_reads_a_value_that_parses_as_json_as_json(package: Path) -> None:
    people = [{"title": "Ada Invented", "orcid": "0000-0002-1825-0097", "roles": ["creator"]}]

    assert main(["set", str(package), "contributors", json.dumps(people)]) == 0

    assert manifest_json(package)["contributors"] == people


def test_set_edits_a_column(package: Path) -> None:
    code = main(
        [
            "set", str(package), "description", "Logger battery voltage.",
            "--resource", "logger", "--column", "battery_v",
        ]
    )  # fmt: skip

    assert code == 0
    [logger] = [r for r in manifest_json(package)["resources"] if r["name"] == "logger"]
    [battery] = [f for f in logger["schema"]["fields"] if f["name"] == "battery_v"]
    assert battery["description"] == "Logger battery voltage."


def test_set_a_failing_edit_writes_nothing_and_exits_1(
    package: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    before = snapshot(package)

    assert main(["set", str(package), "archive:embargoUntil", "next spring"]) == 1

    assert snapshot(package) == before
    assert "edit 1" in capsys.readouterr().err


def test_set_file_applies_every_edit_or_none(
    package: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    edits = tmp_path / "edits.json"
    edits.write_text(
        json.dumps(
            [
                {"target": "title", "value": "A new title"},
                {"target": "name", "value": "renamed"},
            ]
        )
    )
    before = snapshot(package)

    assert main(["set", str(package), "--file", str(edits)]) == 1

    assert snapshot(package) == before
    err = capsys.readouterr().err
    assert "edit 2" in err and "edit 1" not in err


def test_set_column_without_resource_says_which_flag_is_missing(
    package: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    before = snapshot(package)

    assert main(["set", str(package), "description", "Volts.", "--column", "battery_v"]) == 2

    assert snapshot(package) == before
    assert capsys.readouterr().err == "cruise: give --resource with --column\n"


@pytest.mark.parametrize(
    ("edit", "reason"),
    [
        (
            {"target": ["title"], "value": "A new title"},
            "edit 1: a target is one name, such as title, not ['title']",
        ),
        (
            {"target": "description", "value": "Volts.", "column": "battery_v"},
            "edit 1: a column edit names its resource as well as its column",
        ),
    ],
    ids=["a list target", "a column with no resource"],
)
def test_set_file_with_a_malformed_edit_says_why_without_a_traceback(
    package: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    edit: dict[str, Any],
    reason: str,
) -> None:
    edits = tmp_path / "edits.json"
    edits.write_text(json.dumps([edit]))
    before = snapshot(package)

    assert main(["set", str(package), "--file", str(edits)]) == 1

    assert snapshot(package) == before
    assert capsys.readouterr().err == f"cruise: Nothing was written. {reason}\n"


def test_set_takes_a_text_targets_value_as_text(package: Path) -> None:
    assert main(["set", str(package), "title", "2027"]) == 0

    assert manifest_json(package)["title"] == "2027"


def test_set_takes_a_column_units_value_as_text(package: Path) -> None:
    code = main(
        ["set", str(package), "archive:unit", "1", "--resource", "logger", "--column", "battery_v"]
    )

    assert code == 0
    [logger] = [r for r in manifest_json(package)["resources"] if r["name"] == "logger"]
    [battery] = [f for f in logger["schema"]["fields"] if f["name"] == "battery_v"]
    assert battery["archive:unit"] == "1"


def test_set_null_still_removes_a_text_target(package: Path) -> None:
    assert main(["set", str(package), "archive:methods", "null"]) == 0

    assert "archive:methods" not in manifest_json(package)


def test_set_still_reads_a_rights_status_object_as_json(package: Path) -> None:
    status = {"status": "public-domain", "statement": "No rights reserved."}

    assert main(["set", str(package), "licenses", "null"]) == 0
    assert main(["set", str(package), "archive:rightsStatus", json.dumps(status)]) == 0

    assert manifest_json(package)["archive:rightsStatus"] == status


def test_diagnose_prints_a_failed_check_under_its_own_heading_and_exits_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    registry = Registry()

    @registry.rule("values.broken", question="trust", scope="table", severity="warning")
    def broken(ctx: Context) -> Outcome:
        raise RuntimeError("no such thing")

    monkeypatch.setattr("cruise.cli.diagnose", partial(diagnose, registry=registry))

    code = main(["diagnose", str(SAMPLE)])

    out = capsys.readouterr().out
    assert code == 1
    assert "Checks that could not run (a fault in cruise, not in your package)" in out
    assert "  error  values.check-failed  package" in out
    assert out.rstrip().splitlines()[-1] == "Verdict: blocks publishing (1)"
