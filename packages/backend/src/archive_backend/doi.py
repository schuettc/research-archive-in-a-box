"""The optional DOI module: a findable DataCite DOI for each published version.

An archive turns it on with a `doi:` block in `archive.yaml`. A version's DOI is
`<prefix>/<repository id, lower-cased>.<dataset id>.v<n>`, its `url` the version's page, and its
record the contract's DataCite export of the version's manifest, sent to DataCite's REST API
(https://support.datacite.org/docs/api-create-dois). The version's `archive:identifier` holds
the DOI's address: `https://doi.org/<doi>`, or DataCite's test handle server with `test: true`.

The repository's password is an SSM SecureString read inside the step that uses it, and never
logged, returned or checkpointed.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from typing import Any, Protocol

from archive_contract.config import Doi
from archive_contract.exports.datacite import to_datacite
from archive_contract.manifest import Manifest

PASSWORD_PARAMETER_ENV = "DATACITE_PASSWORD_PARAMETER"
TEST_API = "https://api.test.datacite.org"
LIVE_API = "https://api.datacite.org"
TEST_RESOLVER = "https://handle.test.datacite.org/"
LIVE_RESOLVER = "https://doi.org/"
RESOLVERS = (LIVE_RESOLVER, TEST_RESOLVER)
MEDIA_TYPE = "application/vnd.api+json"
TIMEOUT = 30
MANIFEST = "datapackage.json"
CHECKSUMS = "checksums.sha256"
# A list sent replaces DataCite's whole stored list, so every list the export can write is sent,
# empty when the manifest has none, or a removed one would stay on DataCite.
LISTS = (
    "contributors",
    "descriptions",
    "subjects",
    "dates",
    "geoLocations",
    "relatedIdentifiers",
    "fundingReferences",
    "formats",
)


class SSM(Protocol):
    def get_parameter(self, **kwargs: Any) -> dict[str, Any]: ...


class S3(Protocol):
    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def put_object(self, **kwargs: Any) -> Any: ...


class DataCiteError(Exception):
    """DataCite answered with a status the module can't act on, or didn't answer."""

    def __init__(self, status: int, text: str) -> None:
        super().__init__(f"DataCite answered {status}: {text}")
        self.status = status


class DoiTaken(Exception):
    """The DOI exists and points somewhere else, so registering would repoint it."""

    def __init__(self, doi: str, url: str) -> None:
        super().__init__(f"DOI {doi} already points to {url}")
        self.doi = doi
        self.url = url


class DataCite(Protocol):
    def get(self, doi: str) -> dict[str, Any] | None:
        """The DOI's attributes, or None when DataCite has no such DOI."""
        ...

    def put(self, doi: str, attributes: dict[str, Any]) -> dict[str, Any]:
        """Create or update the DOI with `attributes`; the stored attributes."""
        ...


def endpoint(settings: Doi) -> str:
    return TEST_API if settings.test else LIVE_API


def resolver(settings: Doi) -> str:
    return TEST_RESOLVER if settings.test else LIVE_RESOLVER


def doi_name(settings: Doi, dataset_id: str, version: int) -> str:
    return f"{settings.prefix}/{settings.repository.lower()}.{dataset_id}.v{version}"


def address(settings: Doi, name: str) -> str:
    return resolver(settings) + name


def is_current(settings: Doi, identifier: object) -> bool:
    """Whether `identifier` is a DOI address under the configured prefix and system."""
    return isinstance(identifier, str) and identifier.startswith(
        resolver(settings) + settings.prefix + "/"
    )


def name_of(settings: Doi, identifier: str) -> str:
    """The bare DOI of a current DOI address."""
    return identifier.removeprefix(resolver(settings))


def attributes(
    manifest: Manifest,
    *,
    publisher: str,
    doi: str,
    url: str,
    withdrawn: dict[str, Any] | None,
) -> dict[str, Any]:
    """The DOI's attributes for DataCite's REST API: the DataCite export with the DOI in `doi`,
    the publisher as an object, every list present, and for a withdrawn version a description of
    the withdrawal."""
    year = (manifest.published or datetime.now(UTC)).year
    record = to_datacite(manifest, publisher=publisher, year=year, identifier=doi)
    record.pop("identifiers", None)
    # Metadata Schema 4.5's publisher is an object; the REST API takes it as one too.
    record["publisher"] = {"name": publisher}
    for name in LISTS:
        record.setdefault(name, [])
    if withdrawn is not None:
        record["descriptions"] = [
            *record["descriptions"],
            {
                "description": f"Withdrawn on {str(withdrawn['at'])[:10]}: {withdrawn['reason']}",
                "descriptionType": "Other",
            },
        ]
    record["doi"] = doi
    record["url"] = url
    return record


class HttpDataCite:
    """DataCite's REST API over HTTP basic authentication with the repository id and password."""

    def __init__(self, endpoint: str, repository: str, password: str) -> None:
        self._endpoint = endpoint.rstrip("/")
        token = base64.b64encode(f"{repository}:{password}".encode()).decode("ascii")
        self._authorization = f"Basic {token}"

    def __repr__(self) -> str:
        return f"HttpDataCite({self._endpoint!r})"

    def _send(self, method: str, doi: str, body: dict[str, Any] | None) -> dict[str, Any] | None:
        request = urllib.request.Request(
            f"{self._endpoint}/dois/{urllib.parse.quote(doi, safe='/')}",
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            headers={
                "Authorization": self._authorization,
                "Content-Type": MEDIA_TYPE,
                "Accept": MEDIA_TYPE,
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
                found: dict[str, Any] = json.loads(answer.read() or b"{}")
                return found
        except urllib.error.HTTPError as error:
            if method == "GET" and error.code == 404:
                return None
            text = error.read().decode("utf-8", errors="replace")[:500]
            raise DataCiteError(error.code, text) from None
        except (urllib.error.URLError, TimeoutError) as error:
            raise DataCiteError(0, str(getattr(error, "reason", error))[:500]) from None

    def get(self, doi: str) -> dict[str, Any] | None:
        found = self._send("GET", doi, None)
        if found is None:
            return None
        stored: dict[str, Any] = (found.get("data") or {}).get("attributes") or {}
        return stored

    def put(self, doi: str, attributes: dict[str, Any]) -> dict[str, Any]:
        body = {"data": {"id": doi, "type": "dois", "attributes": attributes}}
        found = self._send("PUT", doi, body) or {}
        stored: dict[str, Any] = (found.get("data") or {}).get("attributes") or {}
        return stored


def client(ssm: SSM, settings: Doi) -> HttpDataCite:
    """A DataCite client with the password from the SSM parameter the function is given. Call it
    inside the step that uses it; never return it from a step."""
    name = os.environ[PASSWORD_PARAMETER_ENV]
    password: str = ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    return HttpDataCite(endpoint(settings), settings.repository, password)


def register(
    dc: DataCite,
    settings: Doi,
    manifest: Manifest,
    *,
    publisher: str,
    dataset_id: str,
    version: int,
    url: str,
) -> str:
    """Register the version's DOI, findable, and return its address. Safe to repeat: a retry
    finds its own DOI and puts the same record. A DOI pointing elsewhere raises DoiTaken."""
    name = doi_name(settings, dataset_id, version)
    found = dc.get(name)
    stored = None if found is None else found.get("url")
    if stored is not None and not _same_url(str(stored), url):
        raise DoiTaken(name, str(stored))
    record = attributes(manifest, publisher=publisher, doi=name, url=url, withdrawn=None)
    dc.put(name, {**record, "event": "publish"})
    return address(settings, name)


def _same_url(a: str, b: str) -> bool:
    """Whether two URLs are the same page, as DataCite may normalise a stored url: the scheme
    and host compared lower-cased, and a trailing slash ignored."""

    def normal(url: str) -> tuple[str, str, str, str, str]:
        parts = urllib.parse.urlsplit(url)
        return (
            parts.scheme.lower(),
            parts.netloc.lower(),
            parts.path.rstrip("/"),
            parts.query,
            parts.fragment,
        )

    return normal(a) == normal(b)


def update(
    dc: DataCite,
    settings: Doi,
    manifest: Manifest,
    *,
    publisher: str,
    doi: str,
    url: str,
    withdrawn: dict[str, Any] | None,
) -> None:
    """Re-send the DOI's record, leaving its state as it is."""
    dc.put(doi, attributes(manifest, publisher=publisher, doi=doi, url=url, withdrawn=withdrawn))


def _put(s3: S3, bucket: str, key: str, body: bytes, kind: str) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType=kind,
        ChecksumSHA256=base64.b64encode(hashlib.sha256(body).digest()).decode("ascii"),
    )


def write_identifier(s3: S3, bucket: str, root: str, identifier: str) -> dict[str, Any]:
    """Write the DOI's address into the stored version's `archive:identifier`, rewriting its
    manifest and that line of `checksums.sha256` (the manifest last); the data files and the
    README are untouched. The stored manifest."""
    # Imported here: curation imports reindex, which imports this module.
    from archive_backend.curation import checksum_lines

    raw: dict[str, Any] = json.loads(
        s3.get_object(Bucket=bucket, Key=root + MANIFEST)["Body"].read()
    )
    raw["archive:identifier"] = identifier
    Manifest.model_validate(raw)
    body = (json.dumps(raw, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    listed = s3.get_object(Bucket=bucket, Key=root + CHECKSUMS)["Body"].read().decode("utf-8")
    sums = checksum_lines(listed, {MANIFEST: body}).encode("utf-8")
    _put(s3, bucket, root + CHECKSUMS, sums, "text/plain")
    _put(s3, bucket, root + MANIFEST, body, "application/json")
    return raw
