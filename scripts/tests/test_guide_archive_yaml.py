"""The guide's archive.yaml reference has one entry for each field of the contract's JSON Schema,
and none for a field the schema doesn't have, so the page can't drift from the contract."""

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "packages/web/src/schema/archive-contract.schema.json"
PAGE = ROOT / "docs/guide/archive-yaml.md"

# An entry is a level-three heading naming the field's path in backticks: ### `brand.privacy`
ENTRY = re.compile(r"^### `([^`]+)`\s*$", re.MULTILINE)


def _refs(node: Any) -> list[str]:
    """The $defs a property's schema points at, directly or through anyOf or items."""
    if isinstance(node, dict):
        found = [node["$ref"].rsplit("/", 1)[-1]] if "$ref" in node else []
        for key in ("anyOf", "items"):
            value = node.get(key)
            for part in value if isinstance(value, list) else [value]:
                found.extend(_refs(part))
        return found
    return []


def _is_list(node: dict[str, Any]) -> bool:
    return node.get("type") == "array" or any(
        part.get("type") == "array" for part in node.get("anyOf", [])
    )


def schema_paths() -> set[str]:
    """Every field archive.yaml can hold, as dotted paths with [] after a list."""
    defs: dict[str, Any] = json.loads(SCHEMA.read_text(encoding="utf-8"))["$defs"]
    paths: set[str] = set()

    def walk(definition: str, prefix: str) -> None:
        for name, node in defs[definition]["properties"].items():
            path = f"{prefix}{name}"
            paths.add(path)
            for ref in _refs(node):
                walk(ref, f"{path}[]." if _is_list(node) else f"{path}.")

    walk("ArchiveConfig", "")
    return paths


def page_entries() -> dict[str, str]:
    """Each entry's path and the text under its heading, up to the next heading."""
    text = PAGE.read_text(encoding="utf-8")
    matches = list(ENTRY.finditer(text))
    entries: dict[str, str] = {}
    for match, following in zip(matches, [*matches[1:], None], strict=True):
        end = following.start() if following else len(text)
        body = text[match.end() : end]
        entries[match.group(1)] = re.split(r"^#{1,3} ", body, maxsplit=1, flags=re.MULTILINE)[0]
    return entries


def test_every_schema_field_has_an_entry() -> None:
    missing = sorted(schema_paths() - set(page_entries()))
    assert not missing, f"docs/guide/archive-yaml.md has no entry for {missing}"


def test_every_entry_is_a_schema_field() -> None:
    extra = sorted(set(page_entries()) - schema_paths())
    assert not extra, f"docs/guide/archive-yaml.md has entries the schema doesn't: {extra}"


def test_every_entry_gives_its_type_default_and_an_example() -> None:
    short = [
        path
        for path, body in page_entries().items()
        if "**Type:**" not in body or "**Default:**" not in body or "```yaml" not in body
    ]
    assert not short, f"entries without a type, a default or a yaml example: {short}"
