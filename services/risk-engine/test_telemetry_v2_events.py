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

    def test_scalar_and_sensor_physical_bounds_and_errors(self):
        cases = (
            ("temperature_c", "Cel", (-80, 120), (-81, 121)),
            ("relative_humidity_percent", "%", (0, 100), (-1, 101)),
            ("co2_ppm", "ppm", (0, 1e100), (-1,)),
            ("grain_moisture_percent", "%", (0, 100), (-1, 101)),
        )
        for metric, unit, valid, invalid in cases:
            for sensor in (False, True):
                for value in (*valid, *invalid, True, float("inf"), float("nan")):
                    with self.subTest(metric=metric, sensor=sensor, value=value):
                        self._assert_physical_value(metric, unit, value, sensor, valid, invalid)

    def _physical_event(self, metric, unit, value, sensor):
        event = copy.deepcopy(self.event)
        payload = event["payload"]
        if sensor:
            observation = payload["sensor_observations"][0]
            observation.update(metric=metric, unit=unit, value=value)
            payload["sensor_observations"] = [observation]
        else:
            payload["measurements"] = {metric: value}
            payload["measurement_units"] = {metric: unit}
        return event

    def _assert_physical_value(self, metric, unit, value, sensor, valid, invalid):
        event = self._physical_event(metric, unit, value, sensor)
        if value in valid and not isinstance(value, bool):
            self.parse_event(event)
            return
        if value in invalid and not isinstance(value, bool):
            detail = ("sensor observation is outside its physical range" if sensor
                      else f"{metric} is outside its physical range")
        else:
            detail = ("sensor observation value must be finite" if sensor
                      else f"{metric} must be finite numeric")
        with self.assertRaises(InvalidEvent) as raised:
            self.parse_event(event)
        self.assertEqual(str(raised.exception), f"invalid_event: {detail}")

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
