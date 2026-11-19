import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from archive_agent import local, server, state, submit
from archive_agent.errors import Refused
from archive_agent.state import Session
from archive_client.signin import Tokens
from archive_contract import write_checksums

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"
ECOLOGY = {"profiles": ["core", "ecology"], "required": []}

# `archive` is the stub from conftest.py, answering /auth-config.json as a deployed archive does.


@pytest.fixture
def no_methods(tmp_path: Path) -> Path:
    """The walk copy: the sample package without archive:methods, its checksums rewritten."""
    root = tmp_path / "sample"
    shutil.copytree(SAMPLE, root)
    manifest = root / "datapackage.json"
    document = json.loads(manifest.read_text())
    del document["archive:methods"]
    manifest.write_text(json.dumps(document, indent=2) + "\n")
    write_checksums(root)
    return root


def missing(answer: dict[str, Any]) -> list[tuple[str, str, list[Any]]]:
    return [
        (f["ruleId"], f["severity"], f["evidence"]["values"])
        for f in answer["findings"]
        if f["ruleId"] == "package.profile-field-missing"
    ]


def test_connect_keeps_the_archives_checks_with_its_url(archive: Any, config_home: Path) -> None:
    archive.json("GET /archive-checks.json", ECOLOGY)

    answer = server.connect(Session(), archive.url)

    saved = json.loads((config_home / "research-archive-in-a-box" / "archive.json").read_text())
    assert saved == {"url": archive.url, "checks": ECOLOGY}
    assert answer["checks"] == ECOLOGY


def test_diagnose_checks_what_the_archive_checks(archive: Any, no_methods: Path) -> None:
    archive.json("GET /archive-checks.json", ECOLOGY)
    server.connect(Session(), archive.url)

    answer = local.diagnose(str(no_methods))

    assert missing(answer) == [("package.profile-field-missing", "error", ["archive:methods"])]
    assert answer["verdict"].startswith("blocks publishing")
    assert answer["checks"] == {"archive": archive.url, **ECOLOGY}
    assert "note" not in answer


def test_submit_refuses_what_the_archive_would_send_back(
    archive: Any, no_methods: Path, tokens: Tokens
) -> None:
    archive.json("GET /archive-checks.json", ECOLOGY)
    server.connect(Session(), archive.url)
    archive.seen.clear()

    with pytest.raises(Refused, match="1 error finding"):
        submit.submit(Session(tokens=tokens, groups=["contributor"]), str(no_methods))

    assert [(s.method, s.path) for s in archive.seen] == [("GET", "/archive-checks.json")]


def test_submit_rereads_the_archives_checks_before_its_check(
    archive: Any, no_methods: Path, tokens: Tokens
) -> None:
    archive.json("GET /archive-checks.json", {"profiles": ["core"], "required": []})
    server.connect(Session(), archive.url)
    archive.json("GET /archive-checks.json", ECOLOGY)
    archive.seen.clear()

    with pytest.raises(Refused, match="1 error finding"):
        submit.submit(Session(tokens=tokens, groups=["contributor"]), str(no_methods))

    assert [(s.method, s.path) for s in archive.seen] == [("GET", "/archive-checks.json")]
    assert state.saved_checks() == ECOLOGY


def test_submit_keeps_the_saved_checks_when_the_archive_cant_answer_them(
    archive: Any, no_methods: Path, tokens: Tokens
) -> None:
    archive.json("GET /archive-checks.json", ECOLOGY)
    server.connect(Session(), archive.url)
    archive.json("GET /archive-checks.json", {"message": "boom"}, 500)

    with pytest.raises(Refused, match="1 error finding"):
        submit.submit(Session(tokens=tokens, groups=["contributor"]), str(no_methods))

    assert state.saved_checks() == ECOLOGY


def test_diagnose_skips_a_profile_cruise_doesnt_know_and_names_it(
    archive: Any, no_methods: Path
) -> None:
    state.save_url(archive.url, {"profiles": ["core", "marine"], "required": []})

    result = local.diagnose(str(no_methods))

    assert missing(result) == []
    assert "marine" in result["note"]
    assert result["checks"] == {
        "archive": archive.url,
        "profiles": ["core", "marine"],
        "required": [],
    }


def test_an_archive_without_the_file_gets_core_rules_and_says_so(
    archive: Any, no_methods: Path, config_home: Path
) -> None:
    answer = server.connect(Session(), archive.url)
    saved = json.loads((config_home / "research-archive-in-a-box" / "archive.json").read_text())

    result = local.diagnose(str(no_methods))

    assert saved == {"url": archive.url}
    assert answer["checks_note"] == (
        "This archive doesn't publish its requirements, so checks use the basic set only."
    )
    assert missing(result) == []
    assert not [f for f in result["findings"] if f["severity"] == "error"]
    assert "weren't available" in result["note"]


def test_diagnose_with_no_archive_connected_checks_core_rules_and_says_so(
    no_methods: Path,
) -> None:
    result = local.diagnose(str(no_methods))

    assert missing(result) == []
    assert "weren't available" in result["note"]


LIMITED = {**ECOLOGY, "maxPackageGiB": 9}


def test_refresh_checks_answers_the_archives_package_limit(archive: Any) -> None:
    archive.json("GET /archive-checks.json", LIMITED)
    state.save_url(archive.url)

    assert state.refresh_checks(archive.url) == 9 * 1024**3
    assert state.saved_checks() == ECOLOGY


def test_refresh_checks_answers_none_without_a_limit(archive: Any) -> None:
    archive.json("GET /archive-checks.json", ECOLOGY)
    state.save_url(archive.url)

    assert state.refresh_checks(archive.url) is None

    archive.json("GET /archive-checks.json", {"message": "boom"}, 500)
    assert state.refresh_checks(archive.url) is None


def test_diagnose_states_the_archives_package_limit_with_its_checks(
    archive: Any, no_methods: Path
) -> None:
    archive.json("GET /archive-checks.json", LIMITED)
    server.connect(Session(), archive.url)

    answer = local.diagnose(str(no_methods))

    assert answer["checks"] == {"archive": archive.url, **ECOLOGY, "maxPackageGiB": 9}


def test_diagnose_states_a_limit_the_archive_changed_since_connect(
    archive: Any, no_methods: Path
) -> None:
    archive.json("GET /archive-checks.json", LIMITED)
    server.connect(Session(), archive.url)
    archive.json("GET /archive-checks.json", {**ECOLOGY, "maxPackageGiB": 4})

    state.refresh_checks(archive.url)

    assert local.diagnose(str(no_methods))["checks"]["maxPackageGiB"] == 4
