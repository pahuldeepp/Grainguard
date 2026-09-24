import json
import unittest
from datetime import datetime, timedelta, timezone

from risk_engine import events
from risk_engine.events import InvalidEvent
from risk_engine.join import (BINDING_STATE_UNAVAILABLE, LOT_FEED_STALE, LOT_STATE_UNAVAILABLE, Binding,
                              Interval, NotReady, Reading, Reject, Selected, Skip, select_lot)
from test_fakes import fixture

UTC = timezone.utc
BIN = "55555555-5555-4555-8555-555555555555"
T8 = datetime(2026, 9, 24, 8, tzinfo=UTC)
T11 = datetime(2026, 9, 24, 11, tzinfo=UTC)
T12 = datetime(2026, 9, 24, 12, tzinfo=UTC)
WHEAT = Interval(BIN, 1, "77777777-7777-4777-8777-777777777777", "wheat", T8, T12)
CANOLA = Interval(BIN, 2, "88888888-8888-4888-8888-888888888888", "canola", T12, None)
BINDING = Binding("d", "s", BIN, "active", 3, 3)
LATE = datetime(2026, 9, 25, tzinfo=UTC)


def choose(observed, binding=BINDING, intervals=(WHEAT, CANOLA), watermark=LATE, version=3, bin_id=BIN):
    return select_lot(Reading(bin_id, version, observed), binding, list(intervals), watermark)


class EventTimeJoinTest(unittest.TestCase):
    def test_late_wheat_reading_after_canola_replacement_uses_wheat(self):
        self.assertEqual(choose(T11), Selected(WHEAT))

    def test_reading_after_replacement_uses_canola(self):
        self.assertEqual(choose(T12 + timedelta(hours=1)), Selected(CANOLA))

    def test_exact_boundaries_are_half_open(self):
        self.assertEqual(choose(T8), Selected(WHEAT))
        self.assertEqual(choose(T12 - timedelta(microseconds=1)), Selected(WHEAT))
        self.assertEqual(choose(T12), Selected(CANOLA))
        self.assertEqual(choose(T8 - timedelta(microseconds=1)), NotReady(LOT_STATE_UNAVAILABLE))

    def test_missing_or_overlapping_lot_state_is_not_ready(self):
        self.assertEqual(choose(T11, intervals=()), NotReady(LOT_STATE_UNAVAILABLE))
        overlap = Interval(BIN, 9, "99999999-9999-4999-8999-999999999999", "barley", T8, None)
        self.assertEqual(choose(T11, intervals=(WHEAT, overlap)), NotReady(LOT_STATE_UNAVAILABLE))
        other_bin = Interval("other", 1, WHEAT.lot_id, "wheat", T8, None)
        self.assertEqual(choose(T11, intervals=(other_bin,)), NotReady(LOT_STATE_UNAVAILABLE))

    def test_open_interval_needs_a_fresh_lot_feed(self):
        later = T12 + timedelta(hours=2)
        self.assertEqual(choose(later, watermark=None), NotReady(LOT_FEED_STALE))
        self.assertEqual(choose(later, watermark=later - timedelta(seconds=1)), NotReady(LOT_FEED_STALE))
        self.assertEqual(choose(later, watermark=later), Selected(CANOLA))
        # A closed interval is final and needs no watermark.
        self.assertEqual(choose(T11, watermark=None), Selected(WHEAT))

    def test_binding_state(self):
        self.assertEqual(choose(T11, binding=None), NotReady(BINDING_STATE_UNAVAILABLE))
        self.assertEqual(choose(T11, version=4), NotReady(BINDING_STATE_UNAVAILABLE))
        moved = Binding("d", "s", "another-bin", "active", 3, 3)
        self.assertEqual(choose(T11, binding=moved), Reject("binding_conflict"))
        newer = Binding("d", "s", "another-bin", "active", 5, 5)
        self.assertEqual(choose(T11, binding=newer), Selected(WHEAT))
        self.assertEqual(choose(T11, bin_id=None), Skip("device_unbound"))


class EventParsingTest(unittest.TestCase):
    def parse(self, topic, event):
        return events.parse(topic, json.dumps(event).encode())

    def test_fixtures_parse(self):
        reading = self.parse(events.TELEMETRY_TOPIC, fixture("telemetry-recorded.v1.valid.json"))
        self.assertEqual(reading.binding_version, 3)
        self.assertEqual(reading.observed_at, datetime(2026, 9, 21, 14, 59, 59, 500000, tzinfo=UTC))
        lot = self.parse(events.LOT_TOPIC, fixture("lot-changed.v1.valid.json"))
        self.assertEqual((lot.grain_type, lot.occupancy_version, lot.previous_lot_id), ("wheat", 1, None))
        for name in ("device-registered", "device-binding-changed", "device-status-changed"):
            change = self.parse(events.DEVICE_TOPIC, fixture(f"{name}.v1.valid.json"))
            self.assertEqual(change.binding_version, 7)
        self.assertEqual(self.parse(events.DEVICE_TOPIC, fixture("device-binding-changed.v1.valid.json")).fields,
                         {"site_id": "22222222-2222-4222-8222-222222222222", "bin_id": None})

    def test_checkpoint(self):
        checkpoint = self.parse(events.DEVICE_TOPIC, {"event_type": "binding.feed_checkpoint",
                                                      "source_time": "2026-09-24T12:00:00.123456789Z"})
        self.assertEqual(checkpoint.source_time, datetime(2026, 9, 24, 12, 0, 0, 123456, tzinfo=UTC))

    def test_fields_reject_trailing_newlines(self):
        good = fixture("telemetry-recorded.v1.valid.json")
        for key in ("tenant_id", "aggregate_version", "occurred_at", "traceparent"):
            with self.subTest(key=key):
                self.assert_invalid(events.TELEMETRY_TOPIC, {**good, key: good[key] + "\n"})
        lot = fixture("lot-changed.v1.valid.json")
        self.assert_invalid(events.LOT_TOPIC, {**lot, "payload": {**lot["payload"], "grain_type": "wheat\n"}})

    def assert_invalid(self, topic, event, reason="invalid_event"):
        encoded = event if isinstance(event, bytes) else json.dumps(event).encode()
        with self.assertRaises(InvalidEvent) as caught:
            events.parse(topic, encoded)
        self.assertEqual(caught.exception.reason, reason)

    def test_rejections_have_stable_reasons(self):
        good = fixture("telemetry-recorded.v1.valid.json")
        self.assert_invalid("other.topic", good, "unsupported_topic")
        self.assert_invalid(events.TELEMETRY_TOPIC, b"{not json")
        self.assert_invalid(events.TELEMETRY_TOPIC, b"\xff")
        self.assert_invalid(events.TELEMETRY_TOPIC, [1])
        mutations = (
            ("schema_version", 2), ("traceparent", "bad"), ("occurred_at", "2026-09-21"),
            ("aggregate_version", "0"), ("aggregate_version", "9223372036854775808"),
            ("tenant_id", "11111111-1111-4111-8111-11111111111X"), ("payload", []),
            ("occurred_at", "2026-02-30T00:00:00Z"),
        )
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                self.assert_invalid(events.TELEMETRY_TOPIC, {**good, key: value})
        self.assert_invalid(events.TELEMETRY_TOPIC, {**good, "extra": 1})
        self.assert_invalid(events.TELEMETRY_TOPIC, {**good, "event_type": "x"}, "unsupported_event")
        payload = good["payload"]
        self.assert_invalid(events.TELEMETRY_TOPIC, {**good, "aggregate_id": BIN})
        self.assert_invalid(events.TELEMETRY_TOPIC, {**good, "payload": {**payload, "measurements": {}}})
        self.assert_invalid(events.LOT_TOPIC, good, "unsupported_event")
        self.assert_invalid(events.DEVICE_TOPIC, good, "unsupported_event")

    def test_inventory_rejections(self):
        lot = fixture("lot-changed.v1.valid.json")
        payload = lot["payload"]
        for change in ({"grain_type": "Wheat"}, {"variety": ""}, {"variety": 5}, {"bin_id": payload["lot_id"]},
                       {"previous_lot_id": "x"}, {"effective_from": None}):
            with self.subTest(change=change):
                self.assert_invalid(events.LOT_TOPIC, {**lot, "payload": {**payload, **change}})
        device = fixture("device-status-changed.v1.valid.json")
        self.assert_invalid(events.DEVICE_TOPIC, {**device, "payload": {**device["payload"], "status": ""}})
        self.assert_invalid(events.DEVICE_TOPIC, {**device, "aggregate_id": BIN})
        self.assert_invalid(events.DEVICE_TOPIC, {**device, "payload": {**device["payload"], "bin_id": "x"}})
        self.assert_invalid(events.DEVICE_TOPIC, {"event_type": "binding.feed_checkpoint", "source_time": 1})


if __name__ == "__main__":
    unittest.main()
