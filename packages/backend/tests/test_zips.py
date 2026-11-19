import base64
import hashlib
import io
import json
import zipfile
from pathlib import Path
from typing import Any, cast

import pytest
from botocore.exceptions import ClientError

from archive_backend import parts, zips

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package"
BUCKET = "archive"
ROOT = "open/stream/1/"


class FakeS3:
    """Objects with their metadata; every put must carry its full-object SHA-256."""

    def __init__(self, *, can_list: bool = True) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.metadata: dict[tuple[str, str], dict[str, str]] = {}
        self.puts: list[dict[str, Any]] = []
        self.uploads: dict[tuple[str, str], dict[str, Any]] = {}
        self.multipart: list[dict[str, Any]] = []
        # Without s3:ListBucket, S3 answers a missing key with 403 rather than 404.
        self.can_list = can_list

    def _missing(self, operation: str) -> ClientError:
        if not self.can_list:
            code = "403" if operation == "HeadObject" else "AccessDenied"
        else:
            code = "404" if operation == "HeadObject" else "NoSuchKey"
        return ClientError({"Error": {"Code": code}}, operation)

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise self._missing("GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise self._missing("HeadObject")
        return {"Metadata": self.metadata.get((Bucket, Key), {})}

    def put_object(self, *, Bucket: str, Key: str, Body: Any, **extra: Any) -> dict[str, Any]:
        body = Body.read() if hasattr(Body, "read") else Body
        assert extra["ChecksumSHA256"] == base64.b64encode(hashlib.sha256(body).digest()).decode()
        self.objects[(Bucket, Key)] = body
        self.metadata[(Bucket, Key)] = extra.get("Metadata", {})
        self.puts.append({"Bucket": Bucket, "Key": Key, **extra})
        return {}

    # A multipart upload: the parts are joined into the object on complete.
    def create_multipart_upload(self, *, Bucket: str, Key: str, **extra: Any) -> dict[str, Any]:
        assert extra["ChecksumAlgorithm"] == "SHA256"
        self.uploads[(Bucket, Key)] = {"extra": extra, "parts": {}}
        return {"UploadId": "u-1"}

    def upload_part(
        self, *, Bucket: str, Key: str, PartNumber: int, Body: bytes, **extra: Any
    ) -> dict[str, Any]:
        assert extra["ChecksumSHA256"] == base64.b64encode(hashlib.sha256(Body).digest()).decode()
        self.uploads[(Bucket, Key)]["parts"][PartNumber] = Body
        return {"ETag": f"etag-{PartNumber}"}

    def complete_multipart_upload(self, *, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:
        upload = self.uploads.pop((Bucket, Key))
        self.objects[(Bucket, Key)] = b"".join(body for _, body in sorted(upload["parts"].items()))
        self.metadata[(Bucket, Key)] = upload["extra"].get("Metadata", {})
        self.multipart.append({"Bucket": Bucket, "Key": Key, **upload["extra"]})
        return {}

    def abort_multipart_upload(self, **_: Any) -> dict[str, Any]:
        raise AssertionError("no upload fails in these tests")


def _s3(fake: FakeS3) -> zips.S3:
    return cast(zips.S3, fake)


def _sample() -> dict[str, bytes]:
    return {
        str(p.relative_to(SAMPLE)): p.read_bytes() for p in sorted(SAMPLE.rglob("*")) if p.is_file()
    }


@pytest.fixture
def s3() -> FakeS3:
    fake = FakeS3()
    for path, body in _sample().items():
        fake.objects[(BUCKET, ROOT + path)] = body
    return fake


def _manifest() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((SAMPLE / "datapackage.json").read_text())
    return loaded


def _zip(s3: FakeS3, name: str) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(s3.objects[(BUCKET, f"{ROOT}_zips/{name}")]))


def test_without_list_rights_a_missing_zip_is_an_error_not_a_missing_zip(s3: FakeS3) -> None:
    s3.can_list = False

    with pytest.raises(ClientError) as raised:
        zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest())

    assert raised.value.response["Error"]["Code"] == "403"
    assert s3.puts == []


def test_the_version_zip_holds_exactly_the_versions_files_and_their_checksums(s3: FakeS3) -> None:
    zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest())

    archive = _zip(s3, "all/package.zip")
    listed = zips.checksum_lines((SAMPLE / "checksums.sha256").read_text())
    assert sorted(archive.namelist()) == sorted([*listed, "checksums.sha256"])
    assert "datapackage.json" in listed and "README.md" in listed
    assert not any(name.startswith("_build/") for name in archive.namelist())
    for path, digest in listed.items():
        assert hashlib.sha256(archive.read(path)).hexdigest() == digest


def test_a_shapefile_sets_zip_holds_its_four_members(s3: FakeS3) -> None:
    written = zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest())

    assert sorted(written) == [
        f"{ROOT}_zips/all/package.zip",
        f"{ROOT}_zips/depth.zip",
        f"{ROOT}_zips/sites.zip",
    ]
    assert sorted(_zip(s3, "sites.zip").namelist()) == [
        "data/sites/sites.dbf",
        "data/sites/sites.prj",
        "data/sites/sites.shp",
        "data/sites/sites.shx",
    ]


def test_a_zip_within_one_request_is_one_put_with_its_sha256(s3: FakeS3) -> None:
    zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest())

    assert len(s3.puts) == 3
    assert all(put["ContentType"] == "application/zip" for put in s3.puts)


def test_a_zip_over_one_request_is_written_in_parts_with_its_fingerprint(
    s3: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parts, "ONE_REQUEST_MAX", 16)
    monkeypatch.setattr(parts, "PART", 8)

    written = zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest())

    assert s3.puts == [] and len(written) == 3
    key = f"{ROOT}_zips/all/package.zip"
    [upload] = [u for u in s3.multipart if u["Key"] == key]
    assert upload["ContentType"] == "application/zip"
    listed = zips.checksum_lines((SAMPLE / "checksums.sha256").read_text())
    assert sorted(_zip(s3, "all/package.zip").namelist()) == sorted([*listed, "checksums.sha256"])
    hashes = {
        **listed,
        "checksums.sha256": hashlib.sha256(
            s3.objects[(BUCKET, ROOT + "checksums.sha256")]
        ).hexdigest(),
    }
    mark = zips.fingerprint((*sorted(listed), "checksums.sha256"), hashes)
    assert s3.metadata[(BUCKET, key)] == {"members-sha256": mark}
    assert zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest()) == []


def test_a_second_run_writes_nothing_new(s3: FakeS3) -> None:
    zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest())
    first = len(s3.puts)

    assert zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest()) == []
    assert len(s3.puts) == first


def test_a_changed_member_rewrites_only_the_zips_that_hold_it(s3: FakeS3) -> None:
    zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest())
    key = (BUCKET, ROOT + "checksums.sha256")
    s3.objects[key] = s3.objects[key].replace(b"47a42acc", b"00000000")

    written = zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest())

    assert sorted(written) == [f"{ROOT}_zips/all/package.zip", f"{ROOT}_zips/sites.zip"]


def test_a_version_without_checksums_gets_no_zips(s3: FakeS3) -> None:
    del s3.objects[(BUCKET, ROOT + "checksums.sha256")]

    assert zips.write_zips(_s3(s3), BUCKET, ROOT, _manifest()) == []


def test_zip_paths_follow_the_manifest_alone() -> None:
    assert zips.zip_paths(_manifest()) == [
        "_zips/all/package.zip",
        "_zips/sites.zip",
        "_zips/depth.zip",
    ]


def test_a_resource_named_package_keeps_its_own_zip_apart_from_download_all(s3: FakeS3) -> None:
    manifest = _manifest()
    sites = next(r for r in manifest["resources"] if r["name"] == "sites")
    sites["name"] = "package"

    paths = zips.zip_paths(manifest)
    written = zips.write_zips(_s3(s3), BUCKET, ROOT, manifest)

    assert len(set(paths)) == len(paths) == 3
    assert sorted(written) == sorted(ROOT + path for path in paths)
    assert ROOT + "_zips/package.zip" in written
    whole = zipfile.ZipFile(io.BytesIO(s3.objects[(BUCKET, ROOT + "_zips/all/package.zip")]))
    assert "checksums.sha256" in whole.namelist()
    resource = zipfile.ZipFile(io.BytesIO(s3.objects[(BUCKET, ROOT + "_zips/package.zip")]))
    assert "checksums.sha256" not in resource.namelist()
