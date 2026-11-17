import tomllib
from pathlib import Path

from packaging.requirements import Requirement

PYPROJECT = Path(__file__).parents[1] / "pyproject.toml"


def test_mcp_is_bounded_to_the_2x_line_with_mcpserver() -> None:
    # uvx installs resolve without uv.lock, so the bound is all that picks the SDK.
    dependencies = tomllib.loads(PYPROJECT.read_text())["project"]["dependencies"]
    mcp = next(Requirement(d) for d in dependencies if Requirement(d).name == "mcp")

    assert "2.3.0" in mcp.specifier
    assert "2.2.0" not in mcp.specifier
    assert "1.20.0" not in mcp.specifier
    assert "3.0.0" not in mcp.specifier


def test_the_plugin_its_server_and_its_marketplace_entry_are_all_named_cruise() -> None:
    import json

    from archive_agent import server
    from archive_agent.state import Session

    agent = Path(__file__).parents[1]
    plugin = json.loads((agent / ".claude-plugin" / "plugin.json").read_text())
    servers = json.loads((agent / ".mcp.json").read_text())["mcpServers"]
    marketplace = json.loads((agent.parents[1] / ".claude-plugin" / "marketplace.json").read_text())

    assert plugin["name"] == server.NAME == "cruise"
    assert list(servers) == [server.NAME]
    assert [p["name"] for p in marketplace["plugins"]] == [server.NAME]
    assert server.build(Session()).name == server.NAME
