"""Task 3 fault tests with fake Kafka and a loopback OAuth/Device API."""
import base64
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import Mock

from normalize import SourceConfig
from runtime import (AdmissionClient, FatalFailure, KafkaRuntime, PoisonChange,
                     RawRecord, RetryableFailure, TenantCredential, configured_tenants,
                     decode_dlq, dlq_envelope)

TENANT = "11111111-1111-4111-8111-111111111111"
SOURCE = SourceConfig("partner-one", "generation-1", "legacy-mysql", "partner_inventory", "legacy")
TOPIC = "legacy.partner_inventory.inventory_sites"


def encoded(value):
    return json.dumps({"schema": None, "payload": value}).encode()


def record(offset=42, table="inventory_sites", tenant_key="partner-a"):
    row = {"tenant_key": tenant_key, "site_id": "site-1", "name": "North"}
    payload = {"before": None, "after": row, "op": "r", "ts_ms": 1720000000001,
               "source": {"connector": "mysql", "name": SOURCE.connector_name,
                          "db": SOURCE.database, "table": table, "file": "mysql-bin.000001",
                          "pos": 420, "row": 0, "ts_ms": 1720000000000, "snapshot": "true"}}
    return RawRecord(TOPIC, 0, offset,
                     encoded({"tenant_key": tenant_key, "site_id": "site-1"}), encoded(payload))


class FakeConsumer:
    def __init__(self, records=(), assignment_topic=TOPIC):
        self.records = list(records)
        self.assignment_topic = assignment_topic
        self.commits = []
        self.commit_error = False
        self.closed = False
    def subscribe(self, topics, on_assign, on_revoke):
        self.topics = topics
        self.assign = on_assign
        self.revoke = on_revoke
        on_assign(self, [SimpleNamespace(topic=self.assignment_topic, partition=0)])
    def commit(self, *, offsets, asynchronous):
        assert asynchronous is False
        if self.commit_error:
            raise RetryableFailure("commit interrupted")
        self.commits.extend(offsets)
        return [SimpleNamespace(error=None)]
    def poll(self, timeout):
        return self.records.pop(0) if self.records else None
    def close(self):
        self.closed = True


class FakeProducer:
    def __init__(self):
        self.messages = []
        self.metadata = []
        self.confirm = True
        self.delivery_error = None
        self.pending_flushes = 0
        self.callback = None
    def produce(self, topic, *, key, value, on_delivery, headers=None, partition=None):
        self.messages.append((topic, key, value))
        self.metadata.append((headers, partition))
        self.callback = on_delivery
    def flush(self, timeout):
        if self.pending_flushes:
            self.pending_flushes -= 1
            return 1
        if self.callback is None:
            return 0
        callback, self.callback = self.callback, None
        if self.confirm:
            callback(self.delivery_error, None)
            return 0
        return 1


class Admission:
    def __init__(self):
        self.seen = set()
        self.calls = []
        self.failure = None
    def admit(self, change):
        self.calls.append(change)
        if self.failure:
            error = self.failure
            if callable(error):
                error = error(change)
            if error:
                raise error
        key = (change.source_coordinate, change.payload_sha256)
        self.seen.add(key)
        return {"outcome": "applied"}


def runtime(consumer=None, producer=None, admission=None, **overrides):
    consumer, producer, admission = consumer or FakeConsumer(), producer or FakeProducer(), admission or Admission()
    redrive = overrides.get("redrive", False)
    parked_redrive = overrides.get("parked_redrive", False)
    runner = KafkaRuntime(consumer=consumer, producer=producer, source=SOURCE,
                          tenant_map={"partner-a": TENANT}, admission=admission,
                          topics=(("legacy.inventory.parked",) if parked_redrive else
                                  ("legacy.inventory.dlq",) if redrive else (TOPIC,)),
                          dlq_topic="legacy.inventory.dlq", parked_topic="legacy.inventory.parked",
                          partition_factory=lambda topic, partition, offset: SimpleNamespace(topic=topic, partition=partition, offset=offset),
                          sleep=lambda _: None, **overrides)
    return runner, consumer, producer, admission


class RuntimeTests(unittest.TestCase):
    def test_api_commits_then_kafka_crashes_and_replay_is_same_coordinate(self):
        broker, api = FakeConsumer(), Admission()
        runner, _, _, _ = runtime(consumer=broker, admission=api)
        broker.commit_error = True
        with self.assertRaises(RetryableFailure):
            runner.process(record())
        self.assertEqual(len(api.seen), 1)
        self.assertEqual(broker.commits, [])
        broker.commit_error = False
        runner.process(record())
        self.assertEqual(len(api.seen), 1)
        self.assertEqual(api.calls[0], api.calls[1])
        self.assertEqual([(part.topic, part.partition, part.offset) for part in broker.commits], [(TOPIC, 0, 43)])

    def test_raw_poison_bytes_are_confirmed_to_dlq_before_source_commit(self):
        runner, broker, producer, api = runtime()
        bad = RawRecord(TOPIC, 0, 17, b"\xff", b"\x00\xff")
        runner.process(bad)
        self.assertEqual(api.calls, [])
        self.assertEqual(broker.commits[0].offset, 18)
        topic, _, payload = producer.messages[0]
        self.assertEqual(topic, "legacy.inventory.dlq")
        contents = json.loads(payload)
        self.assertEqual(base64.b64decode(contents["key_base64"]), bad.key)
        self.assertEqual(base64.b64decode(contents["value_base64"]), bad.value)
        self.assertEqual((contents["topic"], contents["partition"], contents["offset"]), (TOPIC, 0, 17))
        self.assertEqual(json.loads(dlq_envelope(bad, source=SOURCE, reason="test"))["connector_generation"], "generation-1")

    def test_dlq_publish_failure_never_commits(self):
        for pending, delivery_error in ((True, None), (False, RuntimeError("broker rejected"))):
            with self.subTest(pending=pending):
                producer = FakeProducer()
                producer.confirm = not pending
                producer.delivery_error = delivery_error
                runner, broker, _, _ = runtime(producer=producer)
                with self.assertRaises(RetryableFailure):
                    runner.process(RawRecord(TOPIC, 0, 1, b"bad", None))
                self.assertEqual(broker.commits, [])

    def test_unresolved_producer_delivery_blocks_next_publish(self):
        producer = FakeProducer()
        producer.pending_flushes = 1
        runner, broker, _, _ = runtime(producer=producer)
        with self.assertRaisesRegex(RetryableFailure, "previous quarantine publish"):
            runner.process(RawRecord(TOPIC, 0, 1, b"bad", None))
        self.assertEqual(producer.messages, [])
        self.assertEqual(broker.commits, [])

    def test_api_outage_retries_with_no_commit_then_replays_backlog(self):
        api = Admission()
        api.failure = RetryableFailure("unavailable")
        runner, broker, _, _ = runtime(admission=api, attempts=3)
        with self.assertRaises(RetryableFailure):
            runner.process(record())
        self.assertEqual(len(api.calls), 3)
        self.assertEqual(broker.commits, [])
        api.failure = None
        runner.process(record())
        self.assertEqual(broker.commits[0].offset, 43)

    def test_parent_dependency_retries_then_quarantines_for_same_coordinate_redrive(self):
        api = Admission()
        api.failure = PoisonChange("parent_dependency")
        runner, broker, producer, _ = runtime(admission=api, attempts=2)
        runner.process(record())
        self.assertEqual(len(api.calls), 2)
        self.assertEqual(broker.commits[0].offset, 43)
        dlq = json.loads(producer.messages[0][2])
        self.assertEqual(dlq["reason"], "parent_dependency")
        api.failure = None
        dlq_broker = FakeConsumer(assignment_topic="legacy.inventory.dlq")
        replay, _, _, _ = runtime(consumer=dlq_broker, admission=api, redrive=True)
        replay.process(RawRecord("legacy.inventory.dlq", 0, 7, b"quarantine", producer.messages[0][2]))
        self.assertEqual(api.calls[-1], api.calls[0])
        self.assertEqual(dlq_broker.commits[0].offset, 8)

    def test_child_before_parent_dlq_requeues_to_tail_then_admits(self):
        from runtime import REDRIVE_ATTEMPT_HEADER
        child_payload = json.loads(record().value)
        child_payload["payload"]["after"] = {"tenant_key": "partner-a", "site_id": "site-1", "bin_id": "bin-1", "name": "Bin"}
        child_payload["payload"]["source"]["table"] = "inventory_bins"
        child = RawRecord("legacy.partner_inventory.inventory_bins", 0, 17,
                          encoded({"tenant_key": "partner-a", "bin_id": "bin-1"}), encoded(child_payload["payload"]))
        parent = record(offset=18)
        api = Admission()
        parent_admitted = False
        def dependency(change):
            nonlocal parent_admitted
            if change.entity_type == "site":
                parent_admitted = True
            elif not parent_admitted:
                return PoisonChange("parent_dependency")
        api.failure = dependency
        broker = FakeConsumer(assignment_topic="legacy.inventory.dlq")
        replay, _, producer, _ = runtime(consumer=broker, admission=api, redrive=True, attempts=1)
        first = RawRecord("legacy.inventory.dlq", 0, 7, b"child", dlq_envelope(child, source=SOURCE, reason="parent_dependency"))
        behind = RawRecord("legacy.inventory.dlq", 0, 8, b"parent", dlq_envelope(parent, source=SOURCE, reason="parent_dependency"))
        replay.process(first)
        self.assertEqual(broker.commits[0].offset, 8)
        self.assertEqual(producer.messages[0], (first.topic, first.key, first.value))
        self.assertEqual(producer.metadata[0], ([(REDRIVE_ATTEMPT_HEADER, b"1")], 0))
        replay.process(behind)
        queued = RawRecord("legacy.inventory.dlq", 0, 9, producer.messages[0][1],
                           producer.messages[0][2], tuple(producer.metadata[0][0]))
        replay.process(queued)
        self.assertEqual([part.offset for part in broker.commits], [8, 9, 10])
        self.assertEqual([change.entity_type for change in api.calls], ["bin", "site", "bin"])
        self.assertEqual(len(producer.messages), 1)

    def test_unresolved_dlq_parent_parks_after_bound_and_wrong_generation_fails_closed(self):
        from runtime import MAX_REDRIVE_REQUEUES, PARK_REASON_HEADER, REDRIVE_ATTEMPT_HEADER
        api = Admission()
        api.failure = PoisonChange("parent_dependency")
        broker = FakeConsumer(assignment_topic="legacy.inventory.dlq")
        replay, _, producer, _ = runtime(consumer=broker, admission=api, redrive=True, attempts=2)
        payload = dlq_envelope(record(), source=SOURCE, reason="parent_dependency")
        current = RawRecord("legacy.inventory.dlq", 0, 7, b"key", payload)
        for attempt in range(MAX_REDRIVE_REQUEUES):
            replay.process(current)
            self.assertEqual(producer.metadata[-1], ([(REDRIVE_ATTEMPT_HEADER, str(attempt + 1).encode())], 0))
            self.assertEqual(producer.messages[-1][2], payload)
            current = RawRecord(current.topic, 0, current.offset + 1, current.key, payload,
                                tuple(producer.metadata[-1][0]))
        replay.process(current)
        self.assertEqual(producer.messages[-1], ("legacy.inventory.parked", current.key, payload))
        self.assertEqual(producer.metadata[-1],
                         ([(REDRIVE_ATTEMPT_HEADER, b"3"), (PARK_REASON_HEADER, b"parent_dependency")], 0))
        self.assertEqual(len(producer.messages), MAX_REDRIVE_REQUEUES + 1)
        self.assertEqual(len(broker.commits), MAX_REDRIVE_REQUEUES + 1)
        with self.assertRaisesRegex(FatalFailure, "header is invalid"):
            replay.process(RawRecord(current.topic, 0, 21, current.key, payload,
                                     ((REDRIVE_ATTEMPT_HEADER, b"-1"),)))
        self.assertEqual(len(broker.commits), MAX_REDRIVE_REQUEUES + 1)
        producer.confirm = False
        with self.assertRaises(RetryableFailure):
            replay.process(RawRecord(current.topic, 0, 20, current.key, payload))
        self.assertEqual(len(broker.commits), MAX_REDRIVE_REQUEUES + 1)
        parked = RawRecord("legacy.inventory.parked", 0, 30, current.key, payload,
                           tuple(producer.metadata[-2][0]))
        repair_broker = FakeConsumer(assignment_topic="legacy.inventory.parked")
        repair, _, repair_producer, _ = runtime(consumer=repair_broker, admission=api,
                                                redrive=True, parked_redrive=True, attempts=1)
        with self.assertRaisesRegex(FatalFailure, "operator repair required"):
            repair.process(parked)
        self.assertEqual(repair_broker.commits, [])
        self.assertEqual(repair_producer.messages, [])
        api.failure = None
        repair.process(parked)
        self.assertEqual(repair_broker.commits[0].offset, 31)
        tampered = json.loads(payload)
        tampered["connector_generation"] = "different"
        with self.assertRaises(FatalFailure):
            decode_dlq(json.dumps(tampered).encode(), source=SOURCE, topics=(TOPIC,))

    def test_configured_tenant_uuid_aliases_bind_one_principal(self):
        alias = TENANT.replace("-", "").upper()
        raw = json.dumps({"partner-a": {"tenant_id": TENANT.upper(), "client_id": "one", "client_secret": "secret"},
                          "partner-a-alias": {"tenant_id": alias, "client_id": "one", "client_secret": "secret"}})
        tenant_map, credentials = configured_tenants(raw)
        self.assertEqual(tenant_map, {"partner-a": TENANT, "partner-a-alias": TENANT})
        self.assertEqual(set(credentials), {TENANT})
        conflicting = raw.replace('"partner-a-alias": {"tenant_id": "' + alias + '", "client_id": "one"',
                                  '"partner-a-alias": {"tenant_id": "' + alias + '", "client_id": "two"')
        with self.assertRaisesRegex(ValueError, "conflicting importer credentials"):
            configured_tenants(conflicting)

    def test_park_publish_must_confirm_before_dlq_commit_and_parent_can_follow(self):
        from runtime import PARK_REASON_HEADER, REDRIVE_ATTEMPT_HEADER
        api = Admission()
        api.failure = PoisonChange("parent_dependency")
        broker = FakeConsumer(assignment_topic="legacy.inventory.dlq")
        producer = FakeProducer()
        producer.confirm = False
        replay, _, _, _ = runtime(consumer=broker, producer=producer, admission=api,
                                  redrive=True, attempts=1)
        child = RawRecord("legacy.inventory.dlq", 0, 7, b"child",
                          dlq_envelope(record(), source=SOURCE, reason="parent_dependency"),
                          ((REDRIVE_ATTEMPT_HEADER, b"3"),))
        with self.assertRaises(RetryableFailure):
            replay.process(child)
        self.assertEqual(broker.commits, [])
        producer.confirm = True
        replay.process(child)
        self.assertEqual(broker.commits[0].offset, 8)
        self.assertEqual(producer.messages[-1], ("legacy.inventory.parked", child.key, child.value))
        self.assertIn((PARK_REASON_HEADER, b"parent_dependency"), producer.metadata[-1][0])
        api.failure = None
        parent = RawRecord("legacy.inventory.dlq", 0, 8, b"parent",
                           dlq_envelope(record(offset=43), source=SOURCE, reason="parent_dependency"))
        replay.process(parent)
        self.assertEqual([part.offset for part in broker.commits], [8, 9])

    def test_non_parent_dlq_reason_is_parked_then_replayed_after_operator_repair(self):
        from runtime import PARK_REASON_HEADER, REDRIVE_ATTEMPT_HEADER
        api = Admission()
        broker = FakeConsumer(assignment_topic="legacy.inventory.dlq")
        producer = FakeProducer()
        replay, _, _, _ = runtime(consumer=broker, producer=producer, admission=api, redrive=True)
        payload = dlq_envelope(record(), source=SOURCE, reason="normalization_invalid")
        poison = RawRecord("legacy.inventory.dlq", 0, 7, b"original-dlq-key", payload,
                           ((REDRIVE_ATTEMPT_HEADER, b"1"),))

        producer.confirm = False
        with self.assertRaises(RetryableFailure):
            replay.process(poison)
        self.assertEqual(broker.commits, [])
        producer.confirm = True
        replay.process(poison)
        self.assertEqual(producer.messages[-1], ("legacy.inventory.parked", poison.key, poison.value))
        self.assertEqual(producer.metadata[-1],
                         ([(REDRIVE_ATTEMPT_HEADER, b"1"),
                           (PARK_REASON_HEADER, b"normalization_invalid")], 0))
        self.assertEqual(broker.commits[0].offset, 8)
        self.assertEqual(api.calls, [])

        parked_broker = FakeConsumer(assignment_topic="legacy.inventory.parked")
        parked, _, parked_producer, _ = runtime(consumer=parked_broker, producer=FakeProducer(),
                                                admission=api, redrive=True, parked_redrive=True)
        parked.tenant_map.clear()  # Simulate the still-invalid tenant mapping before repair.
        quarantined = RawRecord("legacy.inventory.parked", 0, 22, poison.key, poison.value,
                                tuple(producer.metadata[-1][0]))
        with self.assertRaisesRegex(FatalFailure, "fails normalization"):
            parked.process(quarantined)
        self.assertEqual(parked_broker.commits, [])
        self.assertEqual(parked_producer.messages, [])
        self.assertEqual(api.calls, [])

        # Once the operator corrects the tenant mapping, an explicit parked
        # redrive re-normalizes and admits the exact original source change.
        parked.tenant_map["partner-a"] = TENANT
        parked.process(quarantined)
        self.assertEqual(parked_broker.commits[0].offset, 23)
        self.assertEqual(len(api.calls), 1)

        wrong_reason = RawRecord("legacy.inventory.parked", 0, 23, poison.key, poison.value,
                                 ((PARK_REASON_HEADER, b"parent_dependency"),))
        with self.assertRaisesRegex(FatalFailure, "does not match"):
            parked.process(wrong_reason)
        self.assertEqual(len(parked_broker.commits), 1)

    def test_rebalance_or_shutdown_prevents_commit_after_api_effect(self):
        broker = FakeConsumer()
        api = Admission()
        runner, _, _, _ = runtime(consumer=broker, admission=api)
        def revoked(_change):
            broker.revoke(broker, [SimpleNamespace(topic=TOPIC, partition=0)])
            return None
        api.failure = revoked
        with self.assertRaises(RetryableFailure):
            runner.process(record())
        self.assertEqual(broker.commits, [])
        self.assertEqual(len(api.seen), 1)
        stopped, stopped_broker, _, _ = runtime(running=lambda: False)
        stopped.process(record())
        self.assertEqual(stopped_broker.commits, [])

    def test_run_closes_consumer_on_failure(self):
        class Message:
            def error(self): return None
            def topic(self): return TOPIC
            def partition(self): return 0
            def offset(self): return 42
            def key(self): return b"bad"
            def value(self): return None
            def headers(self): return None
        broker = FakeConsumer([Message()])
        producer = FakeProducer()
        producer.confirm = False
        runner, _, _, _ = runtime(consumer=broker, producer=producer)
        with self.assertRaises(RetryableFailure):
            runner.run()
        self.assertTrue(broker.closed)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.status = 200
        self.problem = {}
        parent = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                body = self.rfile.read(length)
                parent.requests.append((self.path, dict(self.headers), body))
                if self.path == "/token":
                    status, payload = 200, {"access_token": "signed-test-token", "token_type": "Bearer", "expires_in": 3600}
                else:
                    status, payload = parent.status, (parent.problem if parent.status != 200 else {"outcome": "applied"})
                encoded_body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded_body)))
                self.end_headers()
                self.wfile.write(encoded_body)
            def log_message(self, *_args): pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        url = f"http://127.0.0.1:{self.server.server_port}"
        self.client = AdmissionClient(api_url=url + "/v1/internal/inventory/imports",
                                      token_url=url + "/token",
                                      credentials={TENANT: TenantCredential("client", "secret")})

    def _change(self):
        from runtime import normalize_record
        return normalize_record(record(), SOURCE, {"partner-a": TENANT})

    def test_oauth_and_tenant_bound_admission_http_with_exact_offset_string(self):
        from dataclasses import replace
        normalized = self._change()
        coordinate = replace(normalized.source_coordinate, offset=9223372036854775807)
        self.client.admit(replace(normalized, source_coordinate=coordinate))
        self.assertEqual([entry[0] for entry in self.requests], ["/token", "/v1/internal/inventory/imports"])
        self.assertIn("Basic ", self.requests[0][1]["Authorization"])
        self.assertIn("Bearer signed-test-token", self.requests[1][1]["Authorization"])
        self.assertEqual(json.loads(self.requests[1][2])["source_coordinate"]["offset"], "9223372036854775807")
        self.client.admit(normalized)
        self.assertEqual([entry[0] for entry in self.requests].count("/token"), 1)

    def test_parent_dependency_and_poison_statuses(self):
        self.status, self.problem = 422, {"code": "invalid_reference"}
        with self.assertRaisesRegex(PoisonChange, "parent_dependency"):
            self.client.admit(self._change())
        self.status = 409
        with self.assertRaisesRegex(PoisonChange, "admission_http_409"):
            self.client.admit(self._change())
        self.status = 503
        with self.assertRaises(RetryableFailure):
            self.client.admit(self._change())
        self.status = 403
        with self.assertRaises(FatalFailure):
            self.client.admit(self._change())

    def test_nonloopback_http_is_rejected(self):
        with self.assertRaises(ValueError):
            AdmissionClient(api_url="http://external.test/v1/internal/inventory/imports",
                            token_url="https://issuer.test/token", credentials={})


if __name__ == "__main__":
    unittest.main()
