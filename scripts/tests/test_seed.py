import json
import shutil
from pathlib import Path
from typing import Any

import pytest

import seed
from archive_client.signin import AuthConfig, Tokens

DOMAIN = "d111.cloudfront.net"
BASE = f"https://{DOMAIN}/api/submissions"
SID = "11111111-2222-3333-4444-555555555555"
DATASET = "stream-temperature-sample"
ID_TOKEN = "id-token"
REPORT = "https://staging.example/report.json?signed"


def _package(tmp_path: Path, name: str = "package") -> Path:
    folder = tmp_path / name
    (folder / "data").mkdir(parents=True)
    (folder / "_build").mkdir()
    (folder / "datapackage.json").write_text('{"id": "x"}\n', encoding="utf-8")
    (folder / "data" / "logger.csv").write_text("t,v\n1,2\n", encoding="utf-8")
    (folder / "_build" / "make.py").write_text("print('not part of it')\n", encoding="utf-8")
    return folder


class FakeArchive:
    """The submissions API and S3's presigned PUTs, answering from a list of statuses that
    `GET /api/submissions/{id}` walks through one read at a time (the last one repeats). The
    first submission created is SID; `later` holds the statuses of each one created after it,
    which otherwise walks the same list."""

    def __init__(
        self,
        statuses: list[dict[str, Any]],
        events: list[dict[str, Any]],
        later: list[list[dict[str, Any]]] | None = None,
    ) -> None:
        self.statuses = statuses
        self.events = events
        self.later = later or []
        self.sids: list[str] = []
        self.reads: dict[str, int] = {}
        self.unreachable_report = False
        self.calls: list[tuple[str, str, dict[str, str], Any]] = []

    def __call__(
        self, method: str, url: str, headers: dict[str, str], data: bytes | None
    ) -> tuple[int, bytes]:
        body: Any = json.loads(data) if data and url.startswith(BASE) else data
        self.calls.append((method, url, headers, body))
        if url.startswith("https://uploads.example/"):
            return 200, b""
        if url == REPORT:
            if self.unreachable_report:
                raise TimeoutError("timed out")
            report = {
                "findings": [
                    {"ruleId": "core.description", "severity": "error", "message": "no description"}
                ]
            }
            return 200, json.dumps(report).encode()
        assert headers.get("Authorization") == ID_TOKEN
        if (method, url) == ("POST", BASE):
            uploads = [
                {
                    "path": f["path"],
                    "url": f"https://uploads.example/{f['path']}",
                    "headers": {"x-amz-checksum-sha256": f"b64-{f['sha256'][:8]}"},
                }
                for f in body["files"]
            ]
            sid = SID if not self.sids else f"{SID[:-1]}{len(self.sids) + 5}"
            self.sids.append(sid)
            return 201, json.dumps({"submissionId": sid, "round": 1, "uploads": uploads}).encode()
        for number, sid in enumerate(self.sids):
            if (method, url) == ("POST", f"{BASE}/{sid}/submit"):
                return 202, json.dumps({"submissionId": sid, "status": "checking"}).encode()
            if (method, url) == ("POST", f"{BASE}/{sid}/decision"):
                return 202, json.dumps({"submissionId": sid, "decision": body["decision"]}).encode()
            if (method, url) == ("GET", f"{BASE}/{sid}"):
                statuses = self.statuses
                if number and number <= len(self.later):
                    statuses = self.later[number - 1]
                reads = self.reads.get(sid, 0)
                current = statuses[min(reads, len(statuses) - 1)]
                self.reads[sid] = reads + 1
                answer: dict[str, Any] = {
                    "submission": {"submissionId": sid, **current},
                    "events": self.events,
                }
                if current.get("reportKey"):
                    answer["reportUrl"] = REPORT
                return 200, json.dumps(answer).encode()
        return 404, b'{"message": "not found"}'

    def decisions(self) -> list[Any]:
        return [c[3] for c in self.calls if c[1].endswith("/decision")]


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def _run(archive: FakeArchive, *packages: Path, clock: Clock | None = None) -> int:
    """Run the seed on the packages given, or on its default with none, and check that it
    signed in once."""
    clock = clock or Clock()
    signed: list[AuthConfig] = []

    def sign_in(config: AuthConfig) -> Tokens:
        signed.append(config)
        return Tokens(
            access_token="access-token", id_token=ID_TOKEN, expires_at=3600.0, site=config.site
        )

    code = seed.main(
        [DOMAIN, *(arg for package in packages for arg in ("--package", str(package)))],
        sign_in=sign_in,
        send=archive,
        sleep=clock.sleep,
        clock=clock.time,
        poll_seconds=5,
        timeout_seconds=60,
    )
    assert signed == [AuthConfig(site=f"https://{DOMAIN}")]
    return code


def test_a_policy_that_skips_review_publishes_with_no_decision(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    package = _package(tmp_path)
    archive = FakeArchive(
        [
            {"status": "checking"},
            {"status": "checking"},
            {"status": "publishing"},
            {"status": "published", "datasetId": DATASET},
        ],
        [],
    )

    code = _run(archive, package)

    assert code == 0
    assert archive.decisions() == []
    out = capsys.readouterr().out.splitlines()
    assert out[-1] == f"https://{DOMAIN}/datasets/{DATASET}"
    # Each new status once, in order.
    assert [line for line in out if line.startswith("status:")] == [
        "status: checking",
        "status: publishing",
        "status: published",
    ]
    created = archive.calls[0]
    assert created[:2] == ("POST", BASE)
    assert [f["path"] for f in created[3]["files"]] == ["data/logger.csv", "datapackage.json"]
    puts = [c for c in archive.calls if c[0] == "PUT"]
    assert [c[1] for c in puts] == [
        "https://uploads.example/data/logger.csv",
        "https://uploads.example/datapackage.json",
    ]
    assert all(c[2]["x-amz-checksum-sha256"].startswith("b64-") for c in puts)
    assert puts[0][3] == b"t,v\n1,2\n"


def test_in_review_is_approved_once_its_wait_is_open_then_published(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    archive = FakeArchive(
        [
            {"status": "checking"},
            {"status": "in-review", "waiting": False},
            {"status": "in-review", "waiting": True},
            {"status": "in-review", "waiting": True},
            {"status": "publishing"},
            {"status": "published", "datasetId": DATASET},
        ],
        [],
    )

    code = _run(archive, _package(tmp_path))

    assert code == 0
    assert archive.decisions() == [{"decision": "approve", "note": "seed"}]
    assert capsys.readouterr().out.splitlines()[-1] == f"https://{DOMAIN}/datasets/{DATASET}"


def test_needs_changes_stops_with_the_status_and_its_findings(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    archive = FakeArchive(
        [{"status": "checking"}, {"status": "needs-changes", "reportKey": "reports/x.json"}],
        [{"type": "created"}, {"type": "submitted"}, {"type": "checked", "errors": 1}],
    )

    code = _run(archive, _package(tmp_path))

    assert code == 1
    assert archive.decisions() == []
    out = capsys.readouterr().out
    assert "stopped: needs-changes" in out
    assert "error core.description: no description" in out
    assert "events: created, submitted, checked" in out


def test_it_gives_up_when_the_time_runs_out(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    archive = FakeArchive([{"status": "checking"}], [{"type": "submitted"}])
    clock = Clock()

    code = _run(archive, _package(tmp_path), clock=clock)

    assert code == 1
    assert clock.now >= 60
    out = capsys.readouterr().out
    assert "still checking after 60 seconds" in out
    assert "events: submitted" in out


def test_two_packages_are_published_on_one_sign_in(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    first, second = _package(tmp_path, "first"), _package(tmp_path, "second")
    archive = FakeArchive(
        [{"status": "checking"}, {"status": "published", "datasetId": "first"}],
        [],
        later=[[{"status": "checking"}, {"status": "published", "datasetId": "second"}]],
    )

    # _run checks there was one sign-in.
    code = _run(archive, first, second)

    assert code == 0
    assert len(archive.sids) == 2
    out = capsys.readouterr().out.splitlines()
    assert [line for line in out if line.startswith("https://")] == [
        f"https://{DOMAIN}/datasets/first",
        f"https://{DOMAIN}/datasets/second",
    ]


def test_a_package_that_stops_fails_the_run_after_the_rest_are_tried(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    archive = FakeArchive(
        [{"status": "needs-changes", "reportKey": "reports/x.json"}],
        [{"type": "checked"}],
        later=[[{"status": "published", "datasetId": "second"}]],
    )

    code = _run(archive, _package(tmp_path, "first"), _package(tmp_path, "second"))

    assert code == 1
    out = capsys.readouterr().out
    assert "stopped: needs-changes" in out
    assert "error core.description: no description" in out
    assert out.splitlines()[-1] == f"https://{DOMAIN}/datasets/second"


def test_with_no_package_named_it_publishes_every_sample_package_in_name_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _package(tmp_path, "b-package")
    _package(tmp_path, "a-package")
    (tmp_path / "not-a-package").mkdir()
    (tmp_path / "archive.yaml").write_text("publisher: x\n", encoding="utf-8")
    monkeypatch.setattr(seed, "EXAMPLES", tmp_path)
    archive = FakeArchive([{"status": "published", "datasetId": DATASET}], [])

    code = _run(archive)

    assert code == 0
    out = capsys.readouterr().out.splitlines()
    assert [line for line in out if line.endswith("-package:")] == ["a-package:", "b-package:"]
    assert len(archive.sids) == 2


def test_the_sample_packages_are_the_six_example_folders_with_a_manifest() -> None:
    assert [folder.name for folder in seed.sample_packages()] == [
        "bird-point-counts",
        "sample-package",
        "soil-moisture",
        "stream-invertebrates",
        "tree-rings",
        "weather-station",
    ]


def test_the_sample_package_list_leaves_out_its_build_folder() -> None:
    files = seed.file_list(seed.SAMPLE)
    paths = [f["path"] for f in files]
    assert "datapackage.json" in paths and "checksums.sha256" in paths
    assert not [p for p in paths if p.startswith("_build/")]
    listed = (seed.SAMPLE / "checksums.sha256").read_text(encoding="utf-8").split()
    sums = dict(zip(listed[1::2], listed[0::2], strict=True))
    assert {f["path"]: f["sha256"] for f in files if f["path"] != "checksums.sha256"} == sums


def test_the_file_list_leaves_out_hidden_files_and_folders(tmp_path: Path) -> None:
    folder = tmp_path / "package"
    shutil.copytree(seed.SAMPLE, folder)
    (folder / ".DS_Store").write_bytes(b"x")
    (folder / "data" / ".DS_Store").write_bytes(b"x")
    (folder / ".git").mkdir()
    (folder / ".git" / "config").write_bytes(b"x")

    assert seed.file_list(folder) == seed.file_list(seed.SAMPLE)


def test_a_report_that_cannot_be_reached_still_shows_the_status_and_events(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    archive = FakeArchive(
        [{"status": "needs-changes", "reportKey": "reports/x.json"}],
        [{"type": "created"}, {"type": "checked"}],
    )

    archive.unreachable_report = True
    code = _run(archive, _package(tmp_path))

    assert code == 1
    out = capsys.readouterr().out
    assert "stopped: needs-changes" in out
    assert "the report could not be read" in out
    assert "events: created, checked" in out
