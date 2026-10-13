"""Assert the same canonical event is queryable in ClickHouse and archived in S3."""

import base64
import json
import os
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import boto3
from botocore.config import Config
from telemetry_sinks.replay import decode_segment


EVENT_ID = "33333333-3333-4333-8333-333333333333"
BUCKET = os.environ["TELEMETRY_ARCHIVE_BUCKET"]
EXPECTED_OBJECTS = int(os.getenv("EXPECTED_ARCHIVE_OBJECTS", "1"))
auth = base64.b64encode(f"{os.environ['CLICKHOUSE_USER']}:{os.environ['CLICKHOUSE_PASSWORD']}".encode()).decode()
query = f"SELECT count() FROM greenguard_analytics.telemetry_events FINAL WHERE event_id = '{EVENT_ID}'"


def clickhouse_count() -> int:
    request = Request(os.environ["CLICKHOUSE_URL"] + "?" + urlencode({"query": query}),
                      headers={"Authorization": "Basic " + auth})
    with urlopen(request, timeout=5) as response:
        return int(response.read().decode().strip())


s3 = boto3.client(
    "s3", region_name=os.environ["AWS_REGION"], endpoint_url=os.environ["S3_ENDPOINT_URL"],
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    config=Config(s3={"addressing_style": "path"}, connect_timeout=3, read_timeout=5),
)
prefix = "telemetry/segments/topic=greenguard.telemetry.recorded.v1/"
deadline = time.monotonic() + 90
objects: list[str] = []
count = 0
last_error: Exception | None = None
while time.monotonic() < deadline:
    try:
        objects = [item["Key"] for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix)
                   for item in page.get("Contents", [])]
        count = clickhouse_count()
    except Exception as exc:
        last_error = exc
        time.sleep(1)
        continue
    if len(objects) == EXPECTED_OBJECTS and count == 1:
        break
    time.sleep(1)
else:
    raise RuntimeError(
        f"pipeline acceptance timed out: ClickHouse rows={count}, archive segments={len(objects)}"
    ) from last_error

event_count = 0
replay_count = 0
for key in objects:
    stored = s3.get_object(Bucket=BUCKET, Key=key, ChecksumMode="ENABLED")
    segment_records = decode_segment(
        key,
        stored["Body"].read(),
        stored.get("Metadata", {}),
        stored.get("ChecksumSHA256"),
    )
    for record in segment_records:
        value = json.loads(base64.b64decode(record["value_base64"], validate=True))
        if value.get("event_id") == EVENT_ID:
            event_count += 1
            if any(item["name"] == "greenguard-replay" for item in record.get("headers", [])):
                replay_count += 1
if event_count != EXPECTED_OBJECTS or replay_count != EXPECTED_OBJECTS - 1:
    raise RuntimeError(f"archive replay receipt mismatch: events={event_count}, replayed={replay_count}")
print(json.dumps({"eventId": EVENT_ID, "clickhouseLogicalRows": 1, "archiveSegments": len(objects),
                  "archivedEvents": event_count, "replayedEvents": replay_count}))
