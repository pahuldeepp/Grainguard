"""Disposable PostgreSQL acceptance for the end-to-end local RAG slice."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Thread
import time
from uuid import uuid4
from urllib.request import Request, urlopen

import psycopg

from knowledge_extensions.graph import make_candidate_fact, make_entity
from knowledge_extensions.graph_store import persist_candidate_fact, retrieve_reviewed_facts
from knowledge_extensions.http_api import ApiPrincipal, create_server
from knowledge_extensions.pdf_parser import parse_pdf
from knowledge_extensions.retrieval import process_index_event, retrieve_answer
from knowledge_extensions.service import KnowledgeRagService
from knowledge_extensions.source_store import save_parsed_pdf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "tests"))
from local_rag_adapters import LocalAnswerGenerator, LocalEmbedding, LocalReranker, LocalVectorStore
from pdf_fixture import make_text_pdf


IMAGE = "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
TENANT_A = "11111111-1111-4111-8111-111111111111"
TENANT_B = "22222222-2222-4222-8222-222222222222"
DOC = "33333333-3333-4333-8333-333333333333"
NAMESPACE_KEY = b"local-only-acceptance-namespace-key-32-bytes!!"
HTTP_DOC = "44444444-4444-4444-8444-444444444444"
HTTP_PRINCIPAL = "88888888-8888-4888-8888-888888888888"


class LocalModelPorts:
    def __init__(self):
        self.embedding = LocalEmbedding()
        self.reranker = LocalReranker()
        self.answerer = LocalAnswerGenerator()
        self.embedding_model = self.embedding.model
        self.reranker_model = self.reranker.model
        self.answer_model = self.answerer.model

    def embed(self, *args, **kwargs):
        return self.embedding.embed(*args, **kwargs)

    def rerank(self, *args, **kwargs):
        return self.reranker.rerank(*args, **kwargs)

    def answer(self, *args, **kwargs):
        return self.answerer.answer(*args, **kwargs)


class LocalObjectStore:
    def __init__(self):
        self.objects = {}

    def put_pdf(self, pdf: bytes, *, tenant_id: str, document_id: str,
                document_version: int, source_sha256: str, source_object_key: str | None = None) -> str:
        key = (f"tenant/{tenant_id}/documents/{document_id}/versions/{document_version}/"
               f"objects/{uuid4()}/{source_sha256}.pdf")
        key=source_object_key or key
        self.objects[key] = pdf
        return key

    def get_pdf(self, key: str) -> bytes:
        return self.objects[key]

    def delete_pdf(self, _key: str) -> None:
        self.objects.pop(_key, None)


def _run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=check)


def main() -> None:
    name = f"greenguard-knowledge-accept-{uuid4().hex[:10]}"
    password = uuid4().hex
    _run("docker", "run", "--rm", "-d", "--name", name,
         "-e", "POSTGRES_DB=greenguard_knowledge", "-e", "POSTGRES_USER=knowledge_migrator",
         "-e", f"POSTGRES_PASSWORD={password}", "-p", "127.0.0.1::5432", IMAGE)
    try:
        port = ""
        for _ in range(60):
            mapped = _run("docker", "port", name, "5432/tcp", check=False)
            if mapped.returncode == 0 and mapped.stdout.strip():
                port = mapped.stdout.strip().rsplit(":", 1)[-1]
                try:
                    with psycopg.connect(f"postgresql://knowledge_migrator:{password}@127.0.0.1:{port}/greenguard_knowledge", connect_timeout=1):
                        break
                except psycopg.OperationalError:
                    pass
            time.sleep(1)
        if not port:
            raise RuntimeError("disposable PostgreSQL did not become ready")
        admin = f"postgresql://knowledge_migrator:{password}@127.0.0.1:{port}/greenguard_knowledge"
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(f"CREATE ROLE knowledge_app LOGIN PASSWORD '{password}' NOBYPASSRLS")
            conn.execute(f"CREATE ROLE knowledge_reviewer LOGIN PASSWORD '{password}' NOBYPASSRLS")
            conn.execute(f"CREATE ROLE knowledge_provisioner LOGIN PASSWORD '{password}' NOBYPASSRLS")
        env = dict(os.environ)
        env.update(KNOWLEDGE_ENVIRONMENT="local-synthetic", KNOWLEDGE_MIGRATION_DATABASE_URL=admin,
                   PYTHONPATH=str(HERE))
        subprocess.run([sys.executable, str(HERE / "migrate.py")],
                       cwd=HERE, env=env, check=True)
        app_dsn = f"postgresql://knowledge_app:{password}@127.0.0.1:{port}/greenguard_knowledge"
        reviewer_dsn = f"postgresql://knowledge_reviewer:{password}@127.0.0.1:{port}/greenguard_knowledge"
        pdf_v1 = make_text_pdf([
            ["Humidity Management", "Keep stored wheat dry to reduce the risk of mold."],
            ["Ventilation", "Move air through grain during humid storage conditions."],
        ])
        parsed_v1 = parse_pdf(pdf_v1, tenant_id=TENANT_A, document_id=DOC, document_version=1)
        if len(parsed_v1.chunks) != 2:
            raise AssertionError("real PDF parser did not create the two expected chunks")
        with psycopg.connect(app_dsn) as app:
            catalog = app.execute("""SELECT count(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relname IN
                ('knowledge_documents','knowledge_document_versions','knowledge_chunks',
                 'knowledge_index_outbox','knowledge_document_outlines','knowledge_outline_nodes',
                 'knowledge_outline_chunks','knowledge_graph_entities','knowledge_graph_facts',
                 'knowledge_auth_memberships','knowledge_membership_audit',
                 'assistant_suggestion_usage_outbox','assistant_suggestion_usage_events',
                 'assistant_suggestion_usage_daily')
                  AND c.relrowsecurity AND c.relforcerowsecurity""").fetchone()[0]
            if catalog != 14:
                raise AssertionError("tenant tables are missing enabled and forced RLS")
            app.commit()
            if not save_parsed_pdf(app, parsed=parsed_v1):
                raise AssertionError("first PDF ingestion unexpectedly looked idempotent")
            # No tenant context is fail-closed; tenant A cannot see or insert tenant B rows.
            if app.execute("SELECT count(*) FROM knowledge_chunks").fetchone()[0] != 0:
                raise AssertionError("RLS allowed a query without tenant context")
            with app.transaction():
                app.execute("SELECT set_config('app.tenant_id', %s, true)", (TENANT_A,))
                if app.execute("SELECT count(*) FROM knowledge_chunks").fetchone()[0] != 2:
                    raise AssertionError("tenant A could not see canonical chunks")
                app.execute("SELECT set_config('app.tenant_id', %s, true)", (TENANT_B,))
                if app.execute("SELECT count(*) FROM knowledge_chunks").fetchone()[0] != 0:
                    raise AssertionError("tenant B could see tenant A's canonical chunks")
                try:
                    with app.transaction():
                        app.execute("INSERT INTO knowledge_documents (tenant_id,document_id,current_version) VALUES (%s,%s,1)",
                                    (TENANT_A, "66666666-6666-4666-8666-666666666666"))
                except psycopg.errors.InsufficientPrivilege:
                    pass
                else:
                    raise AssertionError("RLS allowed a cross-tenant insert")

            source = make_entity(TENANT_A, "grain", "Wheat")
            target = make_entity(TENANT_A, "hazard", "Fusarium head blight")
            fact = make_candidate_fact(
                tenant_id=TENANT_A, source=source, predicate="has_hazard", target=target,
                document_id=DOC, document_version=1, chunk_id=parsed_v1.chunks[0].chunk_id,
                span_start=0, span_end=24, trust="curated",
            )
            persist_candidate_fact(app, tenant_id=TENANT_A, source=source, fact=fact, target=target)
            with app.transaction():
                app.execute("SELECT set_config('app.tenant_id', %s, true)", (TENANT_A,))
                if app.execute("SELECT count(*) FROM knowledge_graph_facts WHERE status='candidate'").fetchone()[0] != 1:
                    raise AssertionError("candidate graph fact was not persisted")
                try:
                    with app.transaction():
                        app.execute("UPDATE knowledge_graph_facts SET status='reviewed' WHERE fact_id=%s", (fact.edge_id,))
                except psycopg.errors.InsufficientPrivilege:
                    pass
                else:
                    raise AssertionError("application role could approve graph facts")
        with psycopg.connect(reviewer_dsn) as reviewer:
            with reviewer.transaction():
                reviewer.execute("SELECT set_config('app.tenant_id', %s, true)", (TENANT_A,))
                reviewer.execute("UPDATE knowledge_graph_facts SET status='reviewed' WHERE fact_id=%s", (fact.edge_id,))
        with psycopg.connect(app_dsn) as app:
            rows = retrieve_reviewed_facts(app, tenant_id=TENANT_A,
                                           start_entity_id=source.entity_id,
                                           authorized_chunk_ids={parsed_v1.chunks[0].chunk_id})
            if len(rows) != 1 or rows[0]["fact_id"] != fact.edge_id:
                raise AssertionError("reviewed provenance fact did not traverse")
            if retrieve_reviewed_facts(app, tenant_id=TENANT_A,
                                       start_entity_id=source.entity_id,
                                       authorized_chunk_ids={parsed_v1.chunks[1].chunk_id}):
                raise AssertionError("graph traversal ignored authorized chunk IDs")
            pdf_v2 = make_text_pdf([
                ["Humidity Management", "Maintain low grain moisture to prevent mold in wheat storage."],
                ["Ventilation", "Ventilate grain when warm humid air increases storage risk."],
            ])
            parsed_v2 = parse_pdf(pdf_v2, tenant_id=TENANT_A, document_id=DOC, document_version=2)
            if not save_parsed_pdf(app, parsed=parsed_v2):
                raise AssertionError("second PDF version was not persisted")
            if retrieve_reviewed_facts(app, tenant_id=TENANT_A,
                                       start_entity_id=source.entity_id,
                                       authorized_chunk_ids={parsed_v1.chunks[0].chunk_id}):
                raise AssertionError("document version replacement left stale graph facts")
            new_fact = make_candidate_fact(
                tenant_id=TENANT_A, source=source, predicate="has_hazard", target=target,
                document_id=DOC, document_version=2, chunk_id=parsed_v2.chunks[0].chunk_id,
                span_start=0, span_end=50, trust="tenant_uploaded",
            )
            persist_candidate_fact(app, tenant_id=TENANT_A, source=source,
                                   fact=new_fact, target=target)
        with psycopg.connect(reviewer_dsn) as reviewer:
            with reviewer.transaction():
                reviewer.execute("SELECT set_config('app.tenant_id', %s, true)", (TENANT_A,))
                reviewer.execute("UPDATE knowledge_graph_facts SET status='reviewed' WHERE fact_id=%s", (new_fact.edge_id,))
        local_embeddings = LocalEmbedding()
        local_vectors = LocalVectorStore()
        with psycopg.connect(app_dsn) as app:
            with app.transaction():
                app.execute("SELECT set_config('app.tenant_id', %s, true)", (TENANT_A,))
                event_id = app.execute(
                    "SELECT event_id::text FROM knowledge_index_outbox WHERE document_version=2"
                ).fetchone()[0]
            indexed = process_index_event(
                app, tenant_id=TENANT_A, event_id=event_id,
                namespace_key=NAMESPACE_KEY, embedding_provider=local_embeddings,
                vector_store=local_vectors, embedding_model=local_embeddings.model,
            )
            if indexed != 2:
                raise AssertionError("outbox indexer did not project both canonical chunks")
            answer = retrieve_answer(
                app, tenant_id=TENANT_A, principal_id="77777777-7777-4777-8777-777777777777",
                principal_role="viewer", question="How do humidity and mold affect wheat storage?",
                namespace_key=NAMESPACE_KEY, embedding_provider=local_embeddings,
                vector_store=local_vectors, reranker=LocalReranker(),
                answer_generator=LocalAnswerGenerator(), embedding_model=local_embeddings.model,
                reranker_model=LocalReranker.model, answer_model=LocalAnswerGenerator.model,
            )
            if not answer.citations or answer.citations[0]["document_version"] != 2:
                raise AssertionError("RAG answer did not carry a current authorized citation")
            if not all(answer.retrieval[key] for key in ("dense", "fts", "pageindex", "knowledge_graph")):
                raise AssertionError("RAG acceptance did not exercise all four retrieval legs")
            no_access = retrieve_answer(
                app, tenant_id=TENANT_B, principal_id=None, principal_role="viewer",
                question="How do humidity and mold affect wheat storage?",
                namespace_key=NAMESPACE_KEY, embedding_provider=local_embeddings,
                vector_store=local_vectors, reranker=LocalReranker(),
                answer_generator=LocalAnswerGenerator(), embedding_model=local_embeddings.model,
                reranker_model=LocalReranker.model, answer_model=LocalAnswerGenerator.model,
            )
            if no_access.citations:
                raise AssertionError("cross-tenant RAG request returned a citation")
        # Exercise the authenticated HTTP API through the real service composition,
        # database, outbox, RAG implementation, and local provider/vector adapters.
        from controlled_gateway_fixture import controlled_models
        gateway_context=controlled_models(admin,TENANT_A,[HTTP_PRINCIPAL])
        models=gateway_context.__enter__()
        api_service = KnowledgeRagService(
            connect=lambda: psycopg.connect(app_dsn), vector_store=LocalVectorStore(),
            model_gateway=models, namespace_key=NAMESPACE_KEY,
            embedding_model=models.embedding_model, reranker_model=models.reranker_model,
            answer_model=models.answer_model, object_store=LocalObjectStore(),
        )
        token = "acceptance-only-bearer"
        # API lookup hashes with plain SHA-256; keep acceptance token synthetic.
        bindings = {hashlib.sha256(token.encode()).hexdigest(): ApiPrincipal(TENANT_A, HTTP_PRINCIPAL, "operator")}
        api = create_server(service=api_service, access_bindings=bindings, host="127.0.0.1", port=0)
        thread = Thread(target=api.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{api.server_port}"
            upload = Request(
                f"{base}/v1/documents/{HTTP_DOC}",
                data=make_text_pdf([["Ventilation", "Store wheat dry and ventilate it to reduce mold risk."]]),
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/pdf", "X-Document-Version": "1"},
                method="POST",
            )
            with urlopen(upload, timeout=10) as response:
                upload_result = json.loads(response.read())
            if upload_result.get("status") != "queued":
                raise AssertionError("authenticated HTTP upload did not queue the PDF")
            broker = os.environ.get('KNOWLEDGE_ACCEPTANCE_KAFKA')
            if broker:
                from confluent_kafka import Producer, Consumer
                from knowledge_extensions.kafka_runtime import TOPIC, decode_event, publish_pending_once
                producer = Producer({'bootstrap.servers': broker})
                publish_pending_once(lambda: psycopg.connect(app_dsn), producer, TENANT_A)
                consumer = Consumer({'bootstrap.servers': broker, 'group.id': str(uuid4()),
                                     'auto.offset.reset': 'earliest', 'enable.auto.commit': False})
                consumer.subscribe([TOPIC])
                try:
                    for _ in range(40):
                        message = consumer.poll(1)
                        if message is not None and not message.error():
                            event = decode_event(message)
                            if event['event_id'] == upload_result['event_id']:
                                break
                    else:
                        raise AssertionError('outbox event did not arrive through Kafka')
                    api_service.process_document_event(tenant_id=event['tenant_id'],
                        document_id=event['document_id'], document_version=event['document_version'],
                        event_id=event['event_id'])
                    if api_service.process_document_event(tenant_id=event['tenant_id'],
                        document_id=event['document_id'], document_version=event['document_version'],
                        event_id=event['event_id']) != 0:
                        raise AssertionError('Kafka duplicate reindexed a completed document')
                    consumer.commit(message=message, asynchronous=False)
                finally:
                    consumer.close()
            else:
                api_service.process_document_event(
                tenant_id=TENANT_A, document_id=HTTP_DOC,
                document_version=upload_result["document_version"], event_id=upload_result["event_id"],
                )
            query = Request(
                f"{base}/v1/query", data=json.dumps({"question": "How can I reduce wheat mold risk?"}).encode(),
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, method="POST",
            )
            with urlopen(query, timeout=10) as response:
                query_result = json.loads(response.read())
            if not query_result.get("citations") or query_result["citations"][0]["document_id"] != HTTP_DOC:
                raise AssertionError("HTTP query did not return a citation for the uploaded PDF")
            failed_doc = str(uuid4())
            failed = api_service.ingest_pdf(tenant_id=TENANT_A, document_id=failed_doc,
                                            document_version=1, pdf_bytes=b'%PDF-invalid')
            failed_event = {'tenant_id': TENANT_A, 'document_id': failed_doc,
                            'document_version': 1, 'event_id': failed.event_id}
            if api_service.record_index_failure(event={**failed_event, 'tenant_id': TENANT_B}, permanent=True) is not True:
                raise AssertionError('cross-tenant missing event was not isolated')
            if api_service.document_status(tenant_id=TENANT_A, document_id=failed_doc, document_version=1)['status'] != 'queued':
                raise AssertionError('cross-tenant failure changed the owner document')
            for attempt in range(1,6):
                parked = api_service.record_index_failure(event=failed_event, permanent=False)
                if parked != (attempt == 5):
                    raise AssertionError('durable retry attempt threshold is incorrect')
            if api_service.document_status(tenant_id=TENANT_A, document_id=failed_doc, document_version=1)['status'] != 'failed':
                raise AssertionError('quarantined document was not marked failed')
            from auth_acceptance import run as run_auth_acceptance
            run_auth_acceptance(admin, app_dsn, models, LocalObjectStore())
            if os.environ.get("KNOWLEDGE_DEX_ACCEPTANCE")=="true":
                from dex_acceptance import run as run_dex_acceptance
                run_dex_acceptance(admin, app_dsn, LocalModelPorts(), LocalObjectStore())
        finally:
            api.shutdown()
            api.server_close()
            thread.join(timeout=2)
            gateway_context.__exit__(None,None,None)
        from evals.run_local import run as run_rag_evals
        run_rag_evals(app_dsn)
        from guardrail_acceptance import run as run_guardrail_acceptance
        from evals.run_guardrails import run as run_guardrail_gate
        run_guardrail_acceptance(app_dsn)
        from redaction_acceptance import run as run_redaction_acceptance
        run_redaction_acceptance(app_dsn)
        from output_guardrail_acceptance import run as run_output_guardrail_acceptance
        run_output_guardrail_acceptance(app_dsn, admin)
        run_guardrail_gate()
        print("Postgres RAG acceptance passed: PDF parsing, canonical storage, RLS/ACL, outbox indexing, FTS, dense search, PageIndex, graph, RRF, hydration, reranking, cited answer, authenticated HTTP ingest/query")
    finally:
        _run("docker", "rm", "-f", name, check=False)


if __name__ == "__main__":
    main()
