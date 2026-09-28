import json
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from types import SimpleNamespace

from risk_engine import events, main
from risk_engine.apply import Applier, Record, RetryPolicy
from risk_engine.consumer import Consumer, DatabaseSink, LotFeed, payload_digest
from risk_engine.events import Checkpoint
from risk_engine.health import Metrics, serve
from risk_engine.kafka_source import KafkaError, KafkaSource
from test_fakes import (FakeDatabase, FakeSink, FakeSource, TEST_POLICIES, lot_changed, new_id,
                        record, registered, telemetry)

UTC = timezone.utc


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def build(records=(), gate=False, sink=None, max_wait=10.0):
    db = FakeDatabase()
    source = FakeSource(records)
    feed = LotFeed(enabled=gate)
    metrics = Metrics()
    clock = Clock()
    applier = Applier(db, "risk-test", feed.value, policies=TEST_POLICIES, retry=RetryPolicy(attempts=1))
    consumer = Consumer(source, sink or FakeSink(), applier, feed, metrics, max_wait_s=max_wait,
                        backoff_s=1.0, monotonic=clock)
    return SimpleNamespace(db=db, source=source, feed=feed, metrics=metrics, clock=clock, consumer=consumer)


class World:
    def __init__(self):
        self.tenant, self.site, self.bin, self.device, self.lot = (new_id() for _ in range(5))

    def device_record(self):
        return record(registered(self.tenant, self.device, self.site, self.bin))

    def lot_record(self, offset=None):
        return record(lot_changed(self.tenant, self.site, self.bin, self.lot, "wheat", 1, "2026-09-24T08:00:00Z"),
                      offset=offset)

    def reading_record(self, observed="2026-09-24T11:00:00Z"):
        return record(telemetry(self.tenant, self.device, self.site, self.bin, observed))


class ConsumerTest(unittest.TestCase):
    def test_commits_only_after_effect_and_handles_duplicates(self):
        w = World()
        reading = w.reading_record()
        c = build([w.device_record(), w.lot_record(), reading, reading])
        while c.consumer.step(0):
            pass
        self.assertEqual(len(c.source.commits), 4)
        self.assertEqual(len(c.db.state["outbox"]), 1)
        self.assertEqual(c.metrics.value("risk_records_total", topic=events.TELEMETRY_TOPIC, outcome="duplicate"), 1)
        self.assertIsNone(c.consumer.step(0))

    def test_not_ready_pauses_partition_retries_then_scores_when_lot_arrives(self):
        w = World()
        reading = w.reading_record()
        c = build([w.device_record(), reading])
        c.consumer.step(0)
        c.consumer.step(0)
        self.assertEqual(c.source.paused, [reading])
        self.assertNotIn((reading.topic, reading.partition, reading.offset), c.source.commits)
        c.source.queue = [w.lot_record()]
        c.consumer.step(0)  # lot topic keeps flowing while telemetry is paused
        c.clock.t = 1.0
        c.source.queue = [reading]
        c.consumer.step(0)
        self.assertEqual(c.source.resumed, [(reading.topic, reading.partition)])
        self.assertIn((reading.topic, reading.partition, reading.offset), c.source.commits)
        self.assertEqual(len(c.db.state["outbox"]), 1)
        self.assertEqual(c.consumer.waiting, {})

    def test_not_ready_is_quarantined_only_after_the_bound(self):
        w = World()
        reading = w.reading_record()
        sink = FakeSink()
        c = build([w.device_record(), reading], sink=sink, max_wait=5)
        c.consumer.step(0)
        c.consumer.step(0)
        c.clock.t = 4.9
        c.source.queue = [reading]
        c.consumer.step(0)
        self.assertEqual(sink.items, [])
        c.clock.t = 5.0
        c.source.queue = [reading]
        c.consumer.step(0)
        self.assertEqual(sink.items, [(reading.topic, reading.offset, "lot_state_unavailable")])
        self.assertIn((reading.topic, reading.partition, reading.offset), c.source.commits)
        c.source.queue = [w.reading_record()]  # missing binding maps to its own reason
        fresh = build(list(c.source.queue), sink=sink, max_wait=1)
        fresh.consumer.step(0)
        fresh.clock.t = 2
        fresh.source.queue = [fresh.source.paused[0]]
        fresh.consumer.step(0)
        self.assertEqual(sink.items[-1][2], "binding_state_unavailable")

    def test_invalid_records_are_quarantined_and_do_not_block(self):
        w = World()
        garbage = Record(events.TELEMETRY_TOPIC, 0, 7, b"{")
        bad = record(telemetry(w.tenant, w.device, w.site, w.bin, "2026-09-24T11:00:00Z",
                               measurements={"temperature_c": 500}))
        sink = FakeSink()
        c = build([w.device_record(), w.lot_record(), garbage, bad, w.reading_record()], sink=sink)
        while c.consumer.step(0):
            pass
        self.assertEqual([item[2] for item in sink.items], ["invalid_event", "invalid_measurements"])
        self.assertEqual(len(c.source.commits), 5)
        self.assertEqual(c.metrics.value("risk_quarantined_total", reason="invalid_measurements"), 1)

    def test_quarantine_failure_stops_without_commit(self):
        c = build([Record(events.TELEMETRY_TOPIC, 0, 1, b"{")], sink=FakeSink(RuntimeError("db down")))
        with self.assertRaises(RuntimeError):
            c.consumer.step(0)
        self.assertEqual(c.source.commits, [])

    def test_quarantine_and_unavailable_fallback_reasons(self):
        from risk_engine.apply import Result

        c = build()
        c.consumer._finish(Record("t", 0, 1, b""), Result("quarantine"))
        c.consumer._finish(Record("t", 0, 2, b""), Result("not_ready"))
        self.assertEqual(c.consumer.sink.items, [("t", 1, "db_rejected")])
        self.assertEqual(c.metrics.value("risk_not_ready_total", reason="lot_state_unavailable"), 1)

    def test_late_lot_change_is_counted(self):
        w = World()
        canola = lot_changed(w.tenant, w.site, w.bin, new_id(), "canola", 2, "2026-09-24T10:00:00Z", previous=w.lot)
        c = build([w.device_record(), w.lot_record(), w.reading_record(), record(canola)])
        while c.consumer.step(0):
            pass
        self.assertEqual(c.metrics.value("risk_late_lot_changes_total"), 1)


class LotFeedTest(unittest.TestCase):
    def test_checkpoint_becomes_watermark_once_lot_partitions_are_applied(self):
        w = World()
        checkpoint = Record(events.DEVICE_TOPIC, 3, 9, json.dumps(
            {"event_type": "binding.feed_checkpoint", "source_time": "2026-09-24T12:00:00Z"}).encode())
        c = build([checkpoint], gate=True)
        c.source.marks = {0: 5, 1: 0}
        c.consumer.step(0)
        self.assertIsNone(c.feed.value())
        c.source.queue = [w.lot_record(offset=4)]
        c.source.committed_offsets = {0: 2}
        c.consumer.step(0)
        c.clock.t = 1.0
        c.consumer.step(0)
        self.assertEqual(c.feed.value(), datetime(2026, 9, 24, 12, tzinfo=UTC))
        c.feed.observe(Checkpoint(datetime(2026, 9, 24, 11, tzinfo=UTC)), {})
        c.feed.promote(dict)
        self.assertEqual(c.feed.value(), datetime(2026, 9, 24, 12, tzinfo=UTC))

    def test_disabled_gate_trusts_open_intervals(self):
        self.assertEqual(LotFeed(enabled=False).value().year, 9999)

    def test_pending_checkpoints_are_bounded_and_metadata_is_rate_limited(self):
        c = build(gate=True)
        c.source.committed = lambda topic: setattr(c.source, "reads", getattr(c.source, "reads", 0) + 1) or {}
        for second in range(200):
            c.feed.observe(Checkpoint(datetime(2026, 9, 24, 11, tzinfo=UTC)), {0: second})
        self.assertLessEqual(len(c.feed.pending), 128)
        c.consumer.step(0)
        for _ in range(100):
            c.consumer.step(0)
        self.assertEqual(c.source.reads, 1)
        c.clock.t = 1.0
        c.consumer.step(0)
        self.assertEqual(c.source.reads, 2)


class HealthTest(unittest.TestCase):
    def test_endpoints_and_labels(self):
        metrics = Metrics()
        metrics.inc("risk_records_total", topic="t", outcome="applied")
        metrics.inc("risk_up")
        with self.assertRaises(ValueError):
            metrics.inc("x", tenant_id="t")
        ready = threading.Event()
        server = serve(0, metrics, ready.is_set, host="127.0.0.1")
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            self.assertEqual(urllib.request.urlopen(base + "/healthz").read(), b"ok\n")
            body = urllib.request.urlopen(base + "/metrics").read().decode()
            self.assertIn('risk_records_total{outcome="applied",topic="t"} 1', body)
            self.assertIn("risk_up 1", body)
            for path, status in (("/readyz", 503), ("/nope", 404)):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(base + path)
                self.assertEqual(caught.exception.code, status)
                caught.exception.close()
            ready.set()
            self.assertEqual(urllib.request.urlopen(base + "/readyz").status, 200)
        finally:
            server.shutdown()
            server.server_close()


class FakeMessage:
    def __init__(self, error=None):
        self._error = error

    def error(self):
        return self._error

    def topic(self):
        return events.LOT_TOPIC

    def partition(self):
        return 1

    def offset(self):
        return 4

    def value(self):
        return b"{}"


class FakeKafka:
    def __init__(self, config):
        self.config, self.calls, self.messages = config, [], []
        self.commit_result = [SimpleNamespace(error=None)]

    def subscribe(self, topics):
        self.calls.append(("subscribe", topics))

    def poll(self, timeout):
        return self.messages.pop(0) if self.messages else None

    def commit(self, offsets, asynchronous):
        self.calls.append(("commit", offsets, asynchronous))
        return self.commit_result

    def pause(self, parts):
        self.calls.append(("pause", parts))

    def seek(self, part):
        self.calls.append(("seek", part))

    def resume(self, parts):
        self.calls.append(("resume", parts))

    def list_topics(self, topic, timeout):
        return SimpleNamespace(topics={topic: SimpleNamespace(partitions={1: None, 0: None})})

    def get_watermark_offsets(self, part, timeout, cached):
        return (0, 10 + part[1])

    def committed(self, parts, timeout):
        return [SimpleNamespace(partition=p[1], offset=-1001 if p[1] == 0 else 7) for p in parts]

    def close(self):
        self.calls.append(("close",))


class KafkaSourceTest(unittest.TestCase):
    def make(self, reset="error"):
        holder = {}

        def factory(config):
            holder["kafka"] = FakeKafka(config)
            return holder["kafka"]

        source = KafkaSource("b:9092", "g", events.TOPICS, reset, factory=factory, partition=lambda *a: a)
        return source, holder["kafka"]

    def test_adapter_contract(self):
        source, kafka = self.make()
        self.assertEqual(kafka.config["auto.offset.reset"], "error")
        self.assertFalse(kafka.config["enable.auto.commit"])
        self.assertIsNone(source.poll(0))
        kafka.messages = [FakeMessage()]
        rec = source.poll(0)
        self.assertEqual((rec.topic, rec.partition, rec.offset), (events.LOT_TOPIC, 1, 4))
        source.commit(rec)
        self.assertEqual(kafka.calls[-1], ("commit", [(events.LOT_TOPIC, 1, 5)], False))
        source.rewind_and_pause(rec)
        source.resume(events.LOT_TOPIC, 1)
        self.assertEqual([c[0] for c in kafka.calls[-3:]], ["pause", "seek", "resume"])
        self.assertEqual(source.high_watermarks(events.LOT_TOPIC), {0: 10, 1: 11})
        self.assertEqual(source.committed(events.LOT_TOPIC), {0: 0, 1: 7})
        source.close()
        self.assertEqual(kafka.calls[-1], ("close",))

    def test_default_client_factories(self):
        from risk_engine import kafka_source

        part = kafka_source._default_partition("t", 2, 5)
        self.assertEqual((part.topic, part.partition, part.offset), ("t", 2, 5))
        client = kafka_source._default_factory({"bootstrap.servers": "127.0.0.1:1", "group.id": "unit"})
        client.close()

    def test_failures_are_hard(self):
        source, kafka = self.make("earliest")
        kafka.messages = [FakeMessage(error="_AUTO_OFFSET_RESET")]
        with self.assertRaises(KafkaError):
            source.poll(0)
        kafka.commit_result = [SimpleNamespace(error="rebalanced")]
        offset = Record("t", 0, 1, b"")
        with self.assertRaises(KafkaError):
            source.commit(offset)
        kafka.commit_result = None
        with self.assertRaises(KafkaError):
            source.commit(offset)
        with self.assertRaises(ValueError):
            self.make("latest")


class MainTest(unittest.TestCase):
    ENV = {"RISK_DATABASE_URL": "postgresql://x", "KAFKA_BROKERS": "b:1"}

    def test_config_validation(self):
        config = main.load_config(self.ENV.get)
        self.assertEqual((config.group, config.offset_reset, config.health_port, config.lot_feed_gate),
                         ("greenguard.risk-engine.v1", "error", 8086, True))
        for bad in ({}, {**self.ENV, "RISK_LOT_FEED_GATE": "maybe"}, {**self.ENV, "RISK_HEALTH_PORT": "0"},
                    {**self.ENV, "RISK_NOT_READY_MAX_WAIT_S": "0"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                main.load_config(bad.get)
        with self.subTest("required shard registry cannot fall back to central URL"), self.assertRaisesRegex(
                ValueError, "SHARD_REGISTRY_FILE is required"):
            main.load_config({**self.ENV, "SHARD_ROUTING_REQUIRED": "true"}.get)
        with self.subTest("invalid shard routing mode fails closed"), self.assertRaisesRegex(
                ValueError, "SHARD_ROUTING_REQUIRED must be true or false"):
            main.load_config({**self.ENV, "SHARD_ROUTING_REQUIRED": "yes"}.get)
        # Explicit local legacy mode remains supported.
        main.load_config({**self.ENV, "SHARD_ROUTING_REQUIRED": "false"}.get)

    def test_run_wires_collaborators_and_shuts_down(self):
        stop = threading.Event()
        db = FakeDatabase()
        probe = FakeDatabase()
        probe.ping = lambda: True
        db.close = lambda: setattr(db, "closed", True)
        probe.close = lambda: setattr(probe, "closed", True)
        source = FakeSource()
        source.close = lambda: setattr(source, "closed", True)
        steps = []
        source.poll = lambda timeout: (steps.append(timeout), stop.set())[1]
        server = SimpleNamespace(shutdown=lambda: setattr(server, "down", True))
        started = []
        ready_probe = []
        databases = iter((db, probe))
        code = main.run({**self.ENV, "RISK_LOT_FEED_GATE": "off"}.get, stop, database=lambda url: next(databases),
                        source=lambda *args: source,
                        start_health=lambda port, metrics, ready, **kwargs: (ready_probe.append(ready), started.append((port, ready())), server)[2])
        self.assertEqual((code, steps, started), (0, [1.0], [(8086, False)]))
        self.assertTrue(ready_probe[0]())
        from unittest import mock

        with mock.patch.object(main.time, "monotonic", return_value=main.time.monotonic() + 11):
            self.assertFalse(ready_probe[0]())
        probe.ping = lambda: False
        self.assertFalse(ready_probe[0]())
        self.assertTrue(db.closed and probe.closed and source.closed and server.down)


    def test_main_installs_signal_handlers(self):
        import signal
        from unittest import mock

        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        seen = {}

        def fake_run(getenv, stop):
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            seen["stopped"] = stop.is_set()
            return 0

        try:
            with mock.patch.object(main, "run", fake_run):
                self.assertEqual(main.main(), 0)
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        self.assertTrue(seen["stopped"])


class SinkTest(unittest.TestCase):
    def test_database_sink_records_coordinates_and_digest(self):
        db = FakeDatabase()
        rec = Record("t", 2, 1234, b"payload")
        DatabaseSink(db, "g").quarantine(rec, "invalid_event")
        self.assertEqual(db.quarantined, [("g", "t", 2, 1234, "invalid_event", payload_digest(rec))])


if __name__ == "__main__":
    unittest.main()
