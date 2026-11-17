"""Smoke-test a deployed archive with no sign-in: python scripts/smoke.py <domain>.

Prints one line per check (ok, failed: <why>, or skipped: no seed yet) and exits 1 on any
failure. Until the sample dataset is published, the dataset checks are skipped. The archive gives
a published dataset an id of its own, so the sample is found in search by its title.
"""

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

SAMPLE = Path(__file__).resolve().parents[1] / "examples" / "sample-package" / "datapackage.json"
TIMEOUT_SECONDS = 30
# A custom domain's records are new on its first deploy, so a resolver may not find the name for
# a minute; a request that doesn't reach the site is tried again before it fails the check.
ATTEMPTS = 6
RETRY_SECONDS = 10

Answer = tuple[int, dict[str, str], bytes]
Fetch = Callable[[str], Answer]


class CheckFailed(Exception):
    pass


class NoSeed(Exception):
    pass


def http_fetch(url: str) -> Answer:
    """GET a URL: its status, lower-cased headers and body, whatever the status."""
    request = urllib.request.Request(url, headers={"user-agent": "research-archive-smoke"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            headers = {k.lower(): v for k, v in response.headers.items()}
            return response.status, headers, response.read()
    except urllib.error.HTTPError as error:
        headers = {k.lower(): v for k, v in error.headers.items()}
        return error.code, headers, error.read()


def sample_title() -> str:
    """The sample package's title, which its published copy keeps."""
    return str(json.loads(SAMPLE.read_text(encoding="utf-8"))["title"])


class Smoke:
    def __init__(self, domain: str, dataset: str | None, fetch: Fetch) -> None:
        """`dataset` names a published dataset's id; None finds the sample by its title."""
        self.base = f"https://{domain}"
        self.dataset = dataset
        self.title = sample_title() if dataset is None else None
        self.fetch = fetch

    def _get(self, path: str) -> Answer:
        for attempt in range(ATTEMPTS):
            try:
                status, headers, body = self.fetch(self.base + path)
                break
            except (urllib.error.URLError, OSError) as error:
                if attempt == ATTEMPTS - 1:
                    raise CheckFailed(f"{path} did not answer: {error}") from None
                time.sleep(RETRY_SECONDS)
        if status != 200:
            raise CheckFailed(f"{path} answered {status}")
        return status, headers, body

    def _html(self, path: str) -> None:
        _, headers, _ = self._get(path)
        if "text/html" not in headers.get("content-type", ""):
            raise CheckFailed(f"{path} is {headers.get('content-type', 'untyped')}, not HTML")

    def _json(self, path: str) -> Any:
        _, _, body = self._get(path)
        try:
            return json.loads(body)
        except ValueError:
            raise CheckFailed(f"{path} did not answer JSON") from None

    def site(self) -> None:
        self._html("/")

    def health(self) -> None:
        answer = self._json("/api/health")
        if answer != {"status": "ok"}:
            raise CheckFailed(f"/api/health answered {answer!r}")

    def search(self) -> None:
        answer = self._json("/api/search?q=stream")
        rows = answer.get("rows") if isinstance(answer, dict) else None
        if not isinstance(rows, list):
            raise CheckFailed("/api/search answered no rows list")
        for row in rows:
            if not isinstance(row, dict):
                continue
            if self.dataset is not None and row.get("id") == self.dataset:
                return
            if self.title is not None and row.get("title") == self.title:
                self.dataset = str(row.get("id"))
                return
        raise NoSeed

    def page(self) -> None:
        self._html(f"/datasets/{quote(self.dataset or '')}")

    def download(self) -> None:
        dataset = quote(self.dataset or "")
        version = self._json(f"/api/datasets/{dataset}").get("currentVersion")
        if not isinstance(version, int):
            raise CheckFailed(f"/api/datasets/{self.dataset} has no currentVersion")
        manifest = self._json(f"/data/{dataset}/{version}/datapackage.json")
        resource = _first_hashed_file(manifest.get("resources", []))
        if resource is None:
            raise CheckFailed("the manifest has no single-file resource with a hash")
        path, expected = resource
        _, _, body = self._get(f"/data/{dataset}/{version}/{quote(path)}")
        actual = hashlib.sha256(body).hexdigest()
        if actual != expected:
            raise CheckFailed(f"{path} has SHA-256 {actual}; the manifest says {expected}")


def _first_hashed_file(resources: object) -> tuple[str, str] | None:
    """The first resource whose path is one local file with a SHA-256 hash: (path, hex)."""
    if not isinstance(resources, list):
        return None
    for resource in resources:
        if not isinstance(resource, dict):
            continue
        path, hash_ = resource.get("path"), resource.get("hash")
        if not isinstance(path, str) or not isinstance(hash_, str) or "://" in path:
            continue
        algorithm, _, hex_ = hash_.rpartition(":")
        if algorithm in ("", "sha256"):
            return path, hex_.lower()
    return None


def main(argv: list[str] | None = None, fetch: Fetch = http_fetch) -> int:
    parser = argparse.ArgumentParser(description="Smoke-test a deployed archive.")
    parser.add_argument("domain", help="the site's domain, such as d111.cloudfront.net")
    parser.add_argument("--dataset", help="a published dataset's id; by default, the sample")
    args = parser.parse_args(argv)
    smoke = Smoke(args.domain, args.dataset, fetch)

    checks: list[tuple[str, Callable[[], None]]] = [
        ("site", smoke.site),
        ("health", smoke.health),
        ("search", smoke.search),
        ("dataset page", smoke.page),
        ("download", smoke.download),
    ]
    failed = False
    seeded = True
    for name, check in checks:
        if not seeded:
            print(f"{name}: skipped: no seed yet")
            continue
        try:
            check()
        except NoSeed:
            seeded = False
            print(f"{name}: skipped: no seed yet")
        except CheckFailed as error:
            failed = True
            print(f"{name}: failed: {error}")
        except Exception as error:  # an answer of an unexpected shape fails the check
            failed = True
            print(f"{name}: failed: {type(error).__name__}: {error}")
        else:
            print(f"{name}: ok")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
