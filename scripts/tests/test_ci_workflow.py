"""CI's deploy job holds AWS credentials only for the steps that need them."""

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github/workflows/ci.yml"
CREDENTIALS = "aws-actions/configure-aws-credentials@"


def _deploy_steps() -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]["deploy"][
        "steps"
    ]
    return steps


def test_the_deploy_job_loads_its_role_in_the_step_before_cdk_deploy() -> None:
    steps = _deploy_steps()
    loads = [i for i, step in enumerate(steps) if str(step.get("uses", "")).startswith(CREDENTIALS)]
    deploys = [i for i, step in enumerate(steps) if "cdk deploy" in str(step.get("run", ""))]
    assert len(loads) == 1 and len(deploys) == 1
    assert deploys[0] == loads[0] + 1


def test_no_step_before_cdk_deploy_is_given_aws_credentials() -> None:
    steps = _deploy_steps()
    load = next(
        i for i, step in enumerate(steps) if str(step.get("uses", "")).startswith(CREDENTIALS)
    )
    job = yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]["deploy"]
    named = {**job.get("env", {})}
    for step in steps[:load]:
        named.update(step.get("env", {}))
        assert not str(step.get("uses", "")).startswith("aws-actions/")
    assert not [
        name for name in named if name.startswith(("AWS_ACCESS", "AWS_SECRET", "AWS_SESSION"))
    ]


def test_the_deploy_job_installs_without_running_install_scripts() -> None:
    runs = [str(step.get("run", "")) for step in _deploy_steps()]
    assert "npm ci --ignore-scripts" in runs
    assert "npm ci" not in runs
