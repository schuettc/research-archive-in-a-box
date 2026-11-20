import base64
import hashlib
import io
from typing import Any, cast

import pytest

from archive_backend import parts

BUCKET = "archive"


def _sha(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


class FakeS3:
    """Records multipart calls and joins the parts into the object on complete."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.heads: dict[str, dict[str, Any]] = {}
        self.started: list[dict[str, Any]] = []
        self.sent: list[dict[str, Any]] = []
        self.ranges: list[str] = []
        self.sources: list[dict[str, str]] = []
        self.headed: list[tuple[str, str]] = []
        self.completed: list[dict[str, Any]] = []
        self.aborted: list[dict[str, Any]] = []
        self.fail_part: int | None = None
        self._parts: dict[int, bytes] = {}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.headed.append((Bucket, Key))
        return self.heads[Key]

    def create_multipart_upload(self, **kwargs: Any) -> dict[str, Any]:
        self.started.append(kwargs)
        return {"UploadId": "u-1"}

    def _part(self, number: int, data: bytes) -> dict[str, str]:
        if number == self.fail_part:
            raise RuntimeError("part refused")
        self._parts[number] = data
        return {"ETag": f"etag-{number}", "ChecksumSHA256": _sha(data)}

    def upload_part(self, *, PartNumber: int, Body: bytes, **kwargs: Any) -> dict[str, Any]:
        assert kwargs["UploadId"] == "u-1"
        self.sent.append({"PartNumber": PartNumber, "Body": Body, **kwargs})
        return self._part(PartNumber, Body)

    def upload_part_copy(
        self, *, PartNumber: int, CopySource: dict[str, str], CopySourceRange: str, **kwargs: Any
    ) -> dict[str, Any]:
        assert kwargs["UploadId"] == "u-1"
        self.ranges.append(CopySourceRange)
        self.sources.append(CopySource)
        first, last = (int(n) for n in CopySourceRange.removeprefix("bytes=").split("-"))
        data = self.objects[CopySource["Key"]][first : last + 1]
        return {"CopyPartResult": self._part(PartNumber, data)}

    def complete_multipart_upload(self, **kwargs: Any) -> dict[str, Any]:
        self.completed.append(kwargs)
        numbers = [p["PartNumber"] for p in kwargs["MultipartUpload"]["Parts"]]
        assert numbers == sorted(self._parts)
        self.objects[kwargs["Key"]] = b"".join(self._parts[n] for n in numbers)
        return {}

    def abort_multipart_upload(self, **kwargs: Any) -> dict[str, Any]:
        self.aborted.append(kwargs)
        return {}


def test_upload_sends_the_stream_in_parts_each_with_its_sha256(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parts, "PART", 4)
    s3 = FakeS3()

    parts.upload(
        cast(parts.S3, s3),
        BUCKET,
        "k.zip",
        io.BytesIO(b"0123456789"),
        content_type="application/zip",
        metadata={"members-sha256": "abc"},
    )

    assert [(p["PartNumber"], p["Body"], p["ChecksumSHA256"]) for p in s3.sent] == [
        (1, b"0123", _sha(b"0123")),
        (2, b"4567", _sha(b"4567")),
        (3, b"89", _sha(b"89")),
    ]
    assert s3.objects["k.zip"] == b"0123456789"
    assert s3.started == [
        {
            "Bucket": BUCKET,
            "Key": "k.zip",
            "ChecksumAlgorithm": "SHA256",
            "ContentType": "application/zip",
            "Metadata": {"members-sha256": "abc"},
        }
    ]
    [done] = s3.completed
    assert done["MultipartUpload"]["Parts"] == [
        {"PartNumber": 1, "ETag": "etag-1", "ChecksumSHA256": _sha(b"0123")},
        {"PartNumber": 2, "ETag": "etag-2", "ChecksumSHA256": _sha(b"4567")},
        {"PartNumber": 3, "ETag": "etag-3", "ChecksumSHA256": _sha(b"89")},
    ]
    assert s3.aborted == []


def test_a_failed_part_aborts_the_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(parts, "PART", 4)
    s3 = FakeS3()
    s3.fail_part = 2

    with pytest.raises(RuntimeError, match="part refused"):
        parts.upload(
            cast(parts.S3, s3),
            BUCKET,
            "k.zip",
            io.BytesIO(b"0123456789"),
            content_type="application/zip",
            metadata={},
        )

    assert s3.aborted == [{"Bucket": BUCKET, "Key": "k.zip", "UploadId": "u-1"}]
    assert s3.completed == [] and "k.zip" not in s3.objects


def test_copy_carries_the_sources_type_and_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(parts, "PART", 4)
    s3 = FakeS3()
    s3.objects["from.zip"] = b"0123456789"
    s3.heads["from.zip"] = {"ContentType": "application/zip", "Metadata": {"members-sha256": "abc"}}

    parts.copy(cast(parts.S3, s3), BUCKET, "from.zip", "to.zip", 10)

    assert s3.ranges == ["bytes=0-3", "bytes=4-7", "bytes=8-9"]
    assert s3.objects["to.zip"] == b"0123456789"
    assert (s3.started[0]["ContentType"], s3.started[0]["Metadata"]) == (
        "application/zip",
        {"members-sha256": "abc"},
    )
    assert s3.started[0]["Key"] == "to.zip"
    assert s3.aborted == []
    assert s3.sources == [{"Bucket": BUCKET, "Key": "from.zip"}] * 3


def test_copy_reads_from_another_bucket_when_one_is_named(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(parts, "PART", 4)
    s3 = FakeS3()
    s3.objects["from.zip"] = b"0123456789"
    s3.heads["from.zip"] = {"ContentType": "application/zip", "Metadata": {"members-sha256": "abc"}}

    parts.copy(cast(parts.S3, s3), BUCKET, "from.zip", "to.zip", 10, source_bucket="staging")

    assert s3.headed == [("staging", "from.zip")]
    assert s3.sources == [{"Bucket": "staging", "Key": "from.zip"}] * 3
    assert (s3.started[0]["Bucket"], s3.started[0]["Metadata"]) == (
        BUCKET,
        {"members-sha256": "abc"},
    )
    assert s3.objects["to.zip"] == b"0123456789"
    assert [done["Bucket"] for done in s3.completed] == [BUCKET]
