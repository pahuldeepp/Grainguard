from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
from collections.abc import Iterator

import boto3
from botocore.config import Config
from confluent_kafka import Producer

from telemetry_sinks.common import kafka_producer_config


def records(client, bucket: str, prefix: str) -> Iterator[tuple[str, dict]]:
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            obj = client.get_object(Bucket=bucket, Key=item["Key"])
            yield item["Key"], json.loads(obj["Body"].read())


def verify_record(record: dict, object_key: str) -> tuple[bytes, bytes, list[tuple[str, bytes]]]:
    key = base64.b64decode(record["key_base64"], validate=True)
    value = base64.b64decode(record["value_base64"], validate=True)
    if hashlib.sha256(key + b"\0" + value).hexdigest() != record.get("sha256"):
        raise RuntimeError(f"archive checksum mismatch in {object_key}")
    header_values = record.get("headers", [])
    header_bytes = json.dumps(header_values, sort_keys=True, separators=(",", ":")).encode()
    if hashlib.sha256(header_bytes).hexdigest() != record.get("headers_sha256"):
        # Empty-header objects written before header checksums were introduced
        # remain replayable; non-empty headers are always checksum validated.
        if header_values or record.get("headers_sha256") is not None:
            raise RuntimeError(f"archive headers checksum mismatch in {object_key}")
    headers = [(entry["name"], base64.b64decode(entry["value_base64"], validate=True))
               for entry in header_values]
    return key, value, headers


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay archived canonical telemetry to Kafka")
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--topic", choices=("greenguard.telemetry.recorded.v1", "greenguard.telemetry.recorded.v2"), required=True)
    parser.add_argument("--confirm", action="store_true", help="actually publish; without this the command only counts")
    args = parser.parse_args()
    expected_prefix = f"telemetry/{args.topic}/"
    if not args.prefix.startswith(expected_prefix):
        raise ValueError(f"replay prefix must be under {expected_prefix}")
    bucket = os.environ["TELEMETRY_ARCHIVE_BUCKET"]
    s3_options = {"region_name": os.environ.get("AWS_REGION")}
    if os.getenv("S3_ENDPOINT_URL"):
        s3_options.update({"endpoint_url": os.environ["S3_ENDPOINT_URL"], "aws_access_key_id": os.getenv("AWS_ACCESS_KEY_ID"),
                           "aws_secret_access_key": os.getenv("AWS_SECRET_ACCESS_KEY"),
                           "config": Config(s3={"addressing_style": "path"})})
    client = boto3.client("s3", **s3_options)
    # Snapshot each source partition's high-water offset before publishing. The
    # archive consumer may be running at the same time and must not extend this
    # replay's input set with live traffic or messages emitted by this replay.
    high_water: dict[int, int] = {}
    for object_key, record in records(client, bucket, args.prefix):
        if record.get("topic") != args.topic:
            continue
        _, _, headers = verify_record(record, object_key)
        if any(name == "greenguard-replay" for name, _ in headers):
            continue
        partition, offset = int(record["partition"]), int(record["offset"])
        high_water[partition] = max(high_water.get(partition, -1), offset)

    producer = Producer(kafka_producer_config("greenguard-telemetry-replay")) if args.confirm else None
    total = 0
    for object_key, record in records(client, bucket, args.prefix):
        if record.get("topic") != args.topic:
            continue
        partition, offset = int(record["partition"]), int(record["offset"])
        if offset > high_water.get(partition, -1):
            continue
        key, value, headers = verify_record(record, object_key)
        if any(name == "greenguard-replay" for name, _ in headers):
            continue
        if producer is not None:
            headers.append(("greenguard-replay", b"v1"))
            producer.produce(args.topic, key=key or None, value=value, headers=headers)
            producer.poll(0)
        total += 1
    if producer is not None:
        remaining = producer.flush(60)
        if remaining:
            raise RuntimeError(f"Kafka replay left {remaining} records undelivered")
    mode = "published" if args.confirm else "dry-run; pass --confirm to publish"
    print(json.dumps({"objects": total, "mode": mode, "topic": args.topic, "prefix": args.prefix}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
