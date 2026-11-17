"""The stage recipes call `aws` in the stage's region from archive.yaml, run with `aws` stubbed
by a shell script that logs each call."""

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
      region: eu-west-1
    - name: plain
"""

AWS = """\
#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
case "$*" in
  *"cloudformation describe-stacks"*) echo "arn:aws:lambda:eu-west-1:1:function:Fn:live" ;;
  *"list-durable-executions-by-function"*) echo "arn:aws:lambda:eu-west-1:1:execution" ;;
  *"get-durable-execution"*) echo '{"status": "SUCCEEDED"}' ;;
  *"sns subscribe"*) echo "arn:aws:sns:eu-west-1:1:Curators:sub" ;;
esac
"""

RECIPES = [
    ["reindex"],
    ["reindex-status"],
    ["add-curator", "curator@example.org", "user-1"],
]


def _run(tmp_path: Path, recipe: list[str], stage: str) -> list[str]:
    just = shutil.which("just")
    if just is None:
        pytest.skip("just is not installed")
    stubs = tmp_path / "bin"
    stubs.mkdir(exist_ok=True)
    (stubs / "aws").write_text(AWS, encoding="utf-8")
    (stubs / "aws").chmod(0o755)
    (tmp_path / "archive.yaml").write_text(CONFIG, encoding="utf-8")
    log = tmp_path / "calls.log"
    log.unlink(missing_ok=True)
    env = {
        **os.environ,
        "PATH": f"{stubs}{os.pathsep}{os.environ['PATH']}",
        "ARCHIVE_CONFIG": str(tmp_path / "archive.yaml"),
        "STUB_LOG": str(log),
    }
    args = [recipe[0], stage, *recipe[1:]]
    result = subprocess.run(
        [just, *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, result.stdout + result.stderr
    calls = log.read_text(encoding="utf-8").splitlines()
    assert calls
    return calls


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda recipe: recipe[0])
def test_recipe_calls_aws_in_the_stage_region(tmp_path: Path, recipe: list[str]) -> None:
    calls = _run(tmp_path, recipe, "test")

    assert all(call.startswith("aws --region eu-west-1 ") for call in calls), calls


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda recipe: recipe[0])
def test_recipe_leaves_the_region_to_aws_when_the_stage_names_none(
    tmp_path: Path, recipe: list[str]
) -> None:
    calls = _run(tmp_path, recipe, "plain")

    assert not any("--region" in call for call in calls), calls
