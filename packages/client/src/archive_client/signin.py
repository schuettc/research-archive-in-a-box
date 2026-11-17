"""Browser sign-in to an archive through the archive's own sign-in page.

The browser opens `<site>/sign-in?cli=<port>&state=<state>`. The person signs in there as they
do for the web app, then presses Sign in the command line, and the page posts the one-hour ID
and access tokens as a form to a one-shot listener on `http://localhost:<port>/callback`. The
listener checks the state it made and sends the tab back to `<site>/sign-in?cli=done`, the
archive's own page saying the command line is signed in. No refresh token comes back, so tokens
live only as long as the caller keeps them.
"""

import math
import secrets
import time
import urllib.parse
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

CALLBACK_PORT = 8765
TIMEOUT = 300.0
"""Seconds to wait for the browser to come back to the callback."""
REQUEST_TIMEOUT = 10.0
"""Seconds one connection to the listener may take, so a silent one can't hold it."""
MAX_FORM = 64 * 1024
"""The most bytes the callback reads: two tokens and a state fit well inside it."""

_FIELDS = ("id_token", "access_token", "expires_in", "state")


class SignInError(Exception):
    """Sign-in didn't finish: the browser never came back, or the callback was refused."""


@dataclass(frozen=True)
class AuthConfig:
    """Where to sign in to one archive: its site, such as https://d111.cloudfront.net."""

    site: str


@dataclass(frozen=True)
class Tokens:
    """The one-hour tokens from a sign-in. `expires_at` is seconds since the epoch."""

    access_token: str
    id_token: str
    expires_at: float


class _Callback(HTTPServer):
    state: str = ""
    done: str = ""
    """Where the tab goes once the form is taken: the archive's page, from the site sign_in was
    given and never from the request."""
    tokens: Tokens | None = None
    refused: str | None = None


class _Handler(BaseHTTPRequestHandler):
    server: _Callback

    def setup(self) -> None:
        self.request.settimeout(REQUEST_TIMEOUT)
        super().setup()

    def do_GET(self) -> None:
        if urllib.parse.urlsplit(self.path).path != "/callback":
            self.send_error(404)
            return
        self.server.refused = "the callback came as a GET; the archive's sign-in page POSTs it"
        self.send_error(405)

    def do_POST(self) -> None:
        if urllib.parse.urlsplit(self.path).path != "/callback":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if not 0 < length <= MAX_FORM:
            self.server.refused = "the callback's form was empty or too large"
            self.send_error(400)
            return
        body = self.rfile.read(length).decode("utf-8", "replace")
        # Check the form before answering, so the browser says signed in only when it is.
        try:
            self.server.tokens = _tokens(dict(urllib.parse.parse_qsl(body)), self.server.state)
        except SignInError as exc:
            self.server.refused = str(exc)
            self.send_error(400)
            return
        self.send_response(303)
        self.send_header("Location", self.server.done)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        pass


def _wait(server: _Callback, timeout: float) -> Tokens:
    deadline = time.monotonic() + timeout
    while server.tokens is None:
        if server.refused:
            raise SignInError(server.refused)
        left = deadline - time.monotonic()
        if left <= 0:
            raise SignInError("sign-in timed out waiting for the browser")
        server.timeout = left
        server.handle_request()
    return server.tokens


def _tokens(form: dict[str, str], state: str) -> Tokens:
    """The tokens from the callback's form, once its state is the one this sign-in made."""
    for name in _FIELDS:
        if not form.get(name):
            raise SignInError(f"the sign-in callback carried no {name}")
    if not secrets.compare_digest(form["state"].encode(), state.encode()):
        raise SignInError("the sign-in callback's state doesn't match; try again")
    try:
        expires_in = float(form["expires_in"])
    except ValueError:
        expires_in = math.nan
    if not (math.isfinite(expires_in) and expires_in > 0):
        raise SignInError(f"the sign-in callback's expires_in isn't seconds: {form['expires_in']}")
    return Tokens(
        access_token=form["access_token"],
        id_token=form["id_token"],
        expires_at=time.time() + expires_in,
    )


def sign_in(
    config: AuthConfig,
    *,
    open_browser: Callable[[str], bool] = webbrowser.open,
    port: int = CALLBACK_PORT,
    timeout: float = TIMEOUT,
) -> Tokens:
    """Sign in on the archive's own sign-in page in the browser; return the access and ID tokens.

    Raises SignInError on a state mismatch, a callback that isn't the page's form, or the
    timeout. `port` is 0 in tests, for any free port.
    """
    state = secrets.token_urlsafe(32)
    try:
        listener = _Callback(("127.0.0.1", port), _Handler)
    except OSError as exc:
        raise SignInError(
            f"port {port} is in use: another sign-in may still be waiting; finish it in the "
            "browser or wait a few minutes"
        ) from exc
    with listener as server:
        server.state = state
        site = config.site.rstrip("/")
        server.done = f"{site}/sign-in?cli=done"
        query = urllib.parse.urlencode({"cli": server.server_address[1], "state": state})
        page = f"{site}/sign-in?{query}"
        if not open_browser(page):
            raise SignInError(
                "no browser could be opened to sign in; sign in from a machine with a web browser"
            )
        return _wait(server, timeout)
