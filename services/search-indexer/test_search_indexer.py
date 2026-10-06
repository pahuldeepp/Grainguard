import importlib.util
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from io import BytesIO
import urllib.error
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("search_indexer", Path(__file__).with_name("search_indexer.py"))
MODULE = importlib.util.module_from_spec(SPEC)
import sys
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

FIXTURES = Path(__file__).resolve().parents[2] / "tests/fixtures/events"


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


class FakeElastic:
    def __init__(self, responses=None):
        self.responses = responses or []
        self.actions = []
        self.documents = {}

    def document(self, index, doc_id):
        return self.documents.get((index, doc_id))

    def bulk(self, actions):
        self.actions.extend(actions)
        return self.responses.pop(0) if self.responses else {"items": [{"index": {"status": 201}} for _ in actions]}


class IndexerTests(unittest.TestCase):
    def test_bootstrap_index_verifies_existing_mapping(self):
        client = MODULE.Elastic("http://127.0.0.1:19200")
        with patch.object(client, "create_index") as create, patch.object(client, "request", return_value={"greenguard-inventory-v1": MODULE.MAPPING}) as request:
            client.bootstrap_index("greenguard-inventory-v1")
        create.assert_called_once_with("greenguard-inventory-v1")
        request.assert_called_once_with("GET", "/greenguard-inventory-v1/_mapping")
        with patch.object(client, "create_index"), patch.object(client, "request", return_value={"greenguard-inventory-v1": {"mappings": {"dynamic": "false"}}}):
            with self.assertRaisesRegex(RuntimeError, "mapping mismatch"):
                client.bootstrap_index("greenguard-inventory-v1")

    def test_search_transport_requires_tls_ca_and_credentials_together(self):
        with self.assertRaisesRegex(ValueError, "HTTPS search requires"):
            MODULE.Elastic("https://search.example")
        with self.assertRaisesRegex(ValueError, "credentials require HTTPS"):
            MODULE.Elastic("http://search.example", "reader", "secret", "/ca.pem")
        with self.assertRaisesRegex(ValueError, "invalid search URL"):
            MODULE.Elastic("https://reader:secret@search.example", "reader", "secret", "/ca.pem")
        context = object()
        with patch.object(MODULE.ssl, "create_default_context", return_value=context) as create_context:
            client = MODULE.Elastic("https://search.example", "reader", "secret", "/ca.pem")
        create_context.assert_called_once_with(cafile="/ca.pem")
        self.assertEqual(client.context, context)
        self.assertTrue(client.authorization.startswith("Basic "))

    def test_binding_feed_checkpoint_is_skipped_but_malformed_marker_holds_offset(self):
        marker = {"event_type": "binding.feed_checkpoint", "schema_version": 1,
                  "source_time": "2026-09-24T10:00:00Z", "source_position": "123",
                  "raw_position": 4, "partitions": 6}
        elastic = FakeElastic()
        with tempfile.TemporaryDirectory() as folder:
            quarantine = Path(folder) / "q.jsonl"
            indexer = MODULE.Indexer(elastic, MODULE.index_name(1), str(quarantine))
            indexer.process([MODULE.Record(MODULE.TOPICS[0], 0, 1, json.dumps(marker).encode())])
            self.assertEqual(elastic.actions, [])
            self.assertFalse(quarantine.exists())
            for invalid in ({**marker, "partitions": 5}, {**marker, "tenant_id": "unexpected"},
                            {**marker, "source_time": "2026-09-24T10:00:00"}):
                record = MODULE.Record(MODULE.TOPICS[0], 0, 2, json.dumps(invalid).encode())
                with self.assertRaisesRegex(RuntimeError, "invalid device event"):
                    indexer.process([record])
            self.assertFalse(quarantine.exists())

    def test_http_adapter_success_not_found_and_failure(self):
        client = MODULE.Elastic("http://example.test/")
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self):
                return b'{"ok":true}'
        with patch.object(MODULE.urllib.request, "urlopen", return_value=Response()) as opened:
            self.assertEqual(client.request("POST", "/test", {"x": 1}), {"ok": True})
            self.assertEqual(opened.call_args.args[0].data, b'{"x": 1}')
        def http_error(code):
            return urllib.error.HTTPError("http://example.test", code, "error", {}, BytesIO(b"missing"))
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=http_error(404)):
            self.assertIsNone(client.document("index", "id"))
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=http_error(503)):
            with self.assertRaises(MODULE.SearchError):
                client.document("index", "id")

    def test_manifest_detects_content_drift_duplicate_and_paginates(self):
        class Client(MODULE.Elastic):
            def __init__(self, pages):
                self.pages = pages
                self.calls = []
            def request(self, method, path, body=None, ndjson=False):
                self.calls.append(body)
                return {"hits": {"hits": self.pages.pop(0)}}
        def hit(n, name):
            source = {"tenant_id": "t", "resource_type": "site", "resource_id": str(n), "name": name}
            return {"_id": f"t:site:{n}", "_version": 1, "_source": source,
                    "sort": ["t", "site", str(n)]}
        client = Client([[hit(i, "name") for i in range(1000)], [hit(1000, "last")]])
        manifest = client.inventory_manifest("index")
        self.assertEqual(len(manifest), 1001)
        self.assertEqual(client.calls[1]["search_after"], ["t", "site", "999"])
        self.assertNotEqual(manifest["t:site:0"]["sha256"], MODULE.document_hash(hit(0, "changed")["_source"]))
        duplicate_client = Client([[hit(0, "one"), hit(0, "two")]])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            duplicate_client.inventory_manifest("index")

    def test_index_creation_bulk_and_count_pages(self):
        class Client(MODULE.Elastic):
            def __init__(self):
                self.calls = []
            def request(self, method, path, body=None, ndjson=False):
                self.calls.append((method, path, body, ndjson))
                if path == "/_bulk":
                    return {"errors": False}
                if path.endswith("/_search"):
                    if len([call for call in self.calls if call[1].endswith("/_search")]) == 1:
                        return {"aggregations": {"tenants": {"buckets": [{"key": {"tenant": "a"}, "doc_count": 2}], "after_key": {"tenant": "a"}}}}
                    return {"aggregations": {"tenants": {"buckets": [{"key": {"tenant": "b"}, "doc_count": 1}]}}}
                return {}
        client = Client()
        client.create_index("inventory")
        self.assertEqual(client.count_by_tenant("inventory"), {"a": 2, "b": 1})
        self.assertEqual(client.bulk([{"meta": {"_index": "inventory", "_id": "x"},
                                       "document": {"name": "hello"}}]), {"errors": False})
        self.assertIn(b'"name":"hello"', client.calls[-1][2])
        self.assertTrue(client.calls[-1][3])


    def test_consume_commits_only_after_processing_and_closes_on_error(self):
        event = fixture("site-changed.v1.valid.json")
        for fail_processing in (False, True):
            calls = []
            message = SimpleNamespace(error=lambda: None, topic=lambda: MODULE.TOPICS[1],
                                      partition=lambda: 0, offset=lambda: 7,
                                      value=lambda: json.dumps(event).encode())

            class Consumer:
                def __init__(self, config):
                    calls.append("init")
                def subscribe(self, topics):
                    calls.append("subscribe")
                def assignment(self):
                    return [SimpleNamespace(topic=MODULE.TOPICS[0], partition=0)]
                def poll(self, timeout):
                    if "polled" in calls:
                        calls.append(MODULE.HEALTH.status("/readyz"))
                        raise RuntimeError("stop")
                    calls.append("polled")
                    return message
                def commit(self, offsets, asynchronous):
                    calls.append("commit")
                    return [SimpleNamespace(error=None)]
                def close(self):
                    calls.append("close")

            class Indexer:
                def __init__(self, *args):
                    pass
                def process(self, records):
                    calls.append("process")
                    if fail_processing:
                        raise RuntimeError("write failed")

            kafka = SimpleNamespace(Consumer=Consumer, TopicPartition=lambda *args: args)
            elastic = SimpleNamespace(bootstrap_index=lambda index: calls.append("index"))
            with patch.dict("os.environ", {"HEALTH_PORT": "0"}, clear=False), \
                 patch.dict(sys.modules, {"confluent_kafka": kafka}), patch.object(MODULE, "Indexer", Indexer):
                with self.assertRaises(RuntimeError):
                    MODULE.consume(elastic, 1, "test-group", "broker", "quarantine")
            self.assertIn("process", calls)
            self.assertEqual("commit" in calls, not fail_processing)
            self.assertEqual(calls[-1], "close")
            self.assertEqual(200 in calls, not fail_processing)
            self.assertEqual(MODULE.HEALTH.status("/readyz"), 503)
            if not fail_processing:
                self.assertLess(calls.index("process"), calls.index("commit"))

    def test_identity_and_tenant_document(self):
        action = MODULE.action_for(fixture("device-registered.v1.valid.json"), MODULE.index_name(1))
        self.assertEqual(action["meta"]["_id"], "11111111-1111-4111-8111-111111111111:device:33333333-3333-4333-8333-333333333333")
        self.assertEqual(action["meta"]["version_type"], "external")
        self.assertEqual(action["document"]["tenant_id"], "11111111-1111-4111-8111-111111111111")

    def test_partial_event_preserves_existing_fields(self):
        event = fixture("device-registered.v1.valid.json")
        event["event_type"] = "device.status_changed"
        event["aggregate_version"] = "8"
        event["payload"] = {"device_id": event["aggregate_id"], "status": "disabled", "binding_version": "8"}
        elastic = FakeElastic()
        doc_id = MODULE.action_for(event, MODULE.index_name(1))["meta"]["_id"]
        elastic.documents[(MODULE.index_name(1), doc_id)] = {"_version": 7, "_source": {"serial_number": "SN-000123", "status": "active"}}
        with tempfile.TemporaryDirectory() as folder:
            MODULE.Indexer(elastic, MODULE.index_name(1), str(Path(folder) / "q.jsonl")).process([
                MODULE.Record(MODULE.TOPICS[0], 0, 1, json.dumps(event).encode())])
        self.assertEqual(elastic.actions[0]["document"]["serial_number"], "SN-000123")
        self.assertEqual(elastic.actions[0]["document"]["status"], "disabled")

    def test_bulk_partial_failure_quarantines_one_and_retries_transient(self):
        elastic = FakeElastic([{"items": [{"index": {"status": 201}}, {"index": {"status": 400, "error": "mapping"}},
                                         {"index": {"status": 429}}]}, {"items": [{"index": {"status": 201}}]}])
        event = fixture("site-changed.v1.valid.json")
        records = [MODULE.Record(MODULE.TOPICS[1], 0, offset, json.dumps({**event, "aggregate_id": str(offset), "payload": {**event["payload"], "site_id": str(offset)}}).encode()) for offset in range(3)]
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "q.jsonl")
            MODULE.Indexer(elastic, MODULE.index_name(1), path).process(records)
            quarantined = [json.loads(line) for line in Path(path).read_text().splitlines()]
        self.assertEqual([item["offset"] for item in quarantined], [1])
        self.assertEqual(len(elastic.actions), 4)

    def test_invalid_identity_is_quarantined(self):
        event = fixture("bin-changed.v1.valid.json")
        event["payload"]["bin_id"] = "wrong"
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "q.jsonl")
            MODULE.Indexer(FakeElastic(), MODULE.index_name(1), path).process([
                MODULE.Record(MODULE.TOPICS[1], 0, 2, json.dumps(event).encode())])
            self.assertIn("aggregate identity mismatch", Path(path).read_text())

    def test_query_always_filters_tenant_and_promotion_is_atomic(self):
        class Client(MODULE.Elastic):
            def __init__(self):
                self.calls = []
            def request(self, method, path, body=None, ndjson=False):
                self.calls.append((method, path, body))
                if path.endswith("/_settings/index.blocks.write"):
                    return {target_index: {"settings": {}}}
                if path.endswith("/_block/write"):
                    return {"acknowledged": True, "shards_acknowledged": True}
                if path.startswith("/_alias"):
                    return {"greenguard-inventory-v1": {}}
                return {}
            def inventory_manifest(self, index):
                return {"tenant-a:site:a": {"version": 2, "sha256": MODULE.document_hash({"name": "right"})}}
        client = Client()
        client.search("tenant-a", "north")
        self.assertEqual(client.calls[0][2]["query"]["bool"]["filter"], [{"term": {"tenant_id": "tenant-a"}}])
        self.assertEqual(client.calls[0][2]["query"]["bool"]["must"], [{"multi_match": {"query": "north", "fields": ["name", "serial_number", "resource_id"]}}])
        with self.assertRaises(ValueError):
            client.search("", "north")
        target_index = MODULE.index_name(2)
        wrong_manifest = {"tenant-a:site:a": {"version": 2, "sha256": MODULE.document_hash({"name": "wrong"})}}
        with self.assertRaises(ValueError):
            client.promote(target_index, wrong_manifest)
        self.assertFalse(any(path == "/_aliases" for _, path, _ in client.calls))
        self.assertEqual(client.calls[-1], ("PUT", f"/{target_index}/_settings", {"index.blocks.write": False}))
        client.promote(MODULE.index_name(2), {"tenant-a:site:a": {"version": 2, "sha256": MODULE.document_hash({"name": "right"})}})
        alias_call = next(body for _, path, body in client.calls if path == "/_aliases")
        actions = alias_call["actions"]
        self.assertEqual(actions, [{"remove": {"index": "greenguard-inventory-v1", "alias": MODULE.ALIAS}},
                                   {"add": {"index": "greenguard-inventory-v2", "alias": MODULE.ALIAS}}])
        paths = [path for _, path, _ in client.calls]
        self.assertLess(paths.index(f"/{target_index}/_block/write"), paths.index(f"/{target_index}/_refresh"))
        self.assertLess(paths.index("/_aliases"), len(paths) - 1)

    def test_promotion_preserves_preexisting_write_block_and_requires_shard_ack(self):
        target = MODULE.index_name(2)
        class Client(MODULE.Elastic):
            def __init__(self, blocked, acknowledged):
                self.blocked, self.acknowledged, self.calls = blocked, acknowledged, []
            def request(self, method, path, body=None, ndjson=False):
                self.calls.append((method, path, body))
                if path.endswith("/_settings/index.blocks.write"):
                    return {target: {"settings": {"index": {"blocks": {"write": "true"}}}}} if self.blocked else {target: {"settings": {}}}
                if path.endswith("/_block/write"):
                    return {"acknowledged": self.acknowledged, "shards_acknowledged": self.acknowledged}
                if path == "/_aliases":
                    raise RuntimeError("alias switch failed")
                if path.startswith("/_alias"):
                    return {}
                return {}
            def inventory_manifest(self, index):
                return {}
        blocked = Client(True, True)
        with self.assertRaisesRegex(RuntimeError, "alias switch failed"):
            blocked.promote(target, {})
        self.assertFalse(any(path.endswith("/_settings") for _, path, _ in blocked.calls))
        incomplete = Client(False, False)
        with self.assertRaisesRegex(RuntimeError, "not acknowledged"):
            incomplete.promote(target, {})
        self.assertEqual(incomplete.calls[-1], ("PUT", f"/{target}/_settings", {"index.blocks.write": False}))
        self.assertFalse(any(path == "/_aliases" for _, path, _ in incomplete.calls))

    def test_write_block_failure_holds_kafka_offset_without_quarantine(self):
        elastic = FakeElastic([{"items": [{"index": {"status": 403, "error": {"type": "cluster_block_exception"}}}]}])
        event = fixture("site-changed.v1.valid.json")
        with tempfile.TemporaryDirectory() as folder:
            quarantine = Path(folder) / "q.jsonl"
            indexer = MODULE.Indexer(elastic, MODULE.index_name(2), str(quarantine))
            record = MODULE.Record(MODULE.TOPICS[1], 0, 10, json.dumps(event).encode())
            with self.assertRaisesRegex(RuntimeError, "index writes unavailable"):
                indexer.process([record])
            self.assertFalse(quarantine.exists())

    def test_bad_device_event_and_permanent_device_bulk_error_hold_offset(self):
        with tempfile.TemporaryDirectory() as folder:
            quarantine = Path(folder) / "q.jsonl"
            indexer = MODULE.Indexer(FakeElastic(), MODULE.index_name(1), str(quarantine))
            malformed = MODULE.Record(MODULE.TOPICS[0], 0, 11, b"not-json")
            with self.assertRaisesRegex(RuntimeError, "invalid device event"):
                indexer.process([malformed])
            event = fixture("device-registered.v1.valid.json")
            failed = FakeElastic([{"items": [{"index": {"status": 400, "error": "mapping"}}]}])
            failed_indexer = MODULE.Indexer(failed, MODULE.index_name(1), str(quarantine))
            record = MODULE.Record(MODULE.TOPICS[0], 0, 12, json.dumps(event).encode())
            with self.assertRaisesRegex(RuntimeError, "device index failure 400"):
                failed_indexer.process([record])
            self.assertFalse(quarantine.exists())

    def test_network_bulk_errors_retry_without_committing_failed_attempt(self):
        event = fixture("site-changed.v1.valid.json")
        record = MODULE.Record(MODULE.TOPICS[1], 0, 5, json.dumps(event).encode())
        elastic = FakeElastic()
        with tempfile.TemporaryDirectory() as folder:
            indexer = MODULE.Indexer(elastic, MODULE.index_name(1), str(Path(folder) / "q.jsonl"))
            with patch.object(elastic, "bulk", side_effect=[urllib.error.URLError("offline"),
                                                            {"items": [{"index": {"status": 201}}]}]) as bulk, \
                 patch.object(MODULE.time, "sleep"):
                indexer.process([record])
                self.assertEqual(bulk.call_count, 2)
            with patch.object(elastic, "bulk", side_effect=TimeoutError("timeout")) as bulk, \
                 patch.object(MODULE.time, "sleep"):
                with self.assertRaises(TimeoutError):
                    indexer.process([record])
                self.assertEqual(bulk.call_count, 5)

    def test_same_version_conflicting_document_holds_offset(self):
        event = fixture("site-changed.v1.valid.json")
        action = MODULE.action_for(event, MODULE.index_name(1))
        elastic = FakeElastic([{"items": [{"index": {"status": 409}}]}])
        elastic.documents[(MODULE.index_name(1), action["meta"]["_id"])] = {
            "_version": action["meta"]["version"],
            "_source": {**action["document"], "name": "conflicting name"},
        }
        with tempfile.TemporaryDirectory() as folder:
            indexer = MODULE.Indexer(elastic, MODULE.index_name(1), str(Path(folder) / "q.jsonl"))
            records = [MODULE.Record(MODULE.TOPICS[1], 0, 4, json.dumps(event).encode())]
            with self.assertRaisesRegex(RuntimeError, "external-version collision"):
                indexer.process(records)

    def test_same_partial_event_is_noop_and_stale_event_is_ignored(self):
        event = fixture("device-registered.v1.valid.json")
        event["event_type"] = "device.status_changed"
        event["aggregate_version"] = "8"
        event["payload"] = {"device_id": event["aggregate_id"], "status": "disabled"}
        action = MODULE.action_for(event, MODULE.index_name(1))
        elastic = FakeElastic()
        elastic.documents[(MODULE.index_name(1), action["meta"]["_id"])] = {
            "_version": 8,
            "_source": {**action["document"], "serial_number": "SN-000123"},
        }
        record = MODULE.Record(MODULE.TOPICS[0], 0, 10, json.dumps(event).encode())
        with tempfile.TemporaryDirectory() as folder:
            MODULE.Indexer(elastic, MODULE.index_name(1), str(Path(folder) / "q.jsonl")).process([record, record])
            event["aggregate_version"] = "7"
            MODULE.Indexer(elastic, MODULE.index_name(1), str(Path(folder) / "q.jsonl")).process([
                MODULE.Record(MODULE.TOPICS[0], 0, 11, json.dumps(event).encode())])
            self.assertFalse(Path(folder, "q.jsonl").exists())
        self.assertEqual(elastic.actions, [])

    def test_device_partial_update_waits_for_predecessor(self):
        event = fixture("device-registered.v1.valid.json")
        event["event_type"] = "device.status_changed"
        event["aggregate_version"] = "8"
        event["payload"] = {"device_id": event["aggregate_id"], "status": "disabled"}
        elastic = FakeElastic()
        record = MODULE.Record(MODULE.TOPICS[0], 0, 9, json.dumps(event).encode())
        with tempfile.TemporaryDirectory() as folder:
            indexer = MODULE.Indexer(elastic, MODULE.index_name(1), str(Path(folder) / "q.jsonl"))
            with self.assertRaisesRegex(RuntimeError, "missing device predecessor"):
                indexer.process([record])
        self.assertEqual(elastic.actions, [])

    def test_bulk_conflict_rechecks_current_document(self):
        event = fixture("site-changed.v1.valid.json")
        action = MODULE.action_for(event, MODULE.index_name(1))
        record = MODULE.Record(MODULE.TOPICS[1], 0, 4, json.dumps(event).encode())
        cases = [
            ({"_version": action["meta"]["version"] + 1}, False),
            ({"_version": action["meta"]["version"], "_source": action["document"]}, False),
            ({"_version": action["meta"]["version"], "_source": {}}, True),
            (None, True),
        ]
        with tempfile.TemporaryDirectory() as folder:
            for current, fails in cases:
                with self.subTest(current=current):
                    elastic = FakeElastic([{"items": [{"index": {"status": 409}}]}])
                    indexer = MODULE.Indexer(elastic, MODULE.index_name(1), str(Path(folder) / "q.jsonl"))
                    with patch.object(elastic, "document", side_effect=[None, current]):
                        if fails:
                            with self.assertRaisesRegex(ValueError, "external-version collision"):
                                indexer.process([record])
                        else:
                            indexer.process([record])
                    self.assertFalse(Path(folder, "q.jsonl").exists())

    def test_bulk_http_errors_preserve_retry_schedule_and_exception(self):
        event = fixture("site-changed.v1.valid.json")
        record = MODULE.Record(MODULE.TOPICS[1], 0, 4, json.dumps(event).encode())
        with tempfile.TemporaryDirectory() as folder:
            indexer = MODULE.Indexer(FakeElastic(), MODULE.index_name(1), str(Path(folder) / "q.jsonl"))
            for status, attempts in ((400, 1), (503, 5)):
                with self.subTest(status=status):
                    error = MODULE.SearchError(status, "failure")
                    with patch.object(indexer.elastic, "bulk", side_effect=error) as bulk, patch.object(MODULE.time, "sleep") as sleep:
                        with self.assertRaises(MODULE.SearchError) as caught:
                            indexer.process([record])
                    self.assertIs(caught.exception, error)
                    self.assertEqual(bulk.call_count, attempts)
                    self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2, 4, 8][:attempts - 1])

    def test_bulk_exhaustion_mismatch_and_quarantine_failure_propagate(self):
        event = fixture("site-changed.v1.valid.json")
        record = MODULE.Record(MODULE.TOPICS[1], 0, 4, json.dumps(event).encode())
        cases = [
            ([{"items": []}], ValueError, "bulk response item count mismatch", []),
            ([{"items": [{"index": {"status": 429}}]}] * 5, RuntimeError,
             "transient bulk failures exhausted; offsets remain uncommitted", [1, 2, 4, 8]),
            ([{"items": [{"index": {"status": 400}}]}], OSError, "disk full", []),
        ]
        with tempfile.TemporaryDirectory() as folder:
            for responses, error_type, message, delays in cases:
                with self.subTest(message=message):
                    indexer = MODULE.Indexer(FakeElastic(responses), MODULE.index_name(1), str(Path(folder) / "q.jsonl"))
                    with patch.object(MODULE.time, "sleep") as sleep, patch.object(indexer, "quarantine", side_effect=OSError("disk full")):
                        with self.assertRaisesRegex(error_type, message):
                            indexer.process([record])
                    self.assertEqual([call.args[0] for call in sleep.call_args_list], delays)


if __name__ == "__main__":
    unittest.main()

class TopicNamespaceTests(unittest.TestCase):
    def test_inventory_namespace(self):
        module = MODULE
        self.assertEqual(module.inventory_topics('provisioning-demo.'), ('provisioning-demo.greenguard.inventory.device.v1', 'provisioning-demo.greenguard.inventory.facility.v1'))
        self.assertEqual(module.inventory_topics(''), ('greenguard.inventory.device.v1', 'greenguard.inventory.facility.v1'))
        for prefix in ['bad/topic', 'bad space', '\t', 'é', 'x' * 249]:
            with self.assertRaises(ValueError):
                module.inventory_topics(prefix)
