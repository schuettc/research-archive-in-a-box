import json
import shutil
from pathlib import Path

import pytest

from cruise import edit

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"
WRITTEN = ("datapackage.json", "README.md", "checksums.sha256")


def test_a_readme_that_fails_to_render_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "sample"
    shutil.copytree(SAMPLE, root)
    before = {name: (root / name).read_bytes() for name in WRITTEN}

    def broken(*args: object) -> str:
        raise RuntimeError("render failed")

    monkeypatch.setattr(edit, "render_readme", broken)

    with pytest.raises(RuntimeError, match="render failed"):
        edit.edit_package(root, [{"target": "title", "value": "Changed"}])

    assert {name: (root / name).read_bytes() for name in WRITTEN} == before


def test_a_contributors_orcid_address_is_written_bare(tmp_path: Path) -> None:
    root = tmp_path / "sample"
    shutil.copytree(SAMPLE, root)
    people = [
        {
            "title": "Ada Invented",
            "orcid": "https://orcid.org/0000-0002-1825-0097",
            "roles": ["creator"],
        }
    ]

    edit.edit_package(root, [{"target": "contributors", "value": people}])

    written = json.loads((root / "datapackage.json").read_text(encoding="utf-8"))
    assert written["contributors"][0]["orcid"] == "0000-0002-1825-0097"
