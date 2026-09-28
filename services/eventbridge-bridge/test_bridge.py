import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import bridge as MODULE
from bridge import forward_record, validate_event

TENANT = "11111111-1111-4111-8111-111111111111"
EVENT = {
    "event_id": "33333333-3333-4333-8333-333333333333",
    "event_type": "alert.escalated",
    "schema_version": 1,
    "tenant_id": TENANT,
    "aggregate_type": "alert_episode",
    "aggregate_id": "22222222-2222-4222-8222-222222222222",
    "aggregate_version": "3",
    "occurred_at": "2026-09-25T12:00:00Z",
    "correlation_id": "44444444-4444-4444-8444-444444444444",
    "causation_id": "55555555-5555-4555-8555-555555555555",
    "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    "payload": {
        "episode_id": "22222222-2222-4222-8222-222222222222",
        "episode_version": "3",
        "state": "open",
        "severity": "critical",
    },
}


class FakeEvents:
    def __init__(self):
        self.entries = []

    def put_events(self, Entries):
        self.entries.extend(Entries)
        return {"FailedEntryCount": 0}


class FakeQueue:
    def __init__(self):
        self.messages = []

    def send_message(self, **kwargs):
        self.messages.append(kwargs)


class BridgeTests(unittest.TestCase):
    def test_readiness_requires_kafka_assignment_and_stays_unready_after_shutdown(self):
        calls = []
        handlers = {}

        class Consumer:
            def __init__(self, config):
                calls.append("consumer")

            def subscribe(self, topics):
                calls.append("subscribe")

            def assignment(self):
                return [SimpleNamespace(topic="alerts", partition=0)]

            def poll(self, _timeout):
                if calls.count("poll") == 0:
                    calls.append("poll")
                    return None
                calls.append((MODULE.HEALTH.status("/readyz"), list(clients)))
                handlers["SIGTERM"](None, None)
                return None

            def close(self):
                calls.append("close")

        kafka_error = SimpleNamespace(_PARTITION_EOF=-191)
        clients = []
        def client(name):
            clients.append(name)
            return object()

        env = {"KAFKA_BROKERS": "broker:9092", "EVENT_BUS_NAME": "alerts", "BRIDGE_QUARANTINE_QUEUE_URL": "https://sqs.example/q"}
        with patch.dict(os.environ, env, clear=False), \
             patch.object(MODULE.signal, "getsignal", return_value=None), \
             patch.object(MODULE.signal, "signal", side_effect=lambda sig, handler: handlers.__setitem__("SIGTERM", handler)):
            self.assertFalse(MODULE.run(Consumer, kafka_error, client))

        self.assertEqual(clients, ["events", "sqs"])
        self.assertIn((200, ["events", "sqs"]), calls)
        self.assertEqual(calls[-1], "close")
        self.assertEqual(MODULE.HEALTH.status("/readyz"), 503)

    def test_routes_critical_escalation_to_serverless_marker_unconditionally(self):
        events, queue = FakeEvents(), FakeQueue()
        forward_record(events, queue, bus_name="bus", quarantine_url="dlq",
                       raw=json.dumps(EVENT).encode(),
                       topic="alerts", partition=1, offset=42)
        self.assertEqual([entry["DetailType"] for entry in events.entries],
                         ["alert.escalated", "alert.critical.serverless"])
        self.assertEqual(json.loads(events.entries[1]["Detail"]), EVENT)
        self.assertEqual(queue.messages, [])

    def test_critical_always_enters_critical_route(self):
        events = FakeEvents()
        forward_record(events, FakeQueue(), bus_name="bus", quarantine_url="dlq",
                       raw=json.dumps(EVENT).encode(),
                       topic="alerts", partition=0, offset=1)
        self.assertEqual([entry["DetailType"] for entry in events.entries], ["alert.escalated", "alert.critical.serverless"])

    def test_warning_always_stays_out_of_the_serverless_notification_route(self):
        warning = json.loads(json.dumps(EVENT))
        warning["payload"]["severity"] = "warning"
        events = FakeEvents()
        forward_record(events, FakeQueue(), bus_name="bus", quarantine_url="dlq",
                       raw=json.dumps(warning).encode(),
                       topic="alerts", partition=0, offset=2)
        self.assertEqual([entry["DetailType"] for entry in events.entries], ["alert.escalated"])

    def test_critical_resolved_event_uses_the_serverless_marker(self):
        resolved = json.loads(json.dumps(EVENT))
        resolved["event_type"] = "alert.resolved"
        resolved["payload"]["state"] = "resolved"
        events = FakeEvents()
        forward_record(events, FakeQueue(), bus_name="bus", quarantine_url="dlq",
                       raw=json.dumps(resolved).encode(),
                       topic="alerts", partition=0, offset=3)
        self.assertEqual([entry["DetailType"] for entry in events.entries],
                         ["alert.resolved", "alert.critical.serverless"])

    def test_poison_is_quarantined_without_payload_then_can_be_committed(self):
        queue = FakeQueue()
        forward_record(FakeEvents(), queue, bus_name="bus", quarantine_url="dlq",
                       raw=b'{"email":"private"}',
                       topic="alerts", partition=2, offset=9)
        record = json.loads(queue.messages[0]["MessageBody"])
        self.assertEqual((record["topic"], record["partition"], record["offset"]), ("alerts", 2, 9))
        self.assertNotIn("private", json.dumps(record))

    def test_event_identity_and_route_allowlist_validation(self):
        with self.assertRaises(ValueError):
            validate_event(json.dumps({**EVENT, "tenant_id": "other"}).encode())
        with self.assertRaises(ValueError):
            validate_event(json.dumps({**EVENT, "event_type": []}).encode())


if __name__ == "__main__":
    unittest.main()
