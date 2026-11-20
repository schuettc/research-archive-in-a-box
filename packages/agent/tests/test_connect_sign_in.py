import asyncio
import base64
import json
import socket
import time
from pathlib import Path
from typing import Any

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from archive_agent import server, state, submit
from archive_agent.errors import NotConnected, Refused, SignInFailed, Unreachable
from archive_agent.state import Session
from archive_client.signin import AuthConfig, SignInError, Tokens


def jwt(claims: dict[str, Any]) -> str:
    def part(value: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    return f"{part({'alg': 'none'})}.{part(claims)}.signature"


ECOLOGY = {"profiles": ["core", "ecology"], "required": []}


def signed(site: str) -> Tokens:
    """A contributor's tokens, good for an hour, issued by the archive at `site`."""
    return Tokens(
        access_token="a",
        id_token=jwt({"email": "ana@example.org", "cognito:groups": ["contributor"]}),
        expires_at=time.time() + 3600,
        site=site,
    )


def test_the_saved_file_follows_xdg_config_home(config_home: Path) -> None:
    assert state.config_file() == config_home / "research-archive-in-a-box" / "archive.json"


def test_connect_checks_the_archive_answers_then_saves_its_url(
    archive: Any, config_home: Path
) -> None:
    session = Session()

    answer = server.connect(session, archive.url + "/")

    assert answer["url"] == archive.url
    saved = json.loads((config_home / "research-archive-in-a-box" / "archive.json").read_text())
    assert saved == {"url": archive.url}
    assert Session().url() == archive.url
    assert [(s.method, s.path) for s in archive.seen] == [
        ("GET", "/auth-config.json"),
        ("GET", "/archive-checks.json"),
    ]


def test_connect_saves_nothing_when_the_archive_cant_be_reached(config_home: Path) -> None:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        closed = f"http://127.0.0.1:{sock.getsockname()[1]}"

    with pytest.raises(Unreachable):
        server.connect(Session(), closed)

    assert not (config_home / "research-archive-in-a-box" / "archive.json").exists()


def test_connect_refuses_a_site_that_isnt_an_archive(stub: Any, config_home: Path) -> None:
    stub.json("GET /auth-config.json", {"hello": "world"})

    with pytest.raises(Refused, match="research archive"):
        server.connect(Session(), stub.url)

    assert not (config_home / "research-archive-in-a-box" / "archive.json").exists()


def test_connect_refuses_an_address_that_isnt_a_web_address(config_home: Path) -> None:
    with pytest.raises(NotConnected, match="http"):
        server.connect(Session(), "archive.example.org")


@pytest.mark.parametrize(
    "url",
    [
        "http://example.org",
        "http://archive.example.org:8080/",
        "http://localhost.example.org",
        "http://127.0.0.1.example.org",
    ],
)
def test_connect_refuses_an_http_address_on_another_computer(config_home: Path, url: str) -> None:
    with pytest.raises(NotConnected, match="with https://"):
        server.connect(Session(), url)

    assert not (config_home / "research-archive-in-a-box" / "archive.json").exists()


@pytest.mark.parametrize(
    "url", ["http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000"]
)
def test_an_http_address_on_this_computer_is_taken(url: str) -> None:
    state.require_https(url)

    assert Session(address=url).url() == url


def test_a_saved_http_address_is_refused_with_a_note_to_connect_again(archive: Any) -> None:
    state.save_url("http://example.org", ECOLOGY)
    session = Session()

    with pytest.raises(NotConnected, match="Call connect with its https:// address"):
        session.url()
    with pytest.raises(NotConnected, match="http://example.org"):
        session.archive()

    assert session.known() == "http://example.org"
    assert session.checks == ECOLOGY
    server.connect(session, archive.url)
    assert session.url() == archive.url


def test_a_tool_before_connect_says_to_call_connect() -> None:
    with pytest.raises(NotConnected, match="connect"):
        server.sign_in(Session())


def test_connect_forgets_the_last_archives_sign_in(archive: Any, tokens: Tokens) -> None:
    session = Session(tokens=tokens, groups=["curator"])

    server.connect(session, archive.url)

    assert session.tokens is None
    assert session.groups == []


def test_sign_in_answers_the_email_and_groups_and_keeps_the_tokens(archive: Any) -> None:
    seen: list[AuthConfig] = []
    issued = Tokens(
        access_token="access",
        id_token=jwt({"email": "ana@example.org", "cognito:groups": ["contributor", "curator"]}),
        expires_at=time.time() + 3600,
        site=archive.url,
    )

    def fake_sign_in(config: AuthConfig) -> Tokens:
        seen.append(config)
        return issued

    session = Session(sign_in=fake_sign_in)
    server.connect(session, archive.url)

    answer = server.sign_in(session)

    assert answer["email"] == "ana@example.org"
    assert answer["groups"] == ["contributor", "curator"]
    assert "expires_at" in answer
    assert session.tokens == issued
    assert session.groups == ["contributor", "curator"]
    assert seen == [AuthConfig(site=archive.url)]


def test_sign_in_with_no_groups_answers_an_empty_list(archive: Any) -> None:
    issued = Tokens(
        access_token="a",
        id_token=jwt({"email": "e@x"}),
        expires_at=time.time() + 60,
        site=archive.url,
    )
    session = Session(sign_in=lambda config: issued)
    server.connect(session, archive.url)

    assert server.sign_in(session)["groups"] == []


def test_a_failed_sign_in_says_why_and_keeps_no_tokens(archive: Any) -> None:
    def refused(config: AuthConfig) -> Tokens:
        raise SignInError("sign-in failed: access_denied")

    session = Session(sign_in=refused)
    server.connect(session, archive.url)

    with pytest.raises(SignInFailed, match="access_denied"):
        server.sign_in(session)

    assert session.tokens is None


def test_the_server_lists_its_tools_and_answers_errors_in_plain_words() -> None:
    mcp = server.build(Session())

    names = {tool.name for tool in asyncio.run(mcp.list_tools())}
    assert {
        "connect",
        "sign_in",
        "search",
        "get_dataset",
        "download",
        "diagnose",
        "edit_manifest",
    } <= names

    # An anticipated error: the protocol layer answers it as is_error with this message.
    with pytest.raises(ToolError, match="No archive is set yet.*call connect"):
        asyncio.run(mcp.call_tool("sign_in", {}))


def test_a_session_stays_on_its_archive_when_the_saved_file_changes(
    archive: Any, other: Any
) -> None:
    archive.json("GET /api/submissions", {"submissions": []})
    session = Session(sign_in=lambda config: signed(config.site))
    server.connect(session, archive.url)
    server.sign_in(session)

    state.save_url(other.url)  # another window's connect
    submit.submissions(session)

    assert session.url() == archive.url
    last = archive.seen[-1]
    assert (last.method, last.path) == ("GET", "/api/submissions")
    assert session.tokens is not None
    assert last.headers["authorization"] == session.tokens.id_token
    assert other.seen == []
    assert Session().url() == other.url


def test_a_session_takes_the_saved_address_at_its_first_call_and_keeps_it(
    archive: Any, other: Any
) -> None:
    state.save_url(archive.url, ECOLOGY)
    session = Session()

    assert session.url() == archive.url
    state.save_url(other.url)

    assert session.url() == archive.url
    assert session.checks == ECOLOGY


def test_a_session_with_nothing_saved_fixes_nothing_until_there_is_an_address(
    archive: Any,
) -> None:
    session = Session()
    assert session.known() is None

    state.save_url(archive.url)

    assert session.url() == archive.url


def test_connect_moves_this_session_only_and_sets_the_default(
    archive: Any, other: Any, config_home: Path
) -> None:
    state.save_url(archive.url)
    first, second = Session(), Session()
    assert first.url() == archive.url

    answer = server.connect(second, other.url)

    assert (first.url(), second.url()) == (archive.url, other.url)
    assert state.saved_url() == other.url
    assert answer["note"] == (
        "This window now uses this archive. It is also the default for new windows; "
        "other open windows keep the archive they started with."
    )


def test_a_connect_that_fails_leaves_the_session_where_it_was(
    archive: Any, other: Any, tokens: Tokens
) -> None:
    session = Session(tokens=tokens, groups=["curator"])
    server.connect(session, archive.url)
    session.tokens = tokens
    other.json("GET /auth-config.json", {"hello": "world"})  # it answers, but is no archive

    with pytest.raises(Refused, match="research archive"):
        server.connect(session, other.url)

    assert session.url() == archive.url
    assert session.tokens == tokens
    assert state.saved_url() == archive.url


def test_sign_in_goes_to_this_sessions_archive_and_names_it(archive: Any, other: Any) -> None:
    seen: list[AuthConfig] = []

    def fake(config: AuthConfig) -> Tokens:
        seen.append(config)
        return signed(config.site)

    session = Session(sign_in=fake)
    server.connect(session, archive.url)
    state.save_url(other.url)

    answer = server.sign_in(session)

    assert seen == [AuthConfig(site=archive.url)]
    assert answer["archive"] == archive.url
    assert session.tokens is not None and session.tokens.site == archive.url


def test_a_sign_in_that_ends_after_this_window_moved_is_dropped(archive: Any, other: Any) -> None:
    session = Session()

    def moved_meanwhile(config: AuthConfig) -> Tokens:
        server.connect(session, other.url)  # this window's own connect, during the browser wait
        return signed(config.site)

    session.sign_in = moved_meanwhile
    server.connect(session, archive.url)

    with pytest.raises(SignInFailed, match=f"was for {archive.url}.*now on {other.url}"):
        server.sign_in(session)

    assert session.tokens is None
    assert session.groups == []
    assert session.url() == other.url
