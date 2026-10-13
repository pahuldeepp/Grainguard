import base64
import hashlib
import json
import pathlib
import unittest
from unittest.mock import patch

from telemetry_sinks.common import archive_key, archive_record, clickhouse_row, kafka_consumer_config

ROOT = pathlib.Path(__file__).resolve().parents[3]


class SinkContractTests(unittest.TestCase):
    def setUp(self):
        self.raw = (ROOT / "tests/fixtures/events/telemetry-recorded.v1.valid.json").read_bytes()
        self.event = json.loads(self.raw)

    def test_archive_round_trip_is_byte_exact_and_coordinate_stable(self):
        key = b"tenant/device"
        archived, digest = archive_record("greenguard.telemetry.recorded.v1", 3, 42, key, self.raw, 1790000000000)
        parsed = json.loads(archived)
        self.assertEqual(base64.b64decode(parsed["key_base64"]), key)
        self.assertEqual(base64.b64decode(parsed["value_base64"]), self.raw)
        self.assertEqual(parsed["sha256"], hashlib.sha256(key + b"\0" + self.raw).hexdigest())
        self.assertEqual(digest, parsed["sha256"])
        archived_with_replay_marker, _ = archive_record(
            "greenguard.telemetry.recorded.v1", 3, 43, key, self.raw, 1790000000000,
            [("greenguard-replay", b"v1")],
        )
        marker = json.loads(archived_with_replay_marker)
        self.assertEqual(base64.b64decode(marker["headers"][0]["value_base64"]), b"v1")
        self.assertEqual(len(marker["headers_sha256"]), 64)
        self.assertEqual(archive_key("greenguard.telemetry.recorded.v1", 3, 42, 1790000000000),
                         archive_key("greenguard.telemetry.recorded.v1", 3, 42, 1790000000000))

    def test_clickhouse_projection_keeps_tenant_and_source_coordinates(self):
        row = clickhouse_row(self.raw, "greenguard.telemetry.recorded.v1", 2, 19)
        payload = self.event["payload"]
        self.assertEqual(row["event_id"], self.event["event_id"])
        self.assertEqual(row["tenant_id"], self.event["tenant_id"])
        self.assertEqual(row["device_id"], payload["device_id"])
        self.assertEqual(row["source_offset"], 19)
        self.assertEqual(row["observed_at"], "2026-09-21 14:59:59.500")
        self.assertEqual(row["temperature_c"], payload["measurements"]["temperature_c"])
        self.assertEqual(row["relative_humidity_percent"], payload["measurements"]["relative_humidity_percent"])

    def test_clickhouse_rejects_unknown_or_malformed_contract(self):
        with self.assertRaises(ValueError):
            clickhouse_row(b'{"event_type":"other"}', "topic", 0, 0)
        malformed = dict(self.event)
        malformed["payload"] = None
        with self.assertRaises(ValueError):
            clickhouse_row(json.dumps(malformed).encode(), "topic", 0, 0)

    def test_kafka_consumer_requires_authenticated_tls_configuration(self):
        with patch.dict("os.environ", {
            "KAFKA_BROKERS": "kafka.internal:9094",
            "KAFKA_SECURITY_PROTOCOL": "SASL_SSL",
            "KAFKA_SASL_USERNAME": "telemetry-sinks",
            "KAFKA_SASL_PASSWORD": "test-password",
            "KAFKA_TLS_CA_FILE": "/etc/greenguard/kafka/ca.crt",
        }, clear=True):
            config = kafka_consumer_config("archive-test", "sink-test")
        self.assertEqual(config["security.protocol"], "SASL_SSL")
        self.assertEqual(config["sasl.mechanism"], "PLAIN")
        self.assertEqual(config["sasl.username"], "telemetry-sinks")
        self.assertEqual(config["ssl.ca.location"], "/etc/greenguard/kafka/ca.crt")
        self.assertFalse(config["enable.auto.commit"])

    def test_kafka_consumer_fails_closed_when_sasl_credentials_are_missing(self):
        with patch.dict("os.environ", {
            "KAFKA_BROKERS": "kafka.internal:9094",
            "KAFKA_SECURITY_PROTOCOL": "SASL_SSL",
        }, clear=True):
            with self.assertRaisesRegex(RuntimeError, "requires a username"):
                kafka_consumer_config("archive-test", "sink-test")


if __name__ == "__main__":
    unittest.main()
