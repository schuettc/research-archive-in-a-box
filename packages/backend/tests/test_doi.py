import base64
import hashlib
import io
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import jsonschema  # type: ignore[import-untyped]  # no stubs; a test-only import
import pytest
from botocore.exceptions import ClientError

from archive_backend import doi
from archive_backend.doi import DataCiteError, DoiTaken, HttpDataCite
from archive_backend.integrity import check_archive
from archive_contract.config import Doi
from archive_contract.manifest import Manifest
from datacite_fake import FakeDataCite

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"
TEST = Doi(repository="EXAMPLE.IRC", prefix="10.5072", test=True)
LIVE = Doi(repository="EXAMPLE.IRC", prefix="10.5072", test=False)
NAME = "10.5072/example.irc.stream.v1"
URL = "https://d111.cloudfront.net/datasets/stream/v1"
ARCHIVE = "archive"
ROOT = "open/stream/1/"
PASSWORD = "s3cret-pa55word"
# Invenio's community JSON Schema for DataCite Metadata Schema 4.5 (see the README beside it)
DATACITE_SCHEMA = Path(__file__).parent / "fixtures" / "datacite" / "datacite-v4.5.json"
# Keys of the REST API's attributes that aren't metadata properties, so the metadata schema
# doesn't know them: the DOI's name, where it resolves, and the state change a PUT asks for.
REST_ONLY = ("doi", "url", "event")
FUNDING = [
    {"funder": "Invented Foundation", "awardNumber": "X-1", "awardUri": "https://example.org/x-1"}
]
WITHDRAWN = {"at": "2026-11-20T10:00:00Z", "by": "admin-1", "reason": "Consent was withdrawn."}


def _sample(**changes: Any) -> Manifest:
    raw = json.loads((SAMPLE / "datapackage.json").read_text(encoding="utf-8"))
    raw.update({"id": "stream", "version": "1", "archive:published": "2026-11-14T09:30:00Z"})
    raw.update(changes)
    return Manifest.model_validate(raw)


def test_the_doi_name_and_both_addresses() -> None:
    assert doi.doi_name(TEST, "stream", 1) == NAME
    assert doi.address(TEST, NAME) == "https://handle.test.datacite.org/" + NAME
    assert doi.address(LIVE, NAME) == "https://doi.org/" + NAME
    assert doi.endpoint(TEST) == "https://api.test.datacite.org"
    assert doi.endpoint(LIVE) == "https://api.datacite.org"


def test_only_an_address_under_the_configured_prefix_and_system_is_current() -> None:
    assert doi.is_current(TEST, "https://handle.test.datacite.org/" + NAME)
    assert not doi.is_current(LIVE, "https://handle.test.datacite.org/" + NAME)
    assert not doi.is_current(TEST, "https://handle.test.datacite.org/10.9999/x")
    assert not doi.is_current(TEST, URL)
    assert not doi.is_current(TEST, None)


def test_the_attributes_carry_the_doi_and_url_and_every_list() -> None:
    record = doi.attributes(
        _sample(), publisher="Example Archive", doi=NAME, url=URL, withdrawn=None
    )

    assert "identifiers" not in record
    assert (record["doi"], record["url"]) == (NAME, URL)
    assert record["publisher"] == {"name": "Example Archive"}
    assert record["publicationYear"] == "2026"
    assert record["types"]["resourceTypeGeneral"] == "Dataset"
    for name in doi.LISTS:
        assert isinstance(record[name], list)
    assert not any(
        d["descriptionType"] == "Other" and "Withdrawn" in d["description"]
        for d in record["descriptions"]
    )


def test_a_removed_list_is_sent_empty() -> None:
    record = doi.attributes(
        _sample(**{"archive:funding": None, "keywords": None}),
        publisher="P",
        doi=NAME,
        url=URL,
        withdrawn=None,
    )

    assert record["fundingReferences"] == []
    assert record["subjects"] == []


def test_a_withdrawn_record_adds_the_withdrawal_description() -> None:
    record = doi.attributes(_sample(), publisher="P", doi=NAME, url=URL, withdrawn=WITHDRAWN)

    assert record["descriptions"][-1] == {
        "description": "Withdrawn on 2026-11-20: Consent was withdrawn.",
        "descriptionType": "Other",
    }
    assert record["url"] == URL


def _schema_errors(record: dict[str, Any]) -> list[str]:
    schema = json.loads(DATACITE_SCHEMA.read_text(encoding="utf-8"))
    validator = jsonschema.Draft201909Validator(
        schema, format_checker=jsonschema.Draft201909Validator.FORMAT_CHECKER
    )
    metadata = {k: v for k, v in record.items() if k not in REST_ONLY}
    return [
        f"{'/'.join(map(str, e.absolute_path))}: {e.message}"
        for e in validator.iter_errors(metadata)
    ]


@pytest.mark.parametrize(
    ("changes", "withdrawn"),
    [
        pytest.param({"archive:funding": FUNDING}, None, id="new-version"),
        pytest.param({"archive:funding": None, "keywords": None}, None, id="funding-removed"),
        pytest.param({"archive:funding": FUNDING}, WITHDRAWN, id="withdrawn"),
    ],
)
def test_the_record_meets_datacite_metadata_schema_4_5(
    changes: dict[str, Any], withdrawn: dict[str, Any] | None
) -> None:
    record = doi.attributes(
        _sample(**changes), publisher="Example Archive", doi=NAME, url=URL, withdrawn=withdrawn
    )
    sent = {**record, "event": "publish"} if withdrawn is None else record

    assert _schema_errors(sent) == []
    assert (record["fundingReferences"] == []) == (changes["archive:funding"] is None)
    assert any("Withdrawn on" in d["description"] for d in record["descriptions"]) == bool(
        withdrawn
    )


def _register(dc: FakeDataCite, url: str = URL) -> str:
    return doi.register(dc, TEST, _sample(), publisher="P", dataset_id="stream", version=1, url=url)


def test_register_makes_a_findable_doi_and_returns_its_address() -> None:
    dc = FakeDataCite()

    found = _register(dc)

    assert found == "https://handle.test.datacite.org/" + NAME
    assert dc.dois[NAME]["state"] == "findable"
    assert dc.dois[NAME]["url"] == URL
    [(name, sent)] = dc.puts()
    assert (name, sent["event"]) == (NAME, "publish")


def test_register_repeats_harmlessly() -> None:
    dc = FakeDataCite()
    _register(dc)
    before = dict(dc.dois)

    assert _register(dc) == "https://handle.test.datacite.org/" + NAME
    assert dc.dois == before


def test_register_refuses_a_doi_that_points_elsewhere() -> None:
    dc = FakeDataCite()
    _register(dc, url="https://other.example/datasets/stream/v1")

    with pytest.raises(DoiTaken, match="other.example"):
        _register(dc)
    assert dc.dois[NAME]["url"] == "https://other.example/datasets/stream/v1"
    assert len(dc.puts()) == 1


@pytest.mark.parametrize(
    "stored",
    [
        URL + "/",
        "https://D111.CloudFront.NET/datasets/stream/v1",
        "HTTPS://d111.cloudfront.net/datasets/stream/v1/",
    ],
)
def test_register_finds_its_own_doi_whatever_datacite_normalised(stored: str) -> None:
    dc = FakeDataCite()
    dc.dois[NAME] = {"url": stored}

    assert _register(dc) == "https://handle.test.datacite.org/" + NAME
    assert dc.dois[NAME]["url"] == URL


def test_register_refuses_the_same_host_with_another_path() -> None:
    dc = FakeDataCite()
    dc.dois[NAME] = {"url": "https://d111.cloudfront.net/datasets/stream/v2"}

    with pytest.raises(DoiTaken, match="v2"):
        _register(dc)
    assert dc.puts() == []


def test_update_sends_no_event() -> None:
    dc = FakeDataCite()
    _register(dc)

    doi.update(
        dc, TEST, _sample(description="Fixed."), publisher="P", doi=NAME, url=URL, withdrawn=None
    )

    _, sent = dc.puts()[-1]
    assert "event" not in sent
    assert sent["descriptions"][0]["description"] == "Fixed."
    assert dc.dois[NAME]["state"] == "findable"


def test_the_client_reads_the_password_parameter_with_decryption(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    class SSM:
        def get_parameter(self, **kwargs: Any) -> dict[str, Any]:
            calls.append(kwargs)
            return {"Parameter": {"Value": PASSWORD}}

    monkeypatch.setenv(doi.PASSWORD_PARAMETER_ENV, "/research-archive/test/datacite-password")

    made = doi.client(SSM(), TEST)

    assert calls == [{"Name": "/research-archive/test/datacite-password", "WithDecryption": True}]
    assert PASSWORD not in repr(made)


def _b64(body: bytes) -> str:
    return base64.b64encode(hashlib.sha256(body).digest()).decode()


class FakeS3:
    """Objects with the full SHA-256 a put gave, as the integrity check reads them."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.checksums: dict[tuple[str, str], str] = {}

    def load(self, key: str, body: bytes) -> None:
        self.objects[(ARCHIVE, key)] = body
        self.checksums[(ARCHIVE, key)] = _b64(body)

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, **kwargs: Any) -> dict[str, Any]:
        assert kwargs["ChecksumSHA256"] == _b64(Body)
        self.objects[(Bucket, Key)] = Body
        self.checksums[(Bucket, Key)] = kwargs["ChecksumSHA256"]
        return {}

    def head_object(self, *, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ChecksumSHA256": self.checksums[(Bucket, Key)]}

    def get_paginator(self, name: str) -> "FakeS3":
        return self

    def paginate(self, *, Bucket: str, Prefix: str) -> Iterator[dict[str, Any]]:
        keys = sorted(k for b, k in self.objects if b == Bucket and k.startswith(Prefix))
        yield {"Contents": [{"Key": k} for k in keys]}


def test_write_identifier_rewrites_only_the_manifest_and_its_checksum_line() -> None:
    s3 = FakeS3()
    for path in sorted(SAMPLE.rglob("*")):
        relative = path.relative_to(SAMPLE)
        if path.is_file() and "_build" not in relative.parts:
            s3.load(ROOT + str(relative), path.read_bytes())
    before = dict(s3.objects)
    identifier = "https://handle.test.datacite.org/" + NAME

    stored = doi.write_identifier(s3, ARCHIVE, ROOT, identifier)  # type: ignore[arg-type]

    assert stored["archive:identifier"] == identifier
    changed = {key for key, body in s3.objects.items() if before[key] != body}
    assert changed == {(ARCHIVE, ROOT + "datapackage.json"), (ARCHIVE, ROOT + "checksums.sha256")}
    written = json.loads(s3.objects[(ARCHIVE, ROOT + "datapackage.json")])
    assert written["archive:identifier"] == identifier
    assert check_archive(s3, ARCHIVE) == []  # type: ignore[arg-type]


class _Recorder(BaseHTTPRequestHandler):
    seen: list[dict[str, Any]] = []

    def _answer(self, status: int, body: dict[str, Any]) -> None:
        text = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/vnd.api+json")
        self.send_header("Content-Length", str(len(text)))
        self.end_headers()
        self.wfile.write(text)

    def _record(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        seen = {
            "method": self.command,
            "path": self.path,
            "headers": dict(self.headers),
            "body": json.loads(self.rfile.read(length)) if length else None,
        }
        self.seen.append(seen)
        return seen

    def do_GET(self) -> None:
        self._record()
        if self.path.endswith(".missing.v1"):
            self._answer(404, {"errors": [{"status": "404", "title": "not found"}]})
        else:
            self._answer(200, {"data": {"id": NAME, "attributes": {"url": URL}}})

    def do_PUT(self) -> None:
        seen = self._record()
        if self.path.endswith(".bad.v1"):
            self._answer(422, {"errors": [{"title": "Url is not allowed by repository domain"}]})
        else:
            self._answer(
                201, {"data": {"id": NAME, "attributes": seen["body"]["data"]["attributes"]}}
            )

    def log_message(self, *_: Any) -> None:
        pass


@pytest.fixture
def server() -> Iterator[str]:
    _Recorder.seen = []
    httpd = HTTPServer(("127.0.0.1", 0), _Recorder)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def test_the_http_client_puts_a_jsonapi_body_with_basic_auth(server: str) -> None:
    dc = HttpDataCite(server, "EXAMPLE.IRC", PASSWORD)

    stored = dc.put(NAME, {"url": URL, "event": "publish"})

    [seen] = _Recorder.seen
    assert (seen["method"], seen["path"]) == ("PUT", "/dois/" + NAME)
    token = base64.b64encode(f"EXAMPLE.IRC:{PASSWORD}".encode()).decode()
    assert seen["headers"]["Authorization"] == f"Basic {token}"
    assert seen["headers"]["Content-Type"] == "application/vnd.api+json"
    assert seen["headers"]["Accept"] == "application/vnd.api+json"
    assert seen["body"] == {
        "data": {"id": NAME, "type": "dois", "attributes": {"url": URL, "event": "publish"}}
    }
    assert stored["url"] == URL


def test_the_http_client_reads_a_doi_and_none_on_404(server: str) -> None:
    dc = HttpDataCite(server, "EXAMPLE.IRC", PASSWORD)

    assert dc.get(NAME) == {"url": URL}
    assert dc.get("10.5072/example.irc.missing.v1") is None
    assert [s["method"] for s in _Recorder.seen] == ["GET", "GET"]


def test_a_refusal_raises_without_the_password(server: str) -> None:
    dc = HttpDataCite(server, "EXAMPLE.IRC", PASSWORD)

    with pytest.raises(DataCiteError) as raised:
        dc.put("10.5072/example.irc.bad.v1", {"url": URL})

    assert raised.value.status == 422
    assert "repository domain" in str(raised.value)
    token = base64.b64encode(f"EXAMPLE.IRC:{PASSWORD}".encode()).decode()
    assert PASSWORD not in str(raised.value) and token not in str(raised.value)


def test_no_answer_raises_a_datacite_error() -> None:
    dc = HttpDataCite("http://127.0.0.1:9", "EXAMPLE.IRC", PASSWORD)

    with pytest.raises(DataCiteError) as raised:
        dc.get(NAME)

    assert raised.value.status == 0
    assert PASSWORD not in str(raised.value)
