"""Verify and replay the immutable telemetry segments written by archive.py."""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import re
import sys
from collections.abc import Iterator
from functools import lru_cache

from telemetry_sinks.common import kafka_producer_config


SEGMENT_KEY = re.compile(
    r"^telemetry/segments/topic=(greenguard\.telemetry\.recorded\.v[12])/"
    r"partition=(\d{5})/start-offset=(\d{20})\.jsonl\.gz$"
)
MAX_ARCHIVE_OBJECT_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_DECOMPRESSED_BYTES = 4 * 1024 * 1024


@lru_cache(maxsize=1)
def _validators():
    from telemetry_sinks.contracts import SCHEMA_DIR, _load_validators
    return _load_validators(SCHEMA_DIR)


def _b64(value: object, field: str) -> bytes:
    if not isinstance(value, str):
        raise RuntimeError(f"archive {field} is malformed")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise RuntimeError(f"archive {field} is malformed") from error


def _fallback_headers(value: bytes) -> list[tuple[str, bytes]]:
    try:
        event = json.loads(value)
        if not isinstance(event, dict):
            raise ValueError("event must be an object")
        return [(name, str(event[name]).encode("utf-8")) for name in (
            "event_id", "event_type", "schema_version", "tenant_id", "correlation_id", "traceparent",
        )]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise RuntimeError("archived event cannot supply its required Kafka headers") from error


def _decode_headers(raw_headers: object, value: bytes) -> list[tuple[str, bytes | None]]:
    if raw_headers is None:
        return _fallback_headers(value)
    if not isinstance(raw_headers, list):
        raise RuntimeError("archive headers are malformed")
    headers: list[tuple[str, bytes | None]] = []
    for item in raw_headers:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise RuntimeError("archive headers are malformed")
        name = item["name"]
        is_null = item.get("value_is_null")
        if is_null is True:
            if item.get("value_base64") != "":
                raise RuntimeError("archive headers are malformed")
            header_value = None
        elif is_null is False or "value_is_null" not in item:
            header_value = _b64(item.get("value_base64"), "header value")
        else:
            raise RuntimeError("archive headers are malformed")
        headers.append((name, header_value))
    return headers


def verify_record(record: dict, object_key: str, *, segment: bool = False) -> tuple[str, int, int, bytes, bytes, list[tuple[str, bytes | None]]]:
    key = _b64(record.get("key_base64"), "key")
    value = _b64(record.get("value_base64"), "value")
    if segment:
        digest = hashlib.sha256(value).hexdigest()
        if digest != record.get("event_sha256"):
            raise RuntimeError(f"archive event checksum mismatch in {object_key}")
        topic = record.get("source_topic")
        partition = record.get("source_partition")
        offset = record.get("source_offset")
    else:
        digest = hashlib.sha256(key + b"\0" + value).hexdigest()
        if digest != record.get("sha256"):
            raise RuntimeError(f"archive checksum mismatch in {object_key}")
        header_values = record.get("headers", [])
        header_bytes = json.dumps(header_values, sort_keys=True, separators=(",", ":")).encode()
        if record.get("headers_sha256") is not None and hashlib.sha256(header_bytes).hexdigest() != record["headers_sha256"]:
            raise RuntimeError(f"archive header checksum mismatch in {object_key}")
        topic = record.get("topic")
        partition = record.get("partition")
        offset = record.get("offset")
    if topic not in {"greenguard.telemetry.recorded.v1", "greenguard.telemetry.recorded.v2"}:
        raise RuntimeError(f"archive topic is invalid in {object_key}")
    if type(partition) is not int or partition < 0 or type(offset) is not int or offset < 0:
        raise RuntimeError(f"archive coordinates are invalid in {object_key}")
    headers = _decode_headers(record.get("headers"), value)
    try:
        from telemetry_sinks.contracts import parse_record
        parse_record(topic, key, value, partition, offset, _validators(), headers)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"archived telemetry event fails the canonical contract in {object_key}") from error
    return topic, partition, offset, key, value, headers


def decode_segment(object_key: str, body: bytes, metadata: dict, remote_checksum: str | None = None) -> list[dict]:
    """Verify an S3 segment's path, digest, metadata, and individual source records."""
    if len(body) > MAX_ARCHIVE_OBJECT_BYTES:
        raise RuntimeError(f"archive segment exceeds the compressed size limit: {object_key}")
    match = SEGMENT_KEY.fullmatch(object_key)
    if match is None:
        raise RuntimeError(f"archive segment key is malformed: {object_key}")
    topic_from_key, partition_from_key, first_from_key = match.groups()
    expected_checksum = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
    digest = hashlib.sha256(body).hexdigest()
    if metadata.get("format") != "greenguard-telemetry-archive-v1" or metadata.get("sha256") != digest:
        raise RuntimeError(f"archive segment metadata checksum mismatch in {object_key}")
    if remote_checksum is not None and remote_checksum != expected_checksum:
        raise RuntimeError(f"S3 checksum mismatch in {object_key}")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(body), mode="rb") as zipped:
            decompressed = zipped.read(MAX_ARCHIVE_DECOMPRESSED_BYTES + 1)
        if len(decompressed) > MAX_ARCHIVE_DECOMPRESSED_BYTES:
            raise RuntimeError(f"archive segment exceeds the decompressed size limit: {object_key}")
        lines = decompressed.decode("utf-8").splitlines()
        rows = [json.loads(line) for line in lines if line]
        first = int(metadata["first-offset"])
        last = int(metadata["last-offset"])
        count = int(metadata["record-count"])
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise RuntimeError(f"archive segment contents are malformed in {object_key}") from error
    if not rows or len(rows) != count or first != int(first_from_key) or last < first:
        raise RuntimeError(f"archive segment bounds are inconsistent in {object_key}")
    result = []
    previous = None
    for row in rows:
        if not isinstance(row, dict) or row.get("format_version") != 1:
            raise RuntimeError(f"archive record format is unsupported in {object_key}")
        normalized = {
            "source_topic": row.get("source_topic"),
            "source_partition": row.get("source_partition"),
            "source_offset": row.get("source_offset"),
            "key_base64": row.get("key_base64"),
            "value_base64": row.get("value_base64"),
            "headers": row.get("headers"),
            "event_sha256": row.get("event_sha256"),
        }
        topic, partition, offset, _key, _value, _headers = verify_record(normalized, object_key, segment=True)
        if topic != topic_from_key or partition != int(partition_from_key):
            raise RuntimeError(f"archive segment source does not match its key in {object_key}")
        if previous is not None and offset <= previous:
            raise RuntimeError(f"archive segment offsets are not increasing in {object_key}")
        previous = offset
        result.append(normalized)
    if result[0]["source_offset"] != first or result[-1]["source_offset"] != last:
        raise RuntimeError(f"archive segment offset range mismatch in {object_key}")
    return result


def object_keys(client, bucket: str, prefix: str) -> tuple[str, ...]:
    """Freeze the archive input before publishing can create replayed objects."""
    keys = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            keys.append(item["Key"])
    return tuple(keys)


def records(client, bucket: str, keys: tuple[str, ...]) -> Iterator[tuple[str, dict, bool]]:
    """Download and verify each frozen S3 object exactly once."""
    for object_key in keys:
        obj = client.get_object(Bucket=bucket, Key=object_key, ChecksumMode="ENABLED")
        content_length = obj.get("ContentLength")
        if content_length is not None and content_length > MAX_ARCHIVE_OBJECT_BYTES:
            raise RuntimeError(f"archive object exceeds the compressed size limit: {object_key}")
        body = obj["Body"].read(MAX_ARCHIVE_OBJECT_BYTES + 1)
        if len(body) > MAX_ARCHIVE_OBJECT_BYTES:
            raise RuntimeError(f"archive object exceeds the compressed size limit: {object_key}")
        if object_key.endswith(".jsonl.gz"):
            for record in decode_segment(object_key, body, obj.get("Metadata", {}), obj.get("ChecksumSHA256")):
                yield object_key, record, True
        else:
            try:
                yield object_key, json.loads(body), False
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise RuntimeError(f"legacy archive object is malformed: {object_key}") from error


def _has_replay_marker(headers: list[tuple[str, bytes | None]]) -> bool:
    markers = [value for name, value in headers if name == "greenguard-replay"]
    if not markers:
        return False
    if len(markers) != 1 or markers[0] != b"v1":
        raise RuntimeError("archive replay marker is malformed")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay archived canonical telemetry to Kafka")
    parser.add_argument("--prefix", help="S3 prefix (defaults to the selected topic's segment directory)")
    parser.add_argument("--topic", choices=("greenguard.telemetry.recorded.v1", "greenguard.telemetry.recorded.v2"), required=True)
    parser.add_argument("--confirm", action="store_true", help="actually publish; without this the command only counts")
    args = parser.parse_args()
    prefix = (args.prefix or f"telemetry/segments/topic={args.topic}/").strip("/")
    allowed_prefixes = (f"telemetry/segments/topic={args.topic}", f"telemetry/{args.topic}")
    if not any(prefix == item or prefix.startswith(item + "/") for item in allowed_prefixes) or ".." in prefix.split("/"):
        raise ValueError("replay prefix must be scoped to the selected telemetry topic")
    bucket = os.environ["TELEMETRY_ARCHIVE_BUCKET"]
    s3_options = {"region_name": os.environ.get("AWS_REGION")}
    if os.getenv("S3_ENDPOINT_URL"):
        from botocore.config import Config
        s3_options.update({"endpoint_url": os.environ["S3_ENDPOINT_URL"], "aws_access_key_id": os.getenv("AWS_ACCESS_KEY_ID"),
                           "aws_secret_access_key": os.getenv("AWS_SECRET_ACCESS_KEY"),
                           "config": Config(s3={"addressing_style": "path"})})
    import boto3
    client = boto3.client("s3", **s3_options)

    # Freeze the object keys before producing. This avoids downloading the whole
    # archive twice and prevents objects created by this replay from extending
    # its own input set.
    input_keys = object_keys(client, bucket, prefix)

    producer = None
    if args.confirm:
        from confluent_kafka import Producer
        producer = Producer(kafka_producer_config("greenguard-telemetry-replay"))
    total = 0
    skipped_replayed = 0
    skipped_other_topic = 0
    for object_key, record, is_segment in records(client, bucket, input_keys):
        if is_segment:
            topic, partition, offset, key, value, headers = verify_record(record, object_key, segment=True)
        else:
            topic, partition, offset, key, value, headers = verify_record(record, object_key)
        if topic != args.topic:
            skipped_other_topic += 1
            continue
        if _has_replay_marker(headers):
            skipped_replayed += 1
            continue
        if producer is not None:
            headers.append(("greenguard-replay", b"v1"))
            producer.produce(topic, key=key, value=value, headers=headers)
            producer.poll(0)
        total += 1
    if producer is not None:
        remaining = producer.flush(60)
        if remaining:
            raise RuntimeError(f"Kafka replay left {remaining} records undelivered")
    mode = "published" if args.confirm else "dry-run; pass --confirm to publish"
    print(json.dumps({
        "objects": total,
        "skipped_replayed": skipped_replayed,
        "skipped_other_topic": skipped_other_topic,
        "mode": mode,
        "topic": args.topic,
        "prefix": prefix,
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        detail = str(error) if type(error) in (RuntimeError, ValueError) else type(error).__name__
        print(f"archive replay failed: {detail}", file=sys.stderr)
        sys.exit(1)
