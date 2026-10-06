"""Inventory-only Kafka projection into a versioned Elasticsearch index."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime
import hashlib
import json
import os
import re
import signal
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any
from worker_health import WorkerHealth, start_health_server

ALIAS = os.getenv("SEARCH_ALIAS", "greenguard-inventory")
def inventory_topics(prefix: str) -> tuple[str, str]:
    names = ("greenguard.inventory.device.v1", "greenguard.inventory.facility.v1")
    if (prefix and not re.fullmatch(r"[A-Za-z0-9._-]+", prefix)) or any(len(prefix + name) > 249 for name in names):
        raise ValueError("invalid KAFKA_TOPIC_PREFIX")
    return tuple(prefix + name for name in names)

TOPICS = inventory_topics(os.getenv("KAFKA_TOPIC_PREFIX", ""))
CHECKPOINT_FIELDS = {"event_type", "schema_version", "source_time", "source_position", "raw_position", "partitions"}
MAPPING = {"mappings": {"dynamic": "strict", "properties": {
    "tenant_id": {"type": "keyword"}, "resource_type": {"type": "keyword"},
    "resource_id": {"type": "keyword"}, "name": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
    "serial_number": {"type": "keyword"}, "status": {"type": "keyword"},
    "site_id": {"type": "keyword"}, "bin_id": {"type": "keyword"},
    "updated_at": {"type": "date"},
}}}
HEALTH = WorkerHealth()
HEALTH_SERVER = None


def ensure_health_server() -> None:
    global HEALTH_SERVER
    if HEALTH_SERVER is None:
        HEALTH_SERVER = start_health_server(HEALTH, port=int(os.getenv("HEALTH_PORT", "8080")))


def document_hash(document: dict[str, Any]) -> str:
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class SearchError(Exception):
    def __init__(self, status: int, body: Any):
        super().__init__(f"Elasticsearch HTTP {status}: {body}")
        self.status = status
        self.body = body


def transient_bulk_error(error: SearchError | urllib.error.URLError | TimeoutError) -> bool:
    return not isinstance(error, SearchError) or error.status in (429, 500, 502, 503, 504)


class Elastic:
    def __init__(self, url: str, username: str | None = None, password: str | None = None,
                 ca_file: str | None = None):
        self.url = url.rstrip("/")
        parsed = urllib.parse.urlsplit(self.url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("invalid search URL")
        if parsed.scheme == "https" and (not username or not password or not ca_file):
            raise ValueError("HTTPS search requires username, password and CA file")
        if parsed.scheme == "http" and (username or password or ca_file):
            raise ValueError("search credentials require HTTPS")
        self.context = ssl.create_default_context(cafile=ca_file) if ca_file else None
        self.authorization = ("Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()) if username else None

    def request(self, method: str, path: str, body: Any = None, ndjson: bool = False) -> Any:
        data = None
        if body is not None:
            data = body if ndjson else json.dumps(body).encode()
        headers = {"Content-Type": "application/x-ndjson" if ndjson else "application/json"}
        if self.authorization:
            headers["Authorization"] = self.authorization
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20, context=self.context) as response:
                content = response.read()
                return json.loads(content) if content else {}
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode()
            finally:
                exc.close()
            raise SearchError(exc.code, body) from exc

    def create_index(self, index: str) -> None:
        try:
            self.request("PUT", f"/{index}", MAPPING)
        except SearchError as exc:
            if exc.status != 400 or "resource_already_exists_exception" not in str(exc.body):
                raise

    def bootstrap_index(self, index: str) -> None:
        self.create_index(index)
        actual = self.request("GET", f"/{index}/_mapping")
        mapping = actual.get(index, {}).get("mappings", {})
        if mapping.get("dynamic") != "strict" or mapping.get("properties") != MAPPING["mappings"]["properties"]:
            raise RuntimeError("inventory index mapping mismatch")

    def bulk(self, actions: list[dict[str, Any]]) -> dict[str, Any]:
        lines = []
        for action in actions:
            lines.append(json.dumps({"index": action["meta"]}, separators=(",", ":")))
            lines.append(json.dumps(action["document"], separators=(",", ":")))
        return self.request("POST", "/_bulk", ("\n".join(lines) + "\n").encode(), ndjson=True)

    def document(self, index: str, doc_id: str) -> dict[str, Any] | None:
        try:
            return self.request("GET", f"/{index}/_doc/{urllib.parse.quote(doc_id, safe='')}")
        except SearchError as exc:
            if exc.status == 404:
                return None
            raise

    def search(self, tenant_id: str, query: str, index: str = ALIAS) -> Any:
        # All public queries pass through this function; the tenant filter cannot be omitted.
        if not tenant_id:
            raise ValueError("tenant_id required")
        return self.request("POST", f"/{index}/_search", {"query": {"bool": {
            "filter": [{"term": {"tenant_id": tenant_id}}],
            "must": [{"multi_match": {"query": query, "fields": ["name", "serial_number", "resource_id"]}}]
        }}})

    def count_by_tenant(self, index: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        after = None
        while True:
            composite = {"size": 1000, "sources": [{"tenant": {"terms": {"field": "tenant_id"}}}]}
            if after:
                composite["after"] = after
            response = self.request("POST", f"/{index}/_search", {"size": 0,
                "aggs": {"tenants": {"composite": composite}}})
            page = response["aggregations"]["tenants"]
            counts.update({item["key"]["tenant"]: item["doc_count"] for item in page["buckets"]})
            after = page.get("after_key")
            if not after:
                return counts

    def inventory_manifest(self, index: str) -> dict[str, dict[str, Any]]:
        """Return every document identity, version, and canonical content hash."""
        manifest: dict[str, dict[str, Any]] = {}
        after = None
        while True:
            body: dict[str, Any] = {"size": 1000, "version": True,
                "sort": [{"tenant_id": "asc"}, {"resource_type": "asc"}, {"resource_id": "asc"}]}
            if after is not None:
                body["search_after"] = after
            hits = self.request("POST", f"/{index}/_search", body)["hits"]["hits"]
            for hit in hits:
                source = hit["_source"]
                identity = f"{source['tenant_id']}:{source['resource_type']}:{source['resource_id']}"
                if hit["_id"] != identity or identity in manifest:
                    raise ValueError(f"invalid or duplicate search identity: {identity}")
                manifest[identity] = {"version": hit["_version"], "sha256": document_hash(source)}
            if len(hits) < 1000:
                return manifest
            after = hits[-1]["sort"]

    def write_blocked(self, index: str) -> bool:
        settings = self.request("GET", f"/{index}/_settings/index.blocks.write")
        return settings.get(index, {}).get("settings", {}).get("index", {}).get("blocks", {}).get("write") == "true"

    def promote(self, index: str, expected: dict[str, dict[str, Any]]) -> None:
        was_blocked = self.write_blocked(index)
        try:
            # Unlike a settings update, the add-block API waits for in-flight
            # writes to finish before it acknowledges all shards.
            block = self.request("PUT", f"/{index}/_block/write")
            if not block.get("acknowledged") or not block.get("shards_acknowledged"):
                raise RuntimeError("target write block was not acknowledged by all shards")
            self.request("POST", f"/{index}/_refresh")
            actual = self.inventory_manifest(index)
            if actual != expected:
                missing = sorted(expected.keys() - actual.keys())
                extra = sorted(actual.keys() - expected.keys())
                changed = sorted(key for key in expected.keys() & actual.keys() if expected[key] != actual[key])
                raise ValueError(f"inventory manifest mismatch: missing={len(missing)} extra={len(extra)} changed={len(changed)} sample={(missing + extra + changed)[:5]}")
            try:
                aliases = self.request("GET", f"/_alias/{ALIAS}")
            except SearchError as exc:
                if exc.status != 404:
                    raise
                aliases = {}
            actions = [{"remove": {"index": old, "alias": ALIAS}} for old in aliases]
            actions.append({"add": {"index": index, "alias": ALIAS}})
            self.request("POST", "/_aliases", {"actions": actions})
        finally:
            if not was_blocked:
                self.request("PUT", f"/{index}/_settings", {"index.blocks.write": False})


def index_name(version: int) -> str:
    if version < 1:
        raise ValueError("version must be positive")
    return f"{ALIAS}-v{version}"


def action_for(event: dict[str, Any], index: str) -> dict[str, Any]:
    kind = event["aggregate_type"]
    event_type = event["event_type"]
    allowed = {"device": {"device.registered", "device.status_changed", "device.binding_changed"},
               "site": {"site.changed"}, "bin": {"bin.changed"}}
    if kind not in allowed or event_type not in allowed[kind]:
        raise ValueError(f"unsupported inventory event: {kind}/{event_type}")
    tenant = event["tenant_id"]
    resource = event["aggregate_id"]
    payload = event["payload"]
    if payload[f"{kind}_id"] != resource:
        raise ValueError("aggregate identity mismatch")
    version = int(event["aggregate_version"])
    if version < 1 or version > 9223372036854775807:
        raise ValueError("aggregate version must be positive")
    document = {"tenant_id": tenant, "resource_type": kind, "resource_id": resource,
                "updated_at": event["occurred_at"]}
    for field in ("name", "serial_number", "status", "site_id", "bin_id"):
        if field in payload and payload[field] is not None:
            document[field] = payload[field]
    return {"meta": {"_index": index, "_id": f"{tenant}:{kind}:{resource}",
                     "version": version, "version_type": "external"}, "document": document}


@dataclass
class Record:
    topic: str
    partition: int
    offset: int
    value: bytes


def validate_checkpoint(event: dict[str, Any], record: Record) -> None:
    if (record.topic != TOPICS[0] or set(event) != CHECKPOINT_FIELDS or
        type(event.get("schema_version")) is not int or event["schema_version"] != 1 or
        type(event.get("partitions")) is not int or event["partitions"] != 6 or
        not isinstance(event.get("raw_position"), int) or isinstance(event.get("raw_position"), bool) or
        event["raw_position"] < 0 or not isinstance(event.get("source_position"), str) or
        not event["source_position"].isdigit() or int(event["source_position"]) < 1 or
        not isinstance(event.get("source_time"), str)):
        raise ValueError("invalid binding feed checkpoint")
    try:
        if datetime.fromisoformat(event["source_time"].replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("checkpoint time has no timezone")
    except ValueError as exc:
        raise ValueError("invalid binding feed checkpoint") from exc


class Indexer:
    def __init__(self, elastic: Elastic, index: str, quarantine_path: str):
        self.elastic, self.index, self.quarantine_path = elastic, index, quarantine_path

    def quarantine(self, record: Record, reason: str) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(self.quarantine_path)), exist_ok=True)
        entry = {"topic": record.topic, "partition": record.partition, "offset": record.offset,
                 "reason": reason, "value": record.value.decode("utf-8", errors="replace")}
        with open(self.quarantine_path, "a", encoding="utf-8") as file:
            file.write(json.dumps(entry) + "\n")
            file.flush()
            os.fsync(file.fileno())

    def _prepare_action(self, record: Record) -> dict[str, Any] | None:
        event = json.loads(record.value)
        if isinstance(event, dict) and event.get("event_type") == "binding.feed_checkpoint":
            # CDC places this internal progress marker on every device-topic
            # partition for the binding feed. It is not a searchable device.
            validate_checkpoint(event, record)
            return None
        action = action_for(event, self.index)
        old = self.elastic.document(self.index, action["meta"]["_id"])
        action["incoming"] = dict(action["document"])
        if old:
            current_version = old.get("_version", 0)
            incoming_version = action["meta"]["version"]
            if current_version > incoming_version:
                return None
            if current_version == incoming_version:
                if all(old["_source"].get(key) == value for key, value in action["incoming"].items()):
                    return None
                raise RuntimeError(f"external-version collision at {record.topic}/{record.partition}@{record.offset}")
        self._check_predecessor(event, old, action, record)
        if old and old.get("_version", 0) < action["meta"]["version"]:
            action["document"] = {**old["_source"], **action["document"]}
        return action

    def _check_predecessor(self, event, old, action, record: Record) -> None:
        if event["aggregate_type"] == "device" and event["event_type"] != "device.registered":
            current_version = old.get("_version", 0) if old else 0
            incoming_version = action["meta"]["version"]
            if incoming_version > current_version and current_version != incoming_version - 1:
                raise RuntimeError(f"missing device predecessor at {record.topic}/{record.partition}@{record.offset}")

    def _check_conflict(self, record: Record, action: dict[str, Any]) -> None:
        current = self.elastic.document(self.index, action["meta"]["_id"])
        target_version = action["meta"]["version"]
        if current and (current.get("_version", 0) > target_version or
                        (current.get("_version") == target_version and
                         all(current.get("_source", {}).get(key) == value
                             for key, value in action["incoming"].items()))):
            return
        raise ValueError(f"external-version collision at {record.topic}/{record.partition}@{record.offset}")

    def _bulk_retries(self, pending, response):
        items = response.get("items", [])
        if len(items) != len(pending):
            raise ValueError("bulk response item count mismatch")
        retry = []
        for (record, action), item in zip(pending, items):
            result = item["index"]
            status = result["status"]
            if status in (200, 201):
                continue
            if status == 409:
                self._check_conflict(record, action)
                continue
            if status in (401, 403):
                # A temporary promotion write block (or permission failure)
                # must hold this offset; quarantine plus commit would lose it.
                raise RuntimeError(f"index writes unavailable ({status}) at {record.topic}/{record.partition}@{record.offset}")
            if status in (429, 500, 502, 503, 504):
                retry.append((record, action))
            else:
                if record.topic == TOPICS[0]:
                    raise RuntimeError(f"device index failure {status} at {record.topic}/{record.partition}@{record.offset}: {result.get('error')}")
                self.quarantine(record, f"index failure {status}: {result.get('error')}")
        return retry

    def _process_pending(self, pending) -> None:
        for attempt in range(5):
            try:
                response = self.elastic.bulk([action for _, action in pending])
            except (SearchError, urllib.error.URLError, TimeoutError) as exc:
                if attempt == 4 or not transient_bulk_error(exc):
                    raise
                time.sleep(min(2 ** attempt, 8))
                continue
            retry = self._bulk_retries(pending, response)
            if not retry:
                return
            pending = retry
            if attempt < 4:
                time.sleep(min(2 ** attempt, 8))
        raise RuntimeError("transient bulk failures exhausted; offsets remain uncommitted")

    def process(self, records: list[Record]) -> None:
        pending = []
        for record in records:
            try:
                action = self._prepare_action(record)
                if action is not None:
                    pending.append((record, action))
            except (ValueError, KeyError, TypeError) as exc:
                if record.topic == TOPICS[0]:
                    raise RuntimeError(f"invalid device event at {record.topic}/{record.partition}@{record.offset}: {exc}") from exc
                self.quarantine(record, f"invalid event: {exc}")
        if pending:
            self._process_pending(pending)


def consume(elastic: Elastic, version: int, group: str, bootstrap: str, quarantine: str,
            offset_reset: str = "earliest") -> None:
    from confluent_kafka import Consumer, TopicPartition  # imported only by the live runner

    ensure_health_server()
    HEALTH.set_ready(False)
    HEALTH.heartbeat()

    protocol = os.getenv("KAFKA_SECURITY_PROTOCOL", "").strip().upper()
    mechanism = os.getenv("KAFKA_SASL_MECHANISM", "").strip().upper()
    user, password, ca_file = (os.getenv(name, "") for name in
                               ("KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "KAFKA_TLS_CA_FILE"))
    required = os.getenv("KAFKA_REQUIRE_TLS", "").lower() == "true"
    security = {}
    if any((required, protocol, mechanism, user, password, ca_file)):
        if protocol != "SASL_SSL" or mechanism != "PLAIN" or not all((user, password, ca_file)):
            raise ValueError("Kafka requires SASL_SSL, PLAIN credentials, and a TLS CA file")
        ssl.create_default_context(cafile=ca_file)
        security = {"security.protocol": "SASL_SSL", "sasl.mechanism": "PLAIN",
                    "sasl.username": user, "sasl.password": password, "ssl.ca.location": ca_file,
                    "enable.ssl.certificate.verification": True}
    index = index_name(version)
    # Existing indices must have the expected strict mapping before the worker
    # becomes ready to consume and commit offsets.
    elastic.bootstrap_index(index)
    consumer = Consumer({"bootstrap.servers": bootstrap, "group.id": group,
                         "enable.auto.commit": False, "auto.offset.reset": offset_reset, **security})
    consumer.subscribe(list(TOPICS))
    indexer = Indexer(elastic, index, quarantine)
    stopping = False
    def stop(_signum: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    for sig in previous:
        signal.signal(sig, stop)
    try:
        while not stopping:
            message = consumer.poll(1)
            HEALTH.heartbeat()
            HEALTH.set_ready(bool(consumer.assignment()))
            if message is None:
                continue
            if message.error():
                raise RuntimeError(message.error())
            record = Record(message.topic(), message.partition(), message.offset(), message.value())
            indexer.process([record])
            committed = consumer.commit(offsets=[TopicPartition(record.topic, record.partition, record.offset + 1)], asynchronous=False)
            if not committed or any(item.error for item in committed):
                raise RuntimeError(f"Kafka offset commit failed: {committed}")
            HEALTH.heartbeat()
    finally:
        HEALTH.set_ready(False)
        consumer.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("consume")
    run.add_argument("--version", type=int, required=True)
    run.add_argument("--group", default="greenguard.search-indexer.v1")
    run.add_argument("--bootstrap", default="127.0.0.1:59092")
    run.add_argument("--quarantine", default=".local/search-quarantine.jsonl")
    run.add_argument("--offset-reset", choices=("earliest", "latest"), default="earliest")
    promote = commands.add_parser("promote")
    promote.add_argument("--version", type=int, required=True)
    promote.add_argument("--expected-manifest", required=True, help="JSON document-ID-to-version map from trusted inventory source")
    bootstrap = commands.add_parser("bootstrap")
    bootstrap.add_argument("--version", type=int, required=True)
    args = parser.parse_args()
    elastic = Elastic(os.getenv("ELASTICSEARCH_URL", "http://127.0.0.1:19200"),
                      os.getenv("OPENSEARCH_USERNAME"), os.getenv("OPENSEARCH_PASSWORD"),
                      os.getenv("OPENSEARCH_CA_FILE"))
    if args.command == "consume":
        consume(elastic, args.version, args.group, args.bootstrap, args.quarantine, args.offset_reset)
    elif args.command == "bootstrap":
        elastic.bootstrap_index(index_name(args.version))
    else:
        elastic.promote(index_name(args.version), json.loads(open(args.expected_manifest, encoding="utf-8").read()))


if __name__ == "__main__":
    main()
