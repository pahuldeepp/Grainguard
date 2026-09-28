import copy
import json
import unittest

from risk_engine.events import TELEMETRY_TOPIC, TELEMETRY_V2_TOPIC, InvalidEvent, parse
from test_fakes import ROOT


class TelemetryV2ParserTest(unittest.TestCase):
    def setUp(self):
        self.event = json.loads((ROOT / "tests/fixtures/events/telemetry-recorded.v2.valid.json").read_text())

    def parse_event(self, event, topic=TELEMETRY_V2_TOPIC):
        return parse(topic, json.dumps(event).encode())

    def test_parses_additive_scalars_and_sensor_layout_provenance(self):
        parsed = self.parse_event(self.event)
        self.assertEqual(parsed.schema_version, 2)
        self.assertEqual(parsed.measurements["grain_moisture_percent"], 13.5)
        self.assertEqual(parsed.sensor_observations[0]["sensor_id"],
                         "77777777-7777-4777-8777-777777777777")
        self.assertEqual(parsed.sensor_observations[0]["layout_version"], "2")

    def test_rejects_unit_mismatch_duplicate_identity_and_missing_observations(self):
        bad_events = []
        bad = copy.deepcopy(self.event)
        bad["payload"]["measurement_units"]["co2_ppm"] = "%"
        bad_events.append(bad)
        bad = copy.deepcopy(self.event)
        bad["payload"]["sensor_observations"].append(copy.deepcopy(bad["payload"]["sensor_observations"][0]))
        bad_events.append(bad)
        bad = copy.deepcopy(self.event)
        bad["payload"]["measurements"] = {}
        bad["payload"]["measurement_units"] = {}
        bad["payload"].pop("sensor_observations")
        bad_events.append(bad)
        for event in bad_events:
            with self.subTest(payload=event["payload"]), self.assertRaises(InvalidEvent):
                self.parse_event(event)

    def test_v1_and_v2_topic_schema_versions_are_not_interchangeable(self):
        with self.assertRaises(InvalidEvent):
            self.parse_event(self.event, TELEMETRY_TOPIC)
        v1 = copy.deepcopy(self.event)
        v1["schema_version"] = 1
        v1["payload"] = {"device_id": v1["payload"]["device_id"]}
        # The v1 parser rejects the v2-shaped payload, rather than interpreting it.
        with self.assertRaises(InvalidEvent):
            self.parse_event(v1, TELEMETRY_TOPIC)


if __name__ == "__main__":
    unittest.main()
