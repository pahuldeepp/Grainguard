"""Kafka outbox relay or PDF index consumer process entry point."""

from __future__ import annotations

import os
import signal
import threading
import time

import psycopg
from confluent_kafka import Consumer, Producer

from knowledge_extensions.http_api import _canonical_uuid
import json
from knowledge_extensions.kafka_runtime import (
    SUGGESTION_USAGE_TOPIC, TOPIC, consume_forever,
    consume_suggestion_analytics_forever, publish_pending_once,
    publish_suggestion_usage_once,
)
from knowledge_extensions.model_gateway import ModelGatewayClient
from knowledge_extensions.object_storage import S3PdfObjectStore, S3SourceConfig
from knowledge_extensions.service import KnowledgeRagService
from knowledge_extensions.vector_store import PineconeVectorStore
from knowledge_extensions.parser_sandbox import ContainerPdfParser
from knowledge_extensions.parser_kubernetes import KubernetesPdfParser
from knowledge_extensions.file_validation import ClamAvScanner
from serve import _provider_secret, _required, _tenant_gateway_tokens


def main() -> None:
    role = os.environ.get("KNOWLEDGE_WORKER_ROLE", "indexer")
    dsn = _required("KNOWLEDGE_DATABASE_URL")
    kafka = {"bootstrap.servers": _required("KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS")}
    if os.environ.get("KNOWLEDGE_KAFKA_SECURITY_PROTOCOL"):
        kafka.update({"security.protocol": os.environ["KNOWLEDGE_KAFKA_SECURITY_PROTOCOL"],
                      "sasl.mechanisms": _required("KNOWLEDGE_KAFKA_SASL_MECHANISM"),
                      "sasl.username": _required("KNOWLEDGE_KAFKA_SASL_USERNAME"),
                      "sasl.password": _required("KNOWLEDGE_KAFKA_SASL_PASSWORD")})
    ca_file = os.environ.get("KNOWLEDGE_KAFKA_CA_FILE")
    if ca_file:
        from pathlib import Path
        if not Path(ca_file).is_file():
            raise SystemExit("Knowledge Kafka CA file is not mounted")
        kafka["ssl.ca.location"] = ca_file
    if os.environ.get("KNOWLEDGE_ENVIRONMENT") == "disposable-aws":
        if kafka.get("security.protocol") != "SASL_SSL" or not ca_file:
            raise SystemExit("disposable Knowledge workers require SASL_SSL and a mounted Kafka CA")
    connect = lambda: psycopg.connect(dsn, connect_timeout=5, options="-c statement_timeout=10000 -c lock_timeout=2000")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if role == "relay":
        producer = Producer(kafka)
        with open(_required("KNOWLEDGE_RELAY_TENANTS_FILE"),encoding="utf-8") as handle:
            tenant_list=json.load(handle)
        if not isinstance(tenant_list,list) or not tenant_list or any(not _canonical_uuid(t) for t in tenant_list):
            raise SystemExit("relay tenant file requires canonical tenant UUIDs")
        tenants=set(tenant_list)
        while not stop.is_set():
            total = 0
            failed = False
            for tenant in tenants:
                for publish in (publish_pending_once, publish_suggestion_usage_once):
                    if stop.is_set():
                        break
                    try:
                        total += publish(connect, producer, tenant)
                    except Exception:
                        failed = True
                        print("knowledge relay dependency unavailable", flush=True)
            if failed or not total:
                stop.wait(5 if failed else 1)
        producer.flush(10)
        return
    if role == "suggestion-analytics":
        kafka.update({"group.id": os.environ.get("KNOWLEDGE_SUGGESTION_ANALYTICS_GROUP_ID",
                                                 "greenguard-knowledge-suggestion-analytics-v1"),
                      "enable.auto.commit": False, "enable.auto.offset.store": False,
                      "auto.offset.reset": "earliest"})
        consumer = Consumer(kafka)
        quarantine_producer = Producer({key: value for key, value in kafka.items()
                                        if key not in {'group.id','enable.auto.commit','enable.auto.offset.store','auto.offset.reset'}})
        consumer.subscribe([SUGGESTION_USAGE_TOPIC])
        try:
            consume_suggestion_analytics_forever(consumer, connect, stop=stop,
                                                 quarantine_producer=quarantine_producer)
        finally:
            consumer.close()
        return
    if role == "conversation-retention":
        from knowledge_extensions.conversation_retention import purge_expired_deleted_conversations
        scopes_path = _required("KNOWLEDGE_RETENTION_SCOPES_FILE")
        retention_days = int(os.environ.get("KNOWLEDGE_CONVERSATION_RETENTION_DAYS", "30"))
        batch_size = int(os.environ.get("KNOWLEDGE_CONVERSATION_RETENTION_BATCH_SIZE", "100"))
        interval = int(os.environ.get("KNOWLEDGE_CONVERSATION_RETENTION_INTERVAL_SECONDS", "3600"))
        if not 60 <= interval <= 86400:
            raise SystemExit("KNOWLEDGE_CONVERSATION_RETENTION_INTERVAL_SECONDS must be 60-86400")
        while not stop.is_set():
            with open(scopes_path, encoding="utf-8") as handle:
                scopes = json.load(handle)
            if (not isinstance(scopes, list) or not scopes or any(
                not isinstance(scope, dict)
                or not _canonical_uuid(scope.get("tenant_id"))
                or not _canonical_uuid(scope.get("user_id"))
                for scope in scopes
            )):
                raise SystemExit("retention scope file must contain tenant_id/user_id UUID objects")
            removed = purge_expired_deleted_conversations(
                connect, scopes=scopes, retention_days=retention_days, batch_size=batch_size,
            )
            if removed:
                print(f"conversation_retention purged={removed}", flush=True)
            stop.wait(interval)
        return
    if role != "indexer":
        raise SystemExit("KNOWLEDGE_WORKER_ROLE must be relay, indexer, suggestion-analytics, or conversation-retention")
    tokens = _tenant_gateway_tokens(_required("KNOWLEDGE_MODEL_GATEWAY_TOKENS_FILE"))
    namespace_key = bytes.fromhex(_required("KNOWLEDGE_NAMESPACE_HMAC_KEY"))
    if len(namespace_key) < 32:
        raise SystemExit("KNOWLEDGE_NAMESPACE_HMAC_KEY must contain at least 32 bytes in hex")
    backend=os.environ.get("KNOWLEDGE_PARSER_BACKEND", "kubernetes")
    if backend not in {"kubernetes", "docker"}:
        raise SystemExit("KNOWLEDGE_PARSER_BACKEND must be kubernetes or docker")
    parser_type=KubernetesPdfParser if backend=="kubernetes" else ContainerPdfParser
    service = KnowledgeRagService(
        connect=connect,
        parser=parser_type(image=_required('KNOWLEDGE_PARSER_IMAGE'),
                           ocr=os.environ.get('KNOWLEDGE_PARSER_OCR')=='true',
                           timeout=120 if os.environ.get('KNOWLEDGE_PARSER_OCR')=='true' else 60),
        scanner=ClamAvScanner(host=_required('KNOWLEDGE_CLAMAV_HOST')),
        object_store=S3PdfObjectStore(S3SourceConfig(
            bucket=_required("KNOWLEDGE_S3_BUCKET"), region=_required("KNOWLEDGE_S3_REGION"),
            kms_key_id=_required("KNOWLEDGE_S3_KMS_KEY_ID"),
            endpoint_url=os.environ.get("KNOWLEDGE_S3_ENDPOINT") or None)),
        vector_store=PineconeVectorStore(index_host=_required("PINECONE_INDEX_HOST"),
                                         api_key=_provider_secret("PINECONE_API_KEY")),
        model_gateway=ModelGatewayClient(base_url=_required("KNOWLEDGE_MODEL_GATEWAY_URL"),
                                         task_token=lambda tenant: tokens[tenant],
                                         allow_mesh_http=os.environ.get("KNOWLEDGE_MODEL_GATEWAY_MESH_MTLS") == "true"),
        namespace_key=namespace_key,
        embedding_model=_required("KNOWLEDGE_EMBEDDING_MODEL"),
        reranker_model=_required("KNOWLEDGE_RERANKER_MODEL"),
        answer_model=_required("KNOWLEDGE_ANSWER_MODEL"),
    )
    kafka.update({"group.id": os.environ.get("KNOWLEDGE_KAFKA_GROUP_ID", "greenguard-knowledge-indexer-v1"),
                  "enable.auto.commit": False, "enable.auto.offset.store": False,
                  "auto.offset.reset": "earliest", "max.poll.interval.ms": 1800000})
    consumer = Consumer(kafka)
    quarantine_producer = Producer({key: value for key, value in kafka.items()
                                    if key not in {'group.id','enable.auto.commit','enable.auto.offset.store','auto.offset.reset'}})
    consumer.subscribe([TOPIC])
    try:
        consume_forever(consumer, service, stop=stop, quarantine_producer=quarantine_producer)
    finally:
        consumer.close()


if __name__ == "__main__":
    main()
