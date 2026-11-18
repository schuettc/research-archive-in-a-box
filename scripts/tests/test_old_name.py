"""The kit's former name appears nowhere in the repo."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Split so this file doesn't name it itself.
OLD = "research-" + "in-a-box"


def test_no_file_names_the_old_name() -> None:
    found = subprocess.run(
        ["git", "grep", "-il", OLD], cwd=ROOT, capture_output=True, text=True
    ).stdout.split()
    assert found == []
