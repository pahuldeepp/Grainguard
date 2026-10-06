from datetime import date, datetime, timezone
from threading import Event
import json
import unittest

from knowledge_extensions.kafka_runtime import (
    SUGGESTION_USAGE_TOPIC, apply_suggestion_usage_event,
    consume_suggestion_analytics_forever, decode_suggestion_usage_event,
    publish_suggestion_usage_once,
)


TENANT = "11111111-1111-4111-8111-111111111111"
OTHER_TENANT = "99999999-9999-4999-8999-999999999999"
EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
CLAIM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
CREATED = datetime(2026, 8, 25, 12, 30, tzinfo=timezone.utc)


def usage_event(tenant=TENANT, **extra):
    result = {"schema_version": 1, "event_id": EVENT, "tenant_id": tenant,
              "suggestion_id": "grain_moisture", "created_at": "2026-08-25T12:30:00Z"}
    result.update(extra)
    return result


class Message:
    def __init__(self, value, key=f"{TENANT}:{EVENT}"):
        self._value, self._key = value, key.encode()
    def value(self): return self._value
    def key(self): return self._key
    def error(self): return None
    def topic(self): return SUGGESTION_USAGE_TOPIC
    def partition(self): return 0
    def offset(self): return 7


class RelayConnection:
    def __init__(self, shared): self.shared, self.rows, self.rowcount = shared, [], 0
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def transaction(self): return self
    def execute(self, query, params=()):
        self.shared["queries"].append(query)
        if "WITH candidates AS" in query:
            self.rows = [(EVENT, "grain_moisture", CREATED, CLAIM)]
        elif "SET published_at" in query:
            self.rowcount = 1
        elif "SET claim_token=NULL" in query:
            self.shared["released"] = True
        return self
    def fetchall(self): return self.rows
    def fetchone(self): return None


class Producer:
    def __init__(self, *, error=None): self.error, self.items = error, []
    def produce(self, topic, **kwargs):
        self.items.append((topic, kwargs))
        kwargs["on_delivery"](self.error, None)
    def flush(self, _timeout): return 0


class RelayTests(unittest.TestCase):
    def test_claim_publishes_only_versioned_id_time_event_then_marks_ack(self):
        shared = {"queries": []}
        producer = Producer()
        count = publish_suggestion_usage_once(lambda: RelayConnection(shared), producer, TENANT)
        self.assertEqual(count, 1)
        topic, message = producer.items[0]
        self.assertEqual(topic, SUGGESTION_USAGE_TOPIC)
        self.assertEqual(message["key"], f"{TENANT}:{EVENT}")
        payload = json.loads(message["value"])
        self.assertEqual(set(payload), {"schema_version", "event_id", "tenant_id", "suggestion_id", "created_at"})
        self.assertEqual(payload, usage_event())
        self.assertTrue(any("FOR UPDATE SKIP LOCKED" in query for query in shared["queries"]))
        self.assertTrue(any("SET published_at=clock_timestamp()" in query for query in shared["queries"]))

    def test_delivery_failure_releases_claim_for_retry(self):
        shared = {"queries": [], "released": False}
        with self.assertRaisesRegex(RuntimeError, "Kafka delivery failed"):
            publish_suggestion_usage_once(lambda: RelayConnection(shared), Producer(error=RuntimeError("offline")), TENANT)
        self.assertTrue(shared["released"])


class AggregateConnection:
    def __init__(self, state): self.state, self.row = state, None
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def transaction(self): return self
    def execute(self, query, params=()):
        if "set_config('app.tenant_id'" in query:
            self.state["tenants"].append(params[0]); return self
        if "INSERT INTO assistant_suggestion_usage_events" in query:
            tenant, event_id, suggestion, _created = params
            key = (tenant, event_id)
            if key in self.state["events"]:
                self.row = None
            else:
                self.state["events"].add(key); self.row = (event_id,)
            return self
        if "SELECT suggestion_id,created_at FROM assistant_suggestion_usage_outbox" in query:
            self.row = self.state["outbox"].get((params[0], params[1]))
            return self
        if "INSERT INTO assistant_suggestion_usage_daily" in query:
            tenant, day, suggestion, _created = params
            key = (tenant, day, suggestion)
            self.state["daily"][key] = self.state["daily"].get(key, 0) + 1
            return self
        raise AssertionError("unexpected aggregate SQL")
    def fetchone(self): return self.row


class ConsumerTests(unittest.TestCase):
    def test_decoder_rejects_malformed_or_content_bearing_events(self):
        valid = usage_event()
        self.assertEqual(decode_suggestion_usage_event(Message(json.dumps(valid).encode())), valid)
        for change in (
            {"question": "private question"},
            {"suggestion_id": "unknown"},
            {"created_at": "2026-08-25T12:30:00"},
            {"event_id": "not-a-uuid"},
        ):
            payload = valid | change
            with self.subTest(change=change), self.assertRaises(ValueError):
                decode_suggestion_usage_event(Message(json.dumps(payload).encode()))
        with self.assertRaises(ValueError):
            decode_suggestion_usage_event(Message(json.dumps(valid).encode(), key="wrong:key"))

    def test_consumer_quarantines_malformed_record_using_coordinates_only(self):
        malformed = Message(b'{"question":"do not copy this into quarantine"}')
        class Consumer:
            committed = False
            def poll(self, _timeout): return malformed
            def commit(self, **_kwargs): self.committed = True; stop.set()
        stop, consumer, quarantine = Event(), Consumer(), Producer()
        consume_suggestion_analytics_forever(consumer, lambda: None, stop=stop, quarantine_producer=quarantine)
        self.assertTrue(consumer.committed)
        receipt = json.loads(quarantine.items[0][1]["value"])
        self.assertEqual(receipt, {"topic": SUGGESTION_USAGE_TOPIC, "partition": 0,
                                   "offset": 7, "reason": "invalid_event"})

    def test_deduplication_and_daily_aggregate_are_atomic_and_tenant_scoped(self):
        state = {"events": set(), "daily": {}, "tenants": [], "outbox": {}}
        connect = lambda: AggregateConnection(state)
        event = usage_event()
        state["outbox"][(TENANT, EVENT)] = ("grain_moisture", CREATED)
        state["outbox"][(OTHER_TENANT, EVENT)] = ("grain_moisture", CREATED)
        self.assertTrue(apply_suggestion_usage_event(connect, event))
        self.assertFalse(apply_suggestion_usage_event(connect, event))
        self.assertTrue(apply_suggestion_usage_event(connect, usage_event(OTHER_TENANT)))
        self.assertEqual(len(state["events"]), 2)
        self.assertEqual(state["daily"][(TENANT, date(2026, 8, 25), "grain_moisture")], 1)
        self.assertEqual(state["daily"][(OTHER_TENANT, date(2026, 8, 25), "grain_moisture")], 1)
        self.assertEqual(state["tenants"], [TENANT, TENANT, OTHER_TENANT])


if __name__ == "__main__":
    unittest.main()
