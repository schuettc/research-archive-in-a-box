import hashlib
import importlib.util
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any, cast

import pytest
import yaml

from archive_contract import ReviewPolicy, SubmissionFacts, match
from archive_contract.config import ArchiveConfig
from cruise.diagnose import diagnose


def _load() -> ModuleType:
    path = Path(__file__).with_name("ingest_e2e.py")
    spec = importlib.util.spec_from_file_location("ingest_e2e", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["ingest_e2e"] = module
    spec.loader.exec_module(module)
    return module


e2e = _load()
TEST_CONFIG = e2e.ROOT / "examples" / "ingest-test-stage" / "archive.yaml"


def _errors(folder: Path) -> list[str]:
    config = ArchiveConfig.model_validate(yaml.safe_load(TEST_CONFIG.read_text()))
    result = diagnose(folder, config.load_profiles(), config.required)
    return [f.rule_id for f in result.findings if f.severity == "error"]


def test_a_package_copy_leaves_out_the_build_folder_and_lists_every_other_file(
    tmp_path: Path,
) -> None:
    folder = e2e.package_copy(tmp_path, e2e.themed("e2e-two"))

    manifest = json.loads((folder / "datapackage.json").read_text())
    assert manifest["archive:themes"] == ["e2e-two"]
    assert not (folder / "_build").exists()
    listed = {}
    for line in (folder / "checksums.sha256").read_text().splitlines():
        digest, path = line.split("  ", 1)
        listed[path] = digest
    files = {p.relative_to(folder).as_posix(): p for p in folder.rglob("*") if p.is_file()}
    assert set(listed) == set(files) - {"checksums.sha256"}
    for path, digest in listed.items():
        assert hashlib.sha256(files[path].read_bytes()).hexdigest() == digest


def test_the_sample_passes_the_checks_and_a_copy_without_its_description_is_blocked(
    tmp_path: Path,
) -> None:
    assert _errors(e2e.package_copy(tmp_path / "a", e2e.themed("e2e-skip"))) == []
    assert "package.core-missing" in _errors(
        e2e.package_copy(tmp_path / "b", e2e.without("description"))
    )


def test_the_file_list_has_each_path_size_and_sha256(tmp_path: Path) -> None:
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "a.csv").write_bytes(b"x,y\n")
    (tmp_path / "README.md").write_bytes(b"")

    assert e2e.file_list(tmp_path) == [
        {"path": "README.md", "size": 0, "sha256": hashlib.sha256(b"").hexdigest()},
        {"path": "data/a.csv", "size": 4, "sha256": hashlib.sha256(b"x,y\n").hexdigest()},
    ]


def test_the_file_list_and_the_checksums_leave_out_hidden_files(tmp_path: Path) -> None:
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "a.csv").write_bytes(b"x,y\n")
    (tmp_path / ".DS_Store").write_bytes(b"x")
    (tmp_path / "data" / ".DS_Store").write_bytes(b"x")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_bytes(b"x")

    digest = hashlib.sha256(b"x,y\n").hexdigest()
    assert e2e.file_list(tmp_path) == [{"path": "data/a.csv", "size": 4, "sha256": digest}]
    assert e2e.checksum_text(tmp_path) == f"{digest}  data/a.csv\n"


@pytest.mark.parametrize(
    ("themes", "outcome", "rule"),
    [(["e2e-skip"], "skip", 0), (["e2e-two"], "two", 1), (["e2e-remind"], "one", None)],
)
def test_the_policy_matches_each_run_by_theme(
    themes: list[str], outcome: str, rule: int | None
) -> None:
    policy = ReviewPolicy.model_validate(e2e.e2e_policy("reviewer-1"))
    facts = SubmissionFacts("u", False, "new-dataset", "public", tuple(themes))

    assert match(policy, facts) == (outcome, rule)
    assert policy.reminders == [1]
    assert policy.reviewers == {"e2e-remind": ["reviewer-1"]}
    assert ReviewPolicy.model_validate(e2e.e2e_policy(None)).reviewers == {}


def test_event_types_are_compared_as_a_multiset() -> None:
    events = [{"type": "submitted"}, {"type": "created"}, {"type": "decided"}]

    assert e2e.event_mismatch(["created", "submitted", "decided"], events) is None
    assert (
        e2e.event_mismatch(["created", "submitted", "decided", "decided"], events)
        == "missing decided"
    )
    assert e2e.event_mismatch(["created", "submitted"], events) == "extra decided"


def test_the_state_file_round_trips_under_the_state_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))
    path = e2e.state_path("ingest-test")

    assert path == tmp_path / "research-archive" / "ingest-e2e-ingest-test.json"
    assert e2e.load_state(path) is None
    e2e.save_state(path, {"submissionId": "s1", "enteredAt": "2026-11-13T00:00:00Z"})
    assert e2e.load_state(path) == {"submissionId": "s1", "enteredAt": "2026-11-13T00:00:00Z"}
    e2e.save_state(path, None)
    assert not path.exists()


def test_a_day_one_reminder_is_due_a_day_and_an_hour_after_entering_review() -> None:
    entered = "2026-11-13T10:00:00.000000Z"

    assert not e2e.reminder_due(entered, datetime(2026, 11, 14, 10, 59, tzinfo=UTC))
    assert e2e.reminder_due(entered, datetime(2026, 11, 14, 11, 0, tzinfo=UTC))


def test_a_waiting_status_holds_only_once_the_pipeline_waits() -> None:
    assert e2e.holds({"status": "in-review", "waiting": False}, "in-review") is False
    assert e2e.holds({"status": "in-review", "waiting": True}, "in-review") is True
    assert e2e.holds({"status": "needs-changes", "waiting": True}, "needs-changes") is True
    assert e2e.holds({"status": "published", "waiting": False}, "published") is True
    assert e2e.holds({"status": "checking", "waiting": True}, "in-review") is False


def test_the_run_stops_on_a_stage_without_the_e2e_outputs(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("boto3.client", lambda *args, **kwargs: object())
    monkeypatch.setattr(e2e, "stack_outputs", lambda cloudformation, stage: {"SiteDomain": "d"})

    assert e2e.main(["prod"]) == 2
    assert capsys.readouterr().out.strip() == (
        "ResearchArchive-prod has no E2eClientId, UserPoolId output; "
        "ingest-e2e needs a stage with keepData: false in its config"
    )


def test_a_large_copy_totals_just_under_its_size_and_passes_the_checks(tmp_path: Path) -> None:
    size = 8 * 1024**2

    folder = e2e.large_copy(tmp_path, size)

    files = e2e.file_list(folder)
    total = sum(f["size"] for f in files)
    assert size - e2e.LARGE_SLACK <= total <= size
    large = [f for f in files if f["path"] in e2e.LARGE_PATHS]
    assert len(large) == 2 and all(f["size"] > size // 3 for f in large)
    assert _errors(folder) == []


def test_files_over_the_limit_total_one_byte_more_and_each_fits_one_upload() -> None:
    limit = 9 * 1024**3

    files = e2e.over_limit_files(limit)

    assert sum(f["size"] for f in files) == limit + 1
    assert all(f["size"] <= 5 * 1024**3 for f in files)
    assert {"datapackage.json", "checksums.sha256"} <= {f["path"] for f in files}


@pytest.mark.parametrize(
    ("seen", "fault"),
    [
        ([(200, 1), (200, 1), (200, 2), (200, 2)], None),
        ([(200, 1), (404, None), (200, 2)], "answered 404"),
        ([(200, 1), (200, 2), (200, 1)], "went back from version 2 to 1"),
        ([(200, 1), (200, 1)], "never showed version 2"),
        ([(200, 2), (200, 2)], "never showed version 1"),
        ([], "never showed version 1"),
    ],
)
def test_a_dataset_read_through_a_publish_stays_up_and_only_moves_forward(
    seen: list[tuple[int, int | None]], fault: str | None
) -> None:
    found = e2e.version_fault(seen)

    assert (found is None) if fault is None else (found is not None and fault in found)


def test_an_upload_streams_each_file_with_its_length_and_headers(tmp_path: Path) -> None:
    import http.server
    import threading

    got: dict[str, object] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_PUT(self) -> None:
            got["length"] = self.headers["Content-Length"]
            got["chunked"] = self.headers.get("Transfer-Encoding")
            got["checksum"] = self.headers["x-amz-checksum-sha256"]
            got["body"] = self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    body = b"x" * (3 * 1024**2 + 7)
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "big.bin").write_bytes(body)
    try:
        e2e.upload(
            [
                {
                    "path": "data/big.bin",
                    "url": f"http://127.0.0.1:{server.server_port}/put",
                    "headers": {"x-amz-checksum-sha256": "abc"},
                }
            ],
            tmp_path,
        )
    finally:
        server.shutdown()

    assert got == {"length": str(len(body)), "chunked": None, "checksum": "abc", "body": body}


class _RebuiltStage:
    """A stage that knows no earlier submission, as one destroyed and deployed again does."""

    curator = None

    def __init__(self) -> None:
        self.api = self

    def known(self, user: object, sid: str) -> bool:
        return False

    def folder(self, change: object = None) -> Path:
        return Path()

    def submit(self, folder: Path) -> str:
        return "new"

    def wait(self, sid: str, status: str) -> dict[str, str]:
        return {}

    def events(self, sid: str, types: list[str]) -> list[dict[str, str]]:
        return [{"type": "entered-review", "at": "2026-11-20T00:00:00Z", "audience": "all"}]


def test_a_saved_submission_the_stage_does_not_know_starts_the_reminder_run_again(
    tmp_path: Path,
) -> None:
    path = tmp_path / "state.json"
    waiting = {"submissionId": "gone", "enteredAt": "2026-11-13T00:00:00Z"}

    result = e2e.run_reminder(cast(Any, _RebuiltStage()), path, waiting)

    assert result.startswith("new left waiting")
    assert e2e.load_state(path) == {"submissionId": "new", "enteredAt": "2026-11-20T00:00:00Z"}
