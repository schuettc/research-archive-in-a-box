"""The docs a reader sees name no internal planning id (PARK1, DCSN2, PLAN3, TASK4)."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

ID = re.compile(r"\b(?:PARK|DCSN|PLAN|TASK)[0-9]+\b")


def _reader_docs() -> list[Path]:
    """Every doc a user or deployer reads: the docs, the guide, the deploy skill, the plugin's
    skills, and each README."""
    found = [
        *(ROOT / "docs").glob("*.md"),
        *(ROOT / "docs" / "guide").rglob("*.md"),
        *(path for path in (ROOT / ".claude").rglob("*") if path.is_file()),
        *(path for path in (ROOT / "packages").glob("*/skills/**/*") if path.is_file()),
        ROOT / "README.md",
        *(ROOT / "packages").glob("*/README.md"),
        *(ROOT / "examples").glob("*/README.md"),
    ]
    return sorted(set(found))


def test_the_reader_docs_name_no_planning_id() -> None:
    hits = [
        f"{path.relative_to(ROOT)}:{number}: {line.strip()}"
        for path in _reader_docs()
        for number, line in enumerate(path.read_text().splitlines(), start=1)
        if ID.search(line)
    ]
    assert hits == []


def test_the_check_reads_the_docs_it_names() -> None:
    names = {str(path.relative_to(ROOT)) for path in _reader_docs()}
    assert {"docs/domain.md", "docs/email.md", "README.md"} <= names
    assert ".claude/skills/deploy-archive/SKILL.md" in names
    assert "packages/agent/skills/find-data/SKILL.md" in names
