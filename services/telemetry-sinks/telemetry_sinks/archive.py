"""Immutable S3 telemetry segments keyed by the first Kafka source offset."""

from __future__ import annotations

from dataclasses import dataclass
import base64
import gzip
import hashlib
import io
import json
import re
from typing import Any

from .contracts import TelemetryRecord


_TOPIC = re.compile(r"^greenguard\.telemetry\.recorded\.v[12]$")


class ArchiveError(RuntimeError):
    """The durable archive operation failed; the Kafka offset must stay uncommitted."""


@dataclass(frozen=True)
class ArchiveResult:
    commit_next_offset: int | None
    consumed_count: int
    wait_until_offset: int | None = None


class S3ArchiveSink:
    """Commit only after an immutable batch object is durable in S3.

    The object key is the first source offset for a topic partition. If an
    upload succeeds but the Kafka commit does not, restart sees the same key,
    verifies its signed-by-S3 checksum metadata and advances through its last
    offset without writing a second segment. This uses Kafka's committed offset
    as the checkpoint and avoids a mutable S3 manifest/version per batch.
    """

    def __init__(self, client: Any, bucket: str, prefix: str = "telemetry"):
        if not bucket or prefix.strip("/") != "telemetry":
            raise ValueError("the telemetry archive requires its dedicated bucket and telemetry prefix")
        self.client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def check(self) -> None:
        self.client.head_bucket(Bucket=self.bucket)

    def write_batch(self, records: tuple[TelemetryRecord, ...]) -> ArchiveResult:
        _validate_batch(records)
        first = records[0]
        key = self._segment_key(first.topic, first.partition, first.offset)
        existing = self._head_segment(key, first.topic, first.partition, first.offset)
        if existing is not None:
            return self._recover(records, existing)

        body = _encode_segment(records)
        digest = hashlib.sha256(body).hexdigest()
        checksum = base64.b64encode(bytes.fromhex(digest)).decode("ascii")
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=body,
                ContentType="application/x-ndjson",
                ContentEncoding="gzip",
                ChecksumAlgorithm="SHA256",
                ChecksumSHA256=checksum,
                Metadata={
                    "first-offset": str(records[0].offset),
                    "last-offset": str(records[-1].offset),
                    "record-count": str(len(records)),
                    "sha256": digest,
                    "format": "greenguard-telemetry-archive-v1",
                },
                IfNoneMatch="*",
            )
        except Exception as error:
            if _error_code(error) not in {"PreconditionFailed", "412", "ConditionalRequestConflict", "409"}:
                raise ArchiveError("S3 telemetry segment write failed") from error
            # Rebalance overlap or a crash-replay won the conditional create.
            existing = self._head_segment(key, first.topic, first.partition, first.offset)
            if existing is None:
                raise ArchiveError("S3 segment write conflicted but no durable segment exists") from error
            return self._recover(records, existing)
        return ArchiveResult(records[-1].offset + 1, len(records))

    def _segment_key(self, topic: str, partition: int, first_offset: int) -> str:
        return f"{self.prefix}/segments/topic={topic}/partition={partition:05d}/start-offset={first_offset:020d}.jsonl.gz"

    def _head_segment(self, key: str, topic: str, partition: int, expected_start: int) -> tuple[int, str, int] | None:
        try:
            result = self.client.head_object(Bucket=self.bucket, Key=key, ChecksumMode="ENABLED")
        except Exception as error:
            if _error_code(error) in {"NoSuchKey", "404", "NotFound"}:
                return None
            raise ArchiveError("S3 telemetry segment lookup failed") from error
        try:
            metadata = result["Metadata"]
            first = int(metadata["first-offset"])
            end = int(metadata["last-offset"])
            count = int(metadata["record-count"])
            digest = metadata["sha256"]
            if (first != expected_start or end < first or count < 1 or
                    not re.fullmatch(r"[a-f0-9]{64}", digest) or
                    metadata.get("format") != "greenguard-telemetry-archive-v1"):
                raise ValueError("segment metadata mismatch")
            checksum = base64.b64encode(bytes.fromhex(digest)).decode("ascii")
            if result.get("ChecksumSHA256") != checksum:
                raise ValueError("segment checksum does not match immutable metadata")
            if key != self._segment_key(topic, partition, expected_start):
                raise ValueError("segment key does not match source coordinates")
            return end, digest, count
        except (KeyError, TypeError, ValueError) as error:
            raise ArchiveError("S3 telemetry segment metadata is malformed") from error

    @staticmethod
    def _recover(records: tuple[TelemetryRecord, ...], existing: tuple[int, str, int]) -> ArchiveResult:
        end_offset, _digest, record_count = existing
        end_index = next((index for index, item in enumerate(records) if item.offset == end_offset), None)
        if end_index is None:
            return ArchiveResult(None, 0, wait_until_offset=end_offset)
        if end_index + 1 != record_count:
            raise ArchiveError("existing archive segment record count does not match replayed offsets")
        return ArchiveResult(end_offset + 1, end_index + 1)


def _encode_segment(records: tuple[TelemetryRecord, ...]) -> bytes:
    lines = []
    for item in records:
        wrapped = {
            "format_version": 1,
            "source_topic": item.topic,
            "source_partition": item.partition,
            "source_offset": item.offset,
            "key_base64": base64.b64encode(item.raw_key).decode("ascii"),
            "value_base64": base64.b64encode(item.raw_value).decode("ascii"),
            "headers": [
                {
                    "name": name,
                    "value_base64": base64.b64encode(value or b"").decode("ascii"),
                    "value_is_null": value is None,
                }
                for name, value in item.headers
            ],
            "event_sha256": item.event_sha256,
        }
        lines.append(json.dumps(wrapped, sort_keys=True, separators=(",", ":")))
    data = ("\n".join(lines) + "\n").encode("utf-8")
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0, compresslevel=6) as zipped:
        zipped.write(data)
    return buffer.getvalue()


def _validate_batch(records: tuple[TelemetryRecord, ...]) -> None:
    if not records:
        raise ValueError("S3 archive batch cannot be empty")
    topic, partition = records[0].topic, records[0].partition
    if not _TOPIC.fullmatch(topic) or type(partition) is not int or partition < 0:
        raise ValueError("S3 archive batch source is invalid")
    if any(item.topic != topic or item.partition != partition for item in records):
        raise ValueError("S3 archive batches must contain one topic partition")
    if any(right.offset <= left.offset for left, right in zip(records, records[1:])):
        raise ValueError("S3 archive batch offsets must be strictly increasing")


def _error_code(error: Exception) -> str | None:
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        return str(response.get("Error", {}).get("Code", "")) or str(response.get("ResponseMetadata", {}).get("HTTPStatusCode", ""))
    return None
