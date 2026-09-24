"""Optional live Kafka -> consumer -> Elasticsearch path, using isolated IDs."""

import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

from confluent_kafka import Producer
os.environ["SEARCH_ALIAS"] = f"greenguard-inventory-kafka-test-{uuid.uuid4().hex[:12]}"
from search_indexer import Elastic, TOPICS, index_name


def run():
    bootstrap = os.getenv("KAFKA_BOOTSTRAP", "127.0.0.1:59092")
    elastic = Elastic(os.getenv("ELASTICSEARCH_URL", "http://127.0.0.1:19200"))
    tenant, resource = str(uuid.uuid4()), str(uuid.uuid4())
    version = uuid.uuid4().int % 1000000000 + 2000000000
    index = index_name(version)
    group = f"greenguard.search-indexer.test.{uuid.uuid4()}"
    fixture = Path(__file__).resolve().parents[2] / "tests/fixtures/events/site-changed.v1.valid.json"
    event = json.loads(fixture.read_text())
    event.update({"event_id": str(uuid.uuid4()), "tenant_id": tenant, "aggregate_id": resource})
    event["payload"].update({"site_id": resource, "name": "Kafka Search Gate"})
    command = [sys.executable, str(Path(__file__).with_name("search_indexer.py")), "consume",
               "--version", str(version), "--group", group, "--bootstrap", bootstrap,
               "--offset-reset", "latest"]
    consumer = None
    try:
        elastic.create_index(index)
        consumer = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        producer = Producer({"bootstrap.servers": bootstrap})
        # The new group must finish assignment before its first event; repeat
        # the same deterministic event until indexed if assignment is delayed.
        deadline = time.monotonic() + 30
        doc_id = f"{tenant}:site:{resource}"
        while time.monotonic() < deadline:
            producer.produce(TOPICS[1], key=f"{tenant}:{resource}".encode(), value=json.dumps(event).encode())
            producer.flush(10)
            found = elastic.document(index, doc_id)
            if found:
                assert found["_source"]["tenant_id"] == tenant
                print("PASS: Kafka facility event consumed and indexed with tenant identity")
                return
            if consumer.poll() is not None:
                raise RuntimeError(f"consumer exited: {consumer.stderr.read().decode()}")
            time.sleep(0.5)
        raise TimeoutError("Kafka event was not indexed within 30 seconds")
    finally:
        if consumer is not None:
            consumer.terminate()
            try:
                consumer.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                consumer.kill()
                consumer.communicate()
        try:
            elastic.request("DELETE", f"/{index}")
        except Exception as exc:
            print(f"search test index cleanup failed: {exc}", file=sys.stderr)
            raise


if __name__ == "__main__":
    run()
