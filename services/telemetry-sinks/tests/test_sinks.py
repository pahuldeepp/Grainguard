import base64
import gzip
import hashlib
import json
import sys
import threading
import os
import ssl
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services/telemetry-sinks"))

from telemetry_sinks.archive import ArchiveError, S3ArchiveSink
from telemetry_sinks.clickhouse import ClickHouseSink
from telemetry_sinks.contracts import InvalidTelemetryEvent, SCHEMA_DIR, TOPICS, _load_validators, parse_record
from telemetry_sinks.health import HealthState, start_health_server
from telemetry_sinks import runtime


TENANT = "11111111-1111-4111-8111-111111111111"
DEVICE = "22222222-2222-4222-8222-222222222222"
EVENT = "33333333-3333-4333-8333-333333333333"
READING = "44444444-4444-4444-8444-444444444444"
SITE = "55555555-5555-4555-8555-555555555555"
BIN = "66666666-6666-4666-8666-666666666666"
TRACE = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"


def event(version=1):
    payload = {
        "reading_id": READING, "device_id": DEVICE, "site_id": SITE, "bin_id": BIN,
        "binding_version": "1", "source_message_id": "sensor-1", "observed_at": "2026-10-01T12:00:00Z",
        "received_at": "2026-10-01T12:00:01Z", "measurements": {"temperature_c": 21.5},
    }
    if version == 2:
        payload["measurement_units"] = {"temperature_c": "Cel"}
    return {
        "event_id": EVENT, "event_type": "telemetry.recorded", "schema_version": version,
        "occurred_at": "2026-10-01T12:00:02Z", "tenant_id": TENANT,
        "aggregate_type": "device_telemetry_stream", "aggregate_id": DEVICE, "aggregate_version": "1",
        "correlation_id": EVENT, "causation_id": EVENT, "traceparent": TRACE, "payload": payload,
    }


def record(version=1, offset=7):
    value = json.dumps(event(version), separators=(",", ":")).encode()
    return parse_record(f"greenguard.telemetry.recorded.v{version}", f"{TENANT}:{DEVICE}".encode(), value,
                        0, offset, _load_validators(SCHEMA_DIR))


class ContractTests(unittest.TestCase):
    def test_accepts_v1_and_v2_and_preserves_canonical_event(self):
        for version in (1, 2):
            parsed = record(version)
            self.assertEqual(parsed.event["schema_version"], version)
            self.assertEqual(json.loads(parsed.canonical_json), event(version))
            self.assertEqual(len(parsed.event_sha256), 64)

    def test_rejects_bad_topic_version_key_duplicate_and_nonfinite_json(self):
        validators = _load_validators(SCHEMA_DIR)
        value = json.dumps(event()).encode()
        cases = [
            ("unknown", f"{TENANT}:{DEVICE}".encode(), value),
            ("greenguard.telemetry.recorded.v2", f"{TENANT}:{DEVICE}".encode(), value),
            ("greenguard.telemetry.recorded.v1", b"wrong", value),
            ("greenguard.telemetry.recorded.v1", f"{TENANT}:{DEVICE}".encode(), b'{"x":1,"x":2}'),
            ("greenguard.telemetry.recorded.v1", f"{TENANT}:{DEVICE}".encode(), b'{"x":NaN}'),
        ]
        for topic, key, body in cases:
            with self.subTest(topic=topic, body=body[:15]), self.assertRaises(InvalidTelemetryEvent):
                parse_record(topic, key, body, 0, 1, validators)

    def test_rejects_zero_trace_and_bigint_overflow(self):
        validators = _load_validators(SCHEMA_DIR)
        for mutate in (
            lambda value: value.update(traceparent="00-00000000000000000000000000000000-0123456789abcdef-01"),
            lambda value: value.update(aggregate_version="9223372036854775808"),
        ):
            payload = event()
            mutate(payload)
            with self.assertRaises(InvalidTelemetryEvent):
                parse_record(TOPICS.keys().__iter__().__next__(), f"{TENANT}:{DEVICE}".encode(),
                             json.dumps(payload).encode(), 0, 1, validators)

    def test_rejects_invalid_source_coordinates_and_oversized_payload(self):
        validators = _load_validators(SCHEMA_DIR)
        value = json.dumps(event()).encode()
        key = f"{TENANT}:{DEVICE}".encode()
        for partition, offset, body in ((-1, 1, value), (0, -1, value), (0, 1, b" " * (1024 * 1024 + 1))):
            with self.assertRaises(InvalidTelemetryEvent):
                parse_record("greenguard.telemetry.recorded.v1", key, body, partition, offset, validators)


class ClickHouseTests(unittest.TestCase):
    def test_inserts_json_rows_with_deterministic_token_and_auth(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                seen.append((self.path, self.headers.get("Authorization"), body))
                self.send_response(200)
                self.end_headers()
                if "SELECT+1" in self.path:
                    self.wfile.write(b"1\n")

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            sink = ClickHouseSink(f"http://127.0.0.1:{server.server_port}/", "reader", "secret")
            sink.check()
            item = record()
            self.assertEqual(sink.write_batch((item,)), 1)
            self.assertEqual(seen[0][1], "Basic " + base64.b64encode(b"reader:secret").decode())
            self.assertIn("insert_deduplication_token%3D", seen[1][0])
            inserted = json.loads(seen[1][2])
            self.assertEqual(inserted["event_json"], item.canonical_json)
            self.assertEqual(inserted["source_offset"], item.offset)
        finally:
            server.shutdown()
            server.server_close()

    def test_rejects_conflicting_duplicate_event_and_credentials_in_url(self):
        first = record(offset=2)
        different = dict(event())
        different["payload"] = dict(different["payload"], measurements={"temperature_c": 22})
        other = parse_record(first.topic, first.raw_key, json.dumps(different).encode(), 0, 3,
                             _load_validators(SCHEMA_DIR))
        sink = ClickHouseSink("http://localhost:8123", "u", "p")
        with self.assertRaises(ValueError):
            sink.write_batch((first, other))
        with self.assertRaises(ValueError):
            ClickHouseSink("http://user:pass@localhost:8123", "u", "p")


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.puts = 0

    def head_bucket(self, **_kwargs):
        return {}

    def put_object(self, **kwargs):
        key = kwargs["Key"]
        if key in self.objects:
            raise FakeS3Error("PreconditionFailed", 412)
        self.puts += 1
        self.objects[key] = (kwargs["Body"], kwargs["Metadata"], kwargs["ChecksumSHA256"])
        return {}

    def head_object(self, **kwargs):
        try:
            body, metadata, checksum = self.objects[kwargs["Key"]]
        except KeyError as error:
            raise FakeS3Error("NoSuchKey", 404) from error
        return {"Metadata": metadata, "ChecksumSHA256": checksum, "ContentLength": len(body)}


class FakeS3Error(Exception):
    def __init__(self, code, status):
        self.response = {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}


class ArchiveTests(unittest.TestCase):
    def test_archives_exact_source_bytes_and_replays_without_second_object(self):
        client = FakeS3()
        sink = S3ArchiveSink(client, "gg-telemetry")
        item = record()
        first = sink.write_batch((item,))
        self.assertEqual(first.commit_next_offset, item.offset + 1)
        self.assertEqual(client.puts, 1)
        body, metadata, checksum = next(iter(client.objects.values()))
        decoded = json.loads(gzip.decompress(body).decode().strip())
        self.assertEqual(base64.b64decode(decoded["value_base64"]), item.raw_value)
        self.assertEqual(decoded["event_sha256"], item.event_sha256)
        self.assertEqual(checksum, base64.b64encode(hashlib.sha256(body).digest()).decode())
        replay = sink.write_batch((item,))
        self.assertEqual(replay.commit_next_offset, first.commit_next_offset)
        self.assertEqual(client.puts, 1)

    def test_replay_waits_for_existing_segment_end_then_commits_prefix(self):
        client = FakeS3()
        sink = S3ArchiveSink(client, "gg-telemetry")
        first = record(offset=8)
        second = record(offset=9)
        sink.write_batch((first, second))
        waiting = sink.write_batch((first,))
        self.assertIsNone(waiting.commit_next_offset)
        recovered = sink.write_batch((first, second))
        self.assertEqual(recovered.consumed_count, 2)

    def test_rejects_invalid_bucket_scope_and_checksum_tampering(self):
        client = FakeS3()
        with self.assertRaises(ValueError):
            S3ArchiveSink(client, "bucket", "other")
        sink = S3ArchiveSink(client, "bucket")
        item = record()
        sink.write_batch((item,))
        key = next(iter(client.objects))
        body, metadata, _checksum = client.objects[key]
        client.objects[key] = (body, metadata, base64.b64encode(b"x" * 32).decode())
        with self.assertRaises(ArchiveError):
            sink.write_batch((item,))


class HealthTests(unittest.TestCase):
    def test_readiness_health_and_metrics_reflect_dependency_state(self):
        state = HealthState("clickhouse")
        server = start_health_server(state, host="127.0.0.1", port=0)
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with self.assertRaises(HTTPError) as error:
                urlopen(base + "/readyz")
            error.exception.close()
            state.heartbeat()
            state.set_backends(backend_ready=True, kafka_ready=True)
            state.success("clickhouse", "greenguard.telemetry.recorded.v1", 3)
            with urlopen(base + "/readyz") as response:
                self.assertEqual(response.status, 200)
            with urlopen(base + "/metrics") as response:
                metrics = response.read().decode()
                self.assertIn('mode="clickhouse",topic="greenguard.telemetry.recorded.v1"} 3', metrics)
                self.assertNotIn(TENANT, metrics)
            state.mark_fatal()
            with self.assertRaises(HTTPError) as error:
                urlopen(base + "/readyz")
            error.exception.close()
            with self.assertRaises(HTTPError) as error:
                urlopen(base + "/healthz")
            self.assertEqual(error.exception.code, 500)
            error.exception.close()
        finally:
            server.shutdown()
            server.server_close()


class RuntimeTests(unittest.TestCase):
    def test_commits_kafka_only_after_durable_sink_success(self):
        actions = []
        stop = threading.Event()
        item = record(offset=12)

        class Message:
            def topic(self): return item.topic
            def partition(self): return item.partition
            def offset(self): return item.offset
            def key(self): return item.raw_key
            def value(self): return item.raw_value
            def error(self): return None

        class Consumer:
            def __init__(self, config):
                self.config = config
            def list_topics(self, timeout):
                return type("Metadata", (), {"topics": {topic: None for topic in TOPICS}})()
            def subscribe(self, topics):
                self.topics = topics
            def poll(self, timeout):
                if not getattr(self, "sent", False):
                    self.sent = True
                    stop.set()
                    return Message()
                return None
            def assignment(self):
                return [object()]
            def commit(self, offsets, asynchronous):
                actions.append("commit")
            def close(self):
                actions.append("close")

        class Sink:
            attempts = 0
            def check(self):
                return None
            def write_batch(self, records):
                self.attempts += 1
                if self.attempts == 1:
                    raise RuntimeError("temporary failure")
                actions.append("durable")
                return len(records)

        ca_file = ssl.get_default_verify_paths().cafile
        env = {
            "HEALTH_PORT": "0", "KAFKA_SECURITY_PROTOCOL": "SASL_SSL", "KAFKA_SASL_MECHANISM": "PLAIN",
            "KAFKA_TLS_CA_FILE": ca_file, "KAFKA_SASL_USERNAME": "user", "KAFKA_SASL_PASSWORD": "pass",
            "KAFKA_BROKERS": "broker:9093", "CLICKHOUSE_URL": "http://localhost:8123",
            "CLICKHOUSE_USER": "user", "CLICKHOUSE_PASSWORD": "secret",
        }
        original_age = runtime.MAX_BATCH_AGE_SECONDS
        runtime.MAX_BATCH_AGE_SECONDS = 0
        try:
            with mock.patch.dict(os.environ, env, clear=True):
                runtime.run("clickhouse", consumer_factory=Consumer,
                            topic_partition_factory=lambda topic, partition, offset: (topic, partition, offset),
                            clickhouse_factory=lambda *_args: Sink(), stop_event=stop)
        finally:
            runtime.MAX_BATCH_AGE_SECONDS = original_age
        self.assertLess(actions.index("durable"), actions.index("commit"))
        self.assertEqual(actions[-1], "close")


if __name__ == "__main__":
    unittest.main()


if __name__ == "__main__":
    unittest.main()
