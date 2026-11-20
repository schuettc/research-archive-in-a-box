"""An object larger than one S3 request takes, written or copied as a multipart upload.

One PUT and one CopyObject each take at most 5 GiB. `upload` sends a stream in parts, each with
its own SHA-256, which S3 verifies; `copy` copies an object by ranges, within a bucket or from
another. Either way the object's stored checksum is a composite of its parts'
(`<base64>-<parts>`), not the SHA-256 of the whole object. An upload that fails is aborted, so
its parts are not kept.
"""

from __future__ import annotations

import base64
import hashlib
from typing import IO, Any, Protocol

ONE_REQUEST_MAX = 5 * 1024**3  # the most S3 takes in one PUT or one CopyObject
PART = 64 * 1024**2


class S3(Protocol):
    def head_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def create_multipart_upload(self, **kwargs: Any) -> dict[str, Any]: ...
    def upload_part(self, **kwargs: Any) -> dict[str, Any]: ...
    def upload_part_copy(self, **kwargs: Any) -> dict[str, Any]: ...
    def complete_multipart_upload(self, **kwargs: Any) -> Any: ...
    def abort_multipart_upload(self, **kwargs: Any) -> Any: ...


def _finish(s3: S3, bucket: str, key: str, upload_id: str, done: list[dict[str, Any]]) -> None:
    s3.complete_multipart_upload(
        Bucket=bucket, Key=key, UploadId=upload_id, MultipartUpload={"Parts": done}
    )


def upload(
    s3: S3,
    bucket: str,
    key: str,
    stream: IO[bytes],
    *,
    content_type: str,
    metadata: dict[str, str],
) -> None:
    """Write `stream`, from where it stands to its end, to `key` in `PART`-sized parts."""
    upload_id = s3.create_multipart_upload(
        Bucket=bucket,
        Key=key,
        ChecksumAlgorithm="SHA256",
        ContentType=content_type,
        Metadata=metadata,
    )["UploadId"]
    try:
        done: list[dict[str, Any]] = []
        while piece := stream.read(PART):
            number = len(done) + 1
            checksum = base64.b64encode(hashlib.sha256(piece).digest()).decode("ascii")
            sent = s3.upload_part(
                Bucket=bucket,
                Key=key,
                UploadId=upload_id,
                PartNumber=number,
                Body=piece,
                ChecksumSHA256=checksum,
            )
            done.append({"PartNumber": number, "ETag": sent["ETag"], "ChecksumSHA256": checksum})
        _finish(s3, bucket, key, upload_id, done)
    except BaseException:
        s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
        raise


def copy(
    s3: S3, bucket: str, source: str, target: str, size: int, *, source_bucket: str | None = None
) -> None:
    """Copy the `size` bytes of `source` to `target` in `bucket`, in `PART`-sized ranges, with
    the source's content type and metadata. The source is in the same bucket unless
    `source_bucket` names another."""
    source_bucket = source_bucket or bucket
    head = s3.head_object(Bucket=source_bucket, Key=source)
    start: dict[str, Any] = {"Bucket": bucket, "Key": target, "ChecksumAlgorithm": "SHA256"}
    if head.get("ContentType"):
        start["ContentType"] = head["ContentType"]
    if head.get("Metadata"):
        start["Metadata"] = head["Metadata"]
    upload_id = s3.create_multipart_upload(**start)["UploadId"]
    try:
        done: list[dict[str, Any]] = []
        for first in range(0, size, PART):
            number = len(done) + 1
            copied = s3.upload_part_copy(
                Bucket=bucket,
                Key=target,
                UploadId=upload_id,
                PartNumber=number,
                CopySource={"Bucket": source_bucket, "Key": source},
                CopySourceRange=f"bytes={first}-{min(first + PART, size) - 1}",
            )["CopyPartResult"]
            part = {"PartNumber": number, "ETag": copied["ETag"]}
            if copied.get("ChecksumSHA256"):
                part["ChecksumSHA256"] = copied["ChecksumSHA256"]
            done.append(part)
        _finish(s3, bucket, target, upload_id, done)
    except BaseException:
        s3.abort_multipart_upload(Bucket=bucket, Key=target, UploadId=upload_id)
        raise
