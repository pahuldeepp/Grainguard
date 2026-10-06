"""ClickHouse HTTP sink with deterministic, retry-safe source block identities."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from .contracts import TelemetryRecord


TABLE = "greenguard_analytics.telemetry_events"
COLUMNS = (
    "event_id", "tenant_id", "site_id", "bin_id", "device_id", "reading_id",
    "schema_version", "observed_at", "received_at", "temperature_c",
    "relative_humidity_percent", "co2_ppm", "grain_moisture_percent",
    "source_topic", "source_partition", "source_offset", "event_sha256", "event_json",
)


class ClickHouseError(RuntimeError):
    """ClickHouse did not confirm a query."""


class ClickHouseSink:
    def __init__(self, endpoint: str, username: str, password: str, timeout_seconds: float = 10):
        parsed = urlsplit(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("CLICKHOUSE_URL must be an HTTP(S) endpoint without credentials or query")
        if not username or not password:
            raise ValueError("ClickHouse credentials are required")
        self.endpoint = urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
        self.auth = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        self.timeout_seconds = timeout_seconds

    def check(self) -> None:
        self._request("SELECT 1", b"", expect_body=b"1")

    def write_batch(self, records: Iterable[TelemetryRecord]) -> int:
        batch = tuple(records)
        if not batch:
            return 0
        _validate_batch(batch)
        token_hash = hashlib.sha256()
        lines = []
        for item in batch:
            token_hash.update(f"{item.topic}\0{item.partition}\0{item.offset}\0{item.event_sha256}\n".encode())
            lines.append(json.dumps(_row(item), sort_keys=True, separators=(",", ":"), allow_nan=False))
        token = token_hash.hexdigest()
        column_sql = ",".join(COLUMNS)
        query = (
            f"INSERT INTO {TABLE} ({column_sql}) "
            f"SETTINGS async_insert=1, wait_for_async_insert=1, insert_deduplicate=1, "
            f"insert_deduplication_token='{token}' FORMAT JSONEachRow"
        )
        self._request(query, ("\n".join(lines) + "\n").encode("utf-8"))
        return len(batch)

    def _request(self, query: str, body: bytes, expect_body: bytes | None = None) -> None:
        url = self.endpoint + "?" + urlencode({"query": query})
        request = Request(url, data=body, method="POST", headers={
            "Authorization": "Basic " + self.auth,
            "Content-Type": "application/x-ndjson",
            "Accept": "text/plain",
        })
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                response_body = response.read(64 * 1024 + 1)
                if len(response_body) > 64 * 1024 or response.status < 200 or response.status >= 300:
                    raise ClickHouseError("ClickHouse returned an invalid response")
        except HTTPError as error:
            # Do not echo server messages; ClickHouse errors can include query text/data.
            raise ClickHouseError(f"ClickHouse returned HTTP {error.code}") from None
        except (URLError, TimeoutError, OSError) as error:
            raise ClickHouseError("ClickHouse request failed") from error
        if expect_body is not None and response_body.strip() != expect_body:
            raise ClickHouseError("ClickHouse health query returned an unexpected result")


def _row(record: TelemetryRecord) -> dict:
    event = record.event
    payload = event["payload"]
    measurements = payload.get("measurements", {})
    if not measurements and isinstance(payload.get("sensor_observations"), list):
        # Keep v2 sensor-level values losslessly in event_json. The current analytics
        # schema has one row per reading, so only device-level aggregates populate
        # the typed columns.
        measurements = {}
    return {
        "event_id": event["event_id"],
        "tenant_id": event["tenant_id"],
        "site_id": payload["site_id"],
        "bin_id": payload["bin_id"],
        "device_id": payload["device_id"],
        "reading_id": payload["reading_id"],
        "schema_version": event["schema_version"],
        "observed_at": payload["observed_at"],
        "received_at": payload["received_at"],
        "temperature_c": measurements.get("temperature_c"),
        "relative_humidity_percent": measurements.get("relative_humidity_percent"),
        "co2_ppm": measurements.get("co2_ppm"),
        "grain_moisture_percent": measurements.get("grain_moisture_percent"),
        "source_topic": record.topic,
        "source_partition": record.partition,
        "source_offset": record.offset,
        "event_sha256": record.event_sha256,
        "event_json": record.canonical_json,
    }


def _validate_batch(batch: tuple[TelemetryRecord, ...]) -> None:
    topic, partition = batch[0].topic, batch[0].partition
    if any(item.topic != topic or item.partition != partition for item in batch):
        raise ValueError("ClickHouse batches must contain one topic partition")
    if any(right.offset <= left.offset for left, right in zip(batch, batch[1:])):
        raise ValueError("ClickHouse batch offsets must be strictly increasing")
    identities: dict[tuple[str, str], str] = {}
    for record in batch:
        event = record.event
        key = (event["tenant_id"], event["event_id"])
        previous = identities.setdefault(key, record.event_sha256)
        if previous != record.event_sha256:
            raise ValueError("one event identity has conflicting payloads")
