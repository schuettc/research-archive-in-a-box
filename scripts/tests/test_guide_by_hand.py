"""The Deploying guide's "Doing it by hand" section prints the same commands as steps 3 to 8 of
the deploy-archive skill, so a command changed in one and not the other fails here."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / ".claude/skills/deploy-archive/SKILL.md"
PAGE = ROOT / "docs/guide/deploying.md"


def _between(text: str, start: str, end: str) -> str:
    """The text from the line `start` up to the line `end`."""
    return text.split(f"\n{start}\n", 1)[1].split(f"\n{end}\n", 1)[0]


def commands(section: str) -> set[str]:
    """Every command line in the section's fenced blocks that name no language."""
    found: set[str] = set()
    fence: str | None = None
    for line in section.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            fence = None if fence is not None else stripped
        elif fence == "```" and stripped:
            found.add(stripped)
    return found


def skill_commands() -> set[str]:
    text = SKILL.read_text(encoding="utf-8")
    return commands(_between(text, "### 3. ✋ Connect GitHub to AWS", "## Update"))


def page_commands() -> set[str]:
    text = PAGE.read_text(encoding="utf-8")
    return commands(_between(text, "## Doing it by hand", "## Updating from upstream"))


def test_the_sections_have_commands() -> None:
    assert len(skill_commands()) >= 10
    assert len(page_commands()) >= 10


def test_every_skill_command_is_in_the_guide() -> None:
    missing = sorted(skill_commands() - page_commands())
    assert not missing, f"docs/guide/deploying.md, Doing it by hand, lacks {missing}"


def test_every_guide_command_is_in_the_skill() -> None:
    extra = sorted(page_commands() - skill_commands())
    assert not extra, f"the deploy-archive skill's steps 3 to 8 lack {extra}"
