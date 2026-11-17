"""`just destroy`, run with `aws`, `npx` and `npm` stubbed by shell scripts that log each call,
and `uv` stubbed for the Lambda bundle's export and install (its other commands run for real)."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

CONFIG = """\
publisher: Invented Research Cooperative
infrastructure:
  alertEmail: archive-admin@example.org
  stages:
    - name: test
    - name: test-b
"""

GROUPS = [
    "/aws/lambda/ResearchArchive-test-CustomS3AutoDeleteObjectsCusto-abc",
    "/aws/lambda/ResearchArchive-test-AWS679f53fac002430cb0da5b7982b-def",
    "/aws/lambda/ResearchArchive-test-b-AWS679f53fac002430cb0da5b798-ghi",
    "/aws/lambda/ResearchArchive-prod-Ingest",
]

AWS = """\
#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
case "$*" in
  *"lambda list-durable-executions-by-function"*) ;;
  *"cloudformation list-stack-resources"*"AWS::S3::Bucket"*) echo researcharchive-test-derived ;;
  *"logs describe-log-groups"*)
    args="$*"; prefix="${args##*--log-group-name-prefix }"; prefix="${prefix%% *}"
    found=()
    for group in $STUB_LOG_GROUPS; do [[ "$group" == "$prefix"* ]] && found+=("$group"); done
    (IFS=$'\\t'; echo "${found[*]}") ;;
  *"cloudformation describe-stacks"*)
    echo "An error occurred (ValidationError): Stack with id x does not exist" >&2; exit 254 ;;
esac
"""

NPX = """\
#!/usr/bin/env bash
echo "npx $*" >> "$STUB_LOG"
if [ -n "${STUB_CDK_FAILURE:-}" ] && [ ! -e "$STUB_LOG.failed" ]; then
  touch "$STUB_LOG.failed"
  echo "$STUB_CDK_FAILURE"
  exit 1
fi
"""

NPM = """\
#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
"""

UV = """\
#!/usr/bin/env bash
case "$1" in
  export|pip) echo "uv $1" >> "$STUB_LOG" ;;
  *) exec "$REAL_UV" "$@" ;;
esac
"""

NOT_EMPTY = (
    "ResearchArchive-test | DELETE_FAILED | AWS::S3::Bucket | StorageDerived: The bucket you "
    "tried to delete is not empty (Service: S3, Status Code: 409, Error Code: BucketNotEmpty)"
)


def _destroy(
    tmp_path: Path, cdk_failure: str = ""
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    just, uv = shutil.which("just"), shutil.which("uv")
    if just is None or uv is None:
        pytest.skip("just or uv is not installed")
    stubs = tmp_path / "bin"
    stubs.mkdir()
    for name, body in {"aws": AWS, "npx": NPX, "npm": NPM, "uv": UV}.items():
        (stubs / name).write_text(body, encoding="utf-8")
        (stubs / name).chmod(0o755)
    (tmp_path / "archive.yaml").write_text(CONFIG, encoding="utf-8")
    log = tmp_path / "calls.log"
    env = {
        **os.environ,
        "PATH": f"{stubs}{os.pathsep}{os.environ['PATH']}",
        "ARCHIVE_CONFIG": str(tmp_path / "archive.yaml"),
        "STUB_LOG": str(log),
        "STUB_LOG_GROUPS": " ".join(GROUPS),
        "STUB_CDK_FAILURE": cdk_failure,
        "REAL_UV": uv,
    }
    result = subprocess.run(
        [just, "destroy", "test"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=300
    )
    calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    return result, calls


def test_destroy_deletes_every_log_group_of_the_stage_and_no_other(tmp_path: Path) -> None:
    result, calls = _destroy(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert (
        "aws logs describe-log-groups --log-group-name-prefix /aws/lambda/ResearchArchive-test- "
        in "\n".join(calls) + " "
    )
    deleted = [call.rsplit(" ", 1)[1] for call in calls if "logs delete-log-group" in call]
    assert deleted == GROUPS[:2]
    for group in GROUPS[:2]:
        assert group in result.stdout


def test_destroy_builds_what_cdk_synthesizes_before_destroying(tmp_path: Path) -> None:
    result, calls = _destroy(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    first_cdk = next(i for i, call in enumerate(calls) if call.startswith("npx cdk destroy"))
    before = calls[:first_cdk]
    assert "uv export" in before
    assert "uv pip" in before
    assert "npm run build -w packages/web" in before


def test_destroy_empties_the_derived_logs_and_tries_again_when_the_bucket_is_not_empty(
    tmp_path: Path,
) -> None:
    result, calls = _destroy(tmp_path, cdk_failure=NOT_EMPTY)

    assert result.returncode == 0, result.stdout + result.stderr
    destroys = [call for call in calls if call.startswith("npx cdk destroy")]
    assert len(destroys) == 2
    empty = calls.index("aws s3 rm s3://researcharchive-test-derived/logs/ --recursive")
    assert calls.index(destroys[0]) < empty < len(calls) - 1 - calls[::-1].index(destroys[1])


def test_destroy_stops_when_cdk_fails_for_another_reason(tmp_path: Path) -> None:
    result, calls = _destroy(
        tmp_path, cdk_failure="ResearchArchive-test | DELETE_FAILED | role in use"
    )

    assert result.returncode != 0
    assert len([call for call in calls if call.startswith("npx cdk destroy")]) == 1
    assert not any("s3 rm" in call or "delete-log-group" in call for call in calls)
