"""Live Elasticsearch acceptance checks; run with the search Compose overlay."""

import json
import os
import tempfile
import time
import urllib.error
import uuid
from pathlib import Path

os.environ["SEARCH_ALIAS"] = f"greenguard-inventory-test-{uuid.uuid4().hex[:12]}"
from search_indexer import ALIAS, Elastic, Indexer, Record, SearchError, TOPICS, action_for, document_hash, index_name

FIXTURES = Path(__file__).resolve().parents[2] / "tests/fixtures/events"


def event(filename, tenant, resource, version):
    item = json.loads((FIXTURES / filename).read_text())
    item["tenant_id"] = tenant
    item["aggregate_id"] = resource
    item["aggregate_version"] = str(version)
    item["payload"][f"{item['aggregate_type']}_id"] = resource
    return item


def create_index_after_startup(elastic, index):
    """Elasticsearch can answer health probes before its first mapping write is ready."""
    deadline = time.monotonic() + 120
    last_error = None
    while True:
        try:
            elastic.create_index(index)
            health = elastic.request("GET", f"/_cluster/health/{index}?wait_for_status=yellow&timeout=10s")
            if not health.get("timed_out") and health.get("status") in ("yellow", "green"):
                return
            last_error = health
        except (TimeoutError, urllib.error.URLError, SearchError) as exc:
            if isinstance(exc, SearchError) and exc.status not in (408, 429, 500, 502, 503, 504):
                raise
            last_error = exc
        if time.monotonic() >= deadline:
            try:
                allocation = elastic.request("GET", "/_cluster/allocation/explain")
            except (TimeoutError, urllib.error.URLError, SearchError) as exc:
                allocation = exc
            raise TimeoutError(
                f"index {index} did not acquire an active shard; "
                f"last health/error={last_error}; allocation={allocation}"
            )
        time.sleep(2)


def run():
    elastic = Elastic(os.getenv("ELASTICSEARCH_URL", "http://127.0.0.1:19200"))
    suffix = int(os.getenv("SEARCH_TEST_VERSION", str(uuid.uuid4().int % 1000000000 + 900000000)))
    first, second = index_name(suffix), index_name(suffix + 1)
    tenant_a, tenant_b = str(uuid.uuid4()), str(uuid.uuid4())
    resource_a, resource_b = str(uuid.uuid4()), str(uuid.uuid4())
    events = [event("site-changed.v1.valid.json", tenant_a, resource_a, 1),
              event("site-changed.v1.valid.json", tenant_b, resource_b, 1)]
    events[0]["payload"]["name"] = "Unique North Site"
    events[1]["payload"]["name"] = "Unique North Site"
    with tempfile.TemporaryDirectory() as folder:
        records = [Record(TOPICS[1], 0, i, json.dumps(item).encode()) for i, item in enumerate(events)]
        for index in (first, second):
            create_index_after_startup(elastic, index)
            indexer = Indexer(elastic, index, str(Path(folder) / "quarantine.jsonl"))
            indexer.process(records)
            indexer.process(records)  # external-version conflicts are idempotent
        expected = {}
        for item in events:
            action = action_for(item, first)
            expected[action["meta"]["_id"]] = {
                "version": action["meta"]["version"],
                "sha256": document_hash(action["document"]),
            }
        try:
            elastic.promote(first, {})
        except ValueError as exc:
            assert "inventory manifest mismatch" in str(exc)
        else:
            raise AssertionError("mismatched manifest was accepted")
        assert not elastic.write_blocked(first)
        elastic.promote(first, expected)
        assert not elastic.write_blocked(first)
        response = elastic.search(tenant_a, "Unique North Site")
        hits = response["hits"]["hits"]
        assert len(hits) == 1
        assert hits[0]["_source"]["tenant_id"] == tenant_a
        elastic.promote(second, expected)
        assert not elastic.write_blocked(second)
        assert elastic.search(tenant_b, "Unique North Site")["hits"]["total"]["value"] == 1
        assert not Path(folder, "quarantine.jsonl").exists()
    print("PASS: live index, replay idempotence, tenant isolation, identity/version/content comparison, alias swap")


if __name__ == "__main__":
    run()
