import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

import pytest

from archive_client.signin import AuthConfig, SignInError, Tokens, sign_in

SITE = AuthConfig(site="https://archive.example.org")


class _Stay(urllib.request.HTTPRedirectHandler):
    """Leaves a redirect unfollowed, so the test sees the listener's own answer."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


def visit_once(request: urllib.request.Request | str, data: bytes | None = None) -> tuple[int, str]:
    """Send one request to the listener as a browser would; its status and Location, unfollowed."""
    opener = urllib.request.build_opener(_Stay)
    try:
        with opener.open(request, data=data, timeout=5) as response:
            response.read()
            return response.status, response.headers.get("Location", "")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Location", "")


def browser(
    answer: Callable[[dict[str, str]], dict[str, str] | None],
    *,
    method: str = "POST",
    statuses: list[tuple[int, str]] | None = None,
) -> tuple[Callable[[str], bool], list[str]]:
    """A fake browser: it records the URL it was opened at and, as the archive's sign-in page
    does, sends the form `answer` makes from that URL's query to the listener's callback."""
    opened: list[str] = []

    def open_browser(url: str) -> bool:
        opened.append(url)
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        form = answer(query)
        callback = f"http://127.0.0.1:{query['cli']}/callback"
        if method == "GET":
            request = urllib.request.Request(
                callback + "?" + urllib.parse.urlencode(form or {}), method="GET"
            )
        else:
            request = urllib.request.Request(
                callback,
                data=urllib.parse.urlencode(form or {}).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )

        def visit() -> None:
            answer = visit_once(request)
            if statuses is not None:
                statuses.append(answer)

        threading.Thread(target=visit, daemon=True).start()
        return True

    return open_browser, opened


def handed_back(query: dict[str, str]) -> dict[str, str]:
    """The form the sign-in page posts once the person presses Sign in the command line."""
    return {
        "id_token": "id",
        "access_token": "access",
        "expires_in": "3600",
        "state": query["state"],
    }


def test_a_posted_form_with_the_right_state_returns_the_tokens() -> None:
    open_browser, _ = browser(handed_back)
    before = time.time()

    tokens = sign_in(SITE, open_browser=open_browser, port=0)

    assert tokens == Tokens(access_token="access", id_token="id", expires_at=tokens.expires_at)
    assert before + 3600 <= tokens.expires_at <= time.time() + 3600


def test_the_browser_opens_the_archives_own_sign_in_page_with_the_port_and_state() -> None:
    open_browser, opened = browser(handed_back)

    sign_in(AuthConfig(site="https://archive.example.org/"), open_browser=open_browser, port=0)

    page = urllib.parse.urlsplit(opened[0])
    query = urllib.parse.parse_qs(page.query)
    assert (page.scheme, page.netloc, page.path) == ("https", "archive.example.org", "/sign-in")
    assert sorted(query) == ["cli", "state"]
    assert 1024 <= int(query["cli"][0]) <= 65535
    assert len(query["state"][0]) >= 32


def test_each_sign_in_has_a_state_of_its_own() -> None:
    open_browser, opened = browser(handed_back)

    sign_in(SITE, open_browser=open_browser, port=0)
    sign_in(SITE, open_browser=open_browser, port=0)

    states = [urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["state"] for url in opened]
    assert states[0] != states[1]


@pytest.mark.parametrize("state", ["someone-else", "", "é" * 43])
def test_a_wrong_state_is_refused(state: str) -> None:
    open_browser, _ = browser(lambda q: {**handed_back(q), "state": state})

    with pytest.raises(SignInError, match="state"):
        sign_in(SITE, open_browser=open_browser, port=0)


def answered(statuses: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """The browser's answers, once the fake browser's request has finished."""
    deadline = time.monotonic() + 5
    while not statuses and time.monotonic() < deadline:
        time.sleep(0.01)
    return statuses


def test_the_right_form_sends_the_tab_back_to_the_archives_own_page() -> None:
    statuses: list[tuple[int, str]] = []
    open_browser, _ = browser(handed_back, statuses=statuses)
    sign_in(AuthConfig(site="https://archive.example.org/"), open_browser=open_browser, port=0)
    assert answered(statuses) == [(303, "https://archive.example.org/sign-in?cli=done")]


def test_the_tab_goes_back_to_the_site_sign_in_was_given_whatever_the_request_says() -> None:
    statuses: list[tuple[int, str]] = []

    def from_elsewhere(url: str) -> bool:
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        request = urllib.request.Request(
            f"http://127.0.0.1:{query['cli']}/callback?next=https://evil.example",
            data=urllib.parse.urlencode(
                {**handed_back(query), "site": "https://evil.example"}
            ).encode(),
            headers={
                "Host": "evil.example",
                "Origin": "https://evil.example",
                "Referer": "https://evil.example/sign-in",
            },
            method="POST",
        )
        threading.Thread(target=lambda: statuses.append(visit_once(request)), daemon=True).start()
        return True

    sign_in(SITE, open_browser=from_elsewhere, port=0)
    assert answered(statuses) == [(303, "https://archive.example.org/sign-in?cli=done")]


@pytest.mark.parametrize(
    "form",
    [
        lambda q: {**handed_back(q), "state": "someone-else"},
        lambda q: {k: v for k, v in handed_back(q).items() if k != "id_token"},
        lambda q: {**handed_back(q), "expires_in": "soon"},
    ],
)
def test_a_refused_form_is_answered_400_not_signed_in(
    form: Callable[[dict[str, str]], dict[str, str]],
) -> None:
    statuses: list[tuple[int, str]] = []
    open_browser, _ = browser(form, statuses=statuses)
    with pytest.raises(SignInError):
        sign_in(SITE, open_browser=open_browser, port=0, timeout=5)
    assert answered(statuses) == [(400, "")]


def test_a_get_to_the_callback_is_refused() -> None:
    open_browser, _ = browser(handed_back, method="GET")

    with pytest.raises(SignInError, match="POST"):
        sign_in(SITE, open_browser=open_browser, port=0, timeout=5)


@pytest.mark.parametrize("missing", ["id_token", "access_token", "expires_in", "state"])
def test_a_form_missing_a_field_is_refused(missing: str) -> None:
    def answer(query: dict[str, str]) -> dict[str, str]:
        form = handed_back(query)
        del form[missing]
        return form

    open_browser, _ = browser(answer)

    with pytest.raises(SignInError, match=missing):
        sign_in(SITE, open_browser=open_browser, port=0, timeout=5)


@pytest.mark.parametrize("expires_in", ["soon", "-5", "0", "nan", "inf"])
def test_an_expiry_that_isnt_a_number_of_seconds_is_refused(expires_in: str) -> None:
    open_browser, _ = browser(lambda q: {**handed_back(q), "expires_in": expires_in})

    with pytest.raises(SignInError, match="expires_in"):
        sign_in(SITE, open_browser=open_browser, port=0, timeout=5)


def test_another_path_is_not_found_and_the_listener_keeps_waiting() -> None:
    def open_browser(url: str) -> bool:
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        base = f"http://127.0.0.1:{query['cli']}"

        def visit() -> None:
            with pytest.raises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(base + "/favicon.ico", timeout=5)
            assert error.value.code == 404
            form = urllib.parse.urlencode(handed_back(query)).encode()
            visit_once(base + "/callback", data=form)

        threading.Thread(target=visit, daemon=True).start()
        return True

    assert sign_in(SITE, open_browser=open_browser, port=0, timeout=5).access_token == "access"


def test_sign_in_times_out_when_no_callback_comes() -> None:
    with pytest.raises(SignInError, match="timed out"):
        sign_in(SITE, open_browser=lambda url: True, port=0, timeout=0.3)


def test_a_port_already_in_use_says_another_sign_in_may_be_waiting() -> None:
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        port = taken.getsockname()[1]

        with pytest.raises(SignInError, match=f"port {port} is in use"):
            sign_in(SITE, open_browser=lambda url: True, port=port, timeout=1)


def test_a_browser_that_wont_open_is_reported() -> None:
    with pytest.raises(SignInError, match="no browser could be opened"):
        sign_in(SITE, open_browser=lambda url: False, port=0, timeout=5)


def test_a_silent_connection_cant_hold_the_listener(monkeypatch: pytest.MonkeyPatch) -> None:
    from archive_client import signin

    monkeypatch.setattr(signin, "REQUEST_TIMEOUT", 0.2, raising=False)
    silent = socket.socket()

    def open_browser(url: str) -> bool:
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        silent.connect(("127.0.0.1", int(query["cli"])))  # connects and never sends a byte

        def visit() -> None:
            time.sleep(0.1)
            form = urllib.parse.urlencode(handed_back(query)).encode()
            visit_once(f"http://127.0.0.1:{query['cli']}/callback", data=form)

        threading.Thread(target=visit, daemon=True).start()
        # Without a socket timeout the listener waits on the silent connection until it closes.
        threading.Timer(5, silent.close).start()
        return True

    started = time.monotonic()
    tokens = sign_in(SITE, open_browser=open_browser, port=0, timeout=30)

    assert tokens.access_token == "access"
    assert time.monotonic() - started < 3
