import json
import shutil
import time
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

    answer = local.diagnose(Session(), str(no_methods))

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

    result = local.diagnose(Session(), str(no_methods))

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

    result = local.diagnose(Session(), str(no_methods))

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
    result = local.diagnose(Session(), str(no_methods))

    assert missing(result) == []
    assert "weren't available" in result["note"]


def test_two_sessions_each_diagnose_under_their_own_archives_checks(
    archive: Any, other: Any, no_methods: Path
) -> None:
    archive.json("GET /archive-checks.json", ECOLOGY)
    other.json("GET /archive-checks.json", {"profiles": ["core"], "required": []})
    first, second = Session(), Session()
    server.connect(first, archive.url)
    server.connect(second, other.url)

    strict = local.diagnose(first, str(no_methods))
    loose = local.diagnose(second, str(no_methods))

    assert strict["checks"]["archive"] == archive.url
    assert missing(strict) == [("package.profile-field-missing", "error", ["archive:methods"])]
    assert loose["checks"]["archive"] == other.url
    assert missing(loose) == []


def test_refresh_checks_leaves_another_archives_default_alone(
    archive: Any, other: Any, no_methods: Path, config_home: Path
) -> None:
    archive.json("GET /archive-checks.json", {"profiles": ["core"], "required": []})
    first = Session()
    server.connect(first, archive.url)
    first.tokens = Tokens(
        access_token="a", id_token="t", expires_at=time.time() + 3600, site=archive.url
    )
    first.groups = ["contributor"]
    server.connect(Session(), other.url)  # the default is now the other archive
    before = (config_home / "research-archive-in-a-box" / "archive.json").read_bytes()
    archive.json("GET /archive-checks.json", ECOLOGY)

    with pytest.raises(Refused, match="1 error finding"):
        submit.submit(first, str(no_methods))

    assert first.checks == ECOLOGY
    assert (config_home / "research-archive-in-a-box" / "archive.json").read_bytes() == before
    assert other.seen[-1].path == "/archive-checks.json"  # nothing after its own connect
