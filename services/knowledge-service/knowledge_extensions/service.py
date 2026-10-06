"""Application-level orchestration for trusted ingest, indexing, and RAG."""

from __future__ import annotations

from .model_gateway import verified_gateway_user
from .prompt_guardrails import require_safe_text

from dataclasses import dataclass, replace
from hashlib import sha256
from typing import Any, Callable, Protocol

from .pdf_parser import parse_pdf
from .retrieval import process_index_event, retrieve_answer, RetrievedAnswer
from .source_store import SourceVersionConflict, load_index_source, save_parsed_content, save_pdf_upload
from .vector_store import VectorStore


class ModelPorts(Protocol):
    def embed(self, texts: list[str], *, tenant_id: str, model: str, input_type: str) -> list[list[float]]: ...
    def rerank(self, query: str, documents: list[str], *, tenant_id: str, model: str, top_n: int) -> list[int]: ...
    def answer(self, question: str, context: list[dict[str, Any]], *, tenant_id: str, model: str) -> dict[str, Any]: ...


class StructuredPlannerPorts(Protocol):
    def plan(self, question: str, *, tenant_id: str, model: str) -> dict[str, Any]: ...


class ConnectionContext(Protocol):
    def __enter__(self) -> Any: ...
    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None: ...


class PdfObjectStore(Protocol):
    def put_pdf(self, pdf_bytes: bytes, *, tenant_id: str, document_id: str,
                document_version: int, source_sha256: str, source_object_key: str | None = None) -> str: ...
    def get_pdf(self, key: str) -> bytes: ...
    def delete_pdf(self, key: str) -> None: ...


@dataclass(frozen=True, slots=True)
class IngestResult:
    document_id: str
    document_version: int
    chunk_ids: tuple[str, ...]
    idempotent: bool
    event_id: str


class SuggestionIdempotencyConflict(ValueError):
    """An idempotency key was replayed with a different suggestion identifier."""


class KnowledgeRagService:
    """Wire the PDF parser, canonical Postgres store, outbox, and RAG providers.

    The caller must pass identities from verified authentication. Model calls
    are made only through the injected model-gateway client; vector metadata is
    built in this service and Pinecone never receives chunk text.
    """

    def __init__(
        self, *, connect: Callable[[], ConnectionContext], vector_store: VectorStore,
        model_gateway: ModelPorts, namespace_key: bytes, embedding_model: str,
        reranker_model: str, answer_model: str, object_store: PdfObjectStore | None = None,
        parser: Any | None = None, scanner: Any | None = None,
        retrieval_cache: Any | None = None, structured_planner_model: str | None = None,
        evaluation_report_file: str | None = None,
    ) -> None:
        self._evaluation_report_file = evaluation_report_file
        self._planner = getattr(model_gateway, "plan", None)
        self._structured_planner_model = structured_planner_model or answer_model
        self._connect = connect
        self._vector_store = vector_store
        if retrieval_cache is not None:
            from .retrieval_cache import CachedModelPorts
            self._models = CachedModelPorts(model_gateway, retrieval_cache, namespace_key)
        else:
            self._models = model_gateway
        self._namespace_key = namespace_key
        self._embedding_model = embedding_model
        self._reranker_model = reranker_model
        self._answer_model = answer_model
        self._object_store = object_store
        self._parser = parser
        self._scanner = scanner
        self._retrieval_cache = retrieval_cache

    def ingest_pdf(
        self, *, tenant_id: str, document_id: str, document_version: int,
        pdf_bytes: bytes, min_role: str = "viewer", acl_principals: set[str] | None = None,
        source_object_key: str | None = None, source_file_name: str | None = None,
        principal_id: str | None = None, principal_role: str | None = None,
        reauthorize: Callable[[], str] | None = None,
    ) -> IngestResult:
        if not pdf_bytes.startswith(b"%PDF-") or len(pdf_bytes) > 25 * 1024 * 1024:
            raise ValueError("upload is not a supported PDF")
        digest = sha256(pdf_bytes).hexdigest()
        if self._object_store is None:
            raise RuntimeError("private PDF object storage is required for asynchronous indexing")
        if source_object_key is not None:
            raise ValueError("source object key must be allocated by the server")
        if reauthorize is not None and reauthorize() not in {"operator", "admin"}:
            raise PermissionError("membership changed")
        from .document_lifecycle import reserve_upload
        # This connection's top-level commit makes the intent durable before any
        # provider write. A second transaction holds its lock through adoption.
        with self._connect() as connection:
            intent,object_key=reserve_upload(connection,tenant_id=tenant_id,document_id=document_id,
              document_version=document_version,digest=digest)
        with self._connect() as connection:
            with connection.transaction():
                connection.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant_id,))
                reserved=connection.execute("""SELECT intent_id FROM knowledge_upload_intents
                  WHERE tenant_id=%s AND intent_id=%s AND completed_at IS NULL FOR UPDATE""",(tenant_id,intent)).fetchone()
                if reserved is None:
                    raise RuntimeError("upload reservation expired before object write")
                written=self._object_store.put_pdf(pdf_bytes,tenant_id=tenant_id,document_id=document_id,
                  document_version=document_version,source_sha256=digest,source_object_key=object_key)
                if written!=object_key:
                    raise RuntimeError("object provider ignored the reserved key")
                if reauthorize is not None and reauthorize() not in {"operator", "admin"}:
                    raise PermissionError("membership changed")
                event_id, changed = save_pdf_upload(
                    connection, tenant_id=tenant_id, document_id=document_id,
                    document_version=document_version, pdf_bytes=pdf_bytes,
                    source_object_key=object_key, min_role=min_role,
                    source_file_name=source_file_name,
                    acl_principals=acl_principals,
                    principal_id=principal_id, principal_role=principal_role,
                )
                if changed:
                    connection.execute("""UPDATE knowledge_upload_intents SET completed_at=clock_timestamp()
                      WHERE tenant_id=%s AND intent_id=%s""",(tenant_id,intent))
                # Idempotent uploads leave the unadopted duplicate for durable
                # reconciliation. Failed/ambiguous writes also remain pending.
        return IngestResult(document_id, document_version, (), not changed, event_id)

    def record_suggestion_usage(self, *, tenant_id: str, suggestion_id: str,
                                idempotency_key: str) -> dict[str, Any]:
        """Persist an idempotent, content-free assistant suggestion usage event.

        This append-only tenant-scoped table is the durable CDC/outbox source.
        A later connector/consumer can aggregate it into PostgreSQL analytics and
        Redis ranking without putting question text or user identity in the event.
        """
        # The caller-generated Idempotency-Key is itself the event ID. This
        # keeps the CDC row limited to tenant, suggestion, event ID, and time.
        event_id = idempotency_key
        with self._connect() as connection:
            with connection.transaction():
                connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                inserted = connection.execute(
                    """INSERT INTO assistant_suggestion_usage_outbox
                           (tenant_id,event_id,suggestion_id)
                       VALUES (%s,%s,%s)
                       ON CONFLICT (tenant_id,event_id) DO NOTHING
                       RETURNING event_id::text,suggestion_id,created_at""",
                    (tenant_id, event_id, suggestion_id),
                ).fetchone()
                if inserted is not None:
                    return {"event_id": inserted[0], "suggestion_id": inserted[1],
                            "created_at": inserted[2].isoformat(), "idempotent": False}
                existing = connection.execute(
                    """SELECT event_id::text,suggestion_id,created_at
                        FROM assistant_suggestion_usage_outbox
                        WHERE tenant_id=%s AND event_id=%s""",
                    (tenant_id, event_id),
                ).fetchone()
                if existing is None:
                    # A concurrent deletion is not expected (the table is append-only),
                    # but fail closed so the caller does not rank an unrecorded use.
                    raise RuntimeError("suggestion usage idempotency record disappeared")
                if existing[1] != suggestion_id:
                    raise SuggestionIdempotencyConflict("idempotency key was already used for another suggestion")
                return {"event_id": existing[0], "suggestion_id": existing[1],
                        "created_at": existing[2].isoformat(), "idempotent": True}

    def process_document_event(self, *, tenant_id: str, document_id: str,
                               document_version: int, event_id: str) -> int:
        """Parse and index one ID-only Kafka event; Kafka offset commits after return."""
        with self._connect() as connection:
            source = load_index_source(connection, tenant_id=tenant_id, document_id=document_id,
                                       document_version=document_version, event_id=event_id)
        if source is None or source["processed"] or source["processing_status"] == "ready":
            return 0
        # Superseded or deleted versions must never trigger private object reads,
        # malware scans, parsing or provider calls. Let the idempotent index
        # consumer durably mark the stale outbox event complete.
        if source["deleted"] or source["latest_version"] > document_version:
            with self._connect() as connection:
                process_index_event(
                    connection, tenant_id=tenant_id, event_id=event_id,
                    namespace_key=self._namespace_key, embedding_provider=self._models,
                    vector_store=self._vector_store, embedding_model=self._embedding_model,
                )
            return 0
        if source["processing_status"] == "queued":
            if self._object_store is None or not source["source_object_key"]:
                raise RuntimeError("queued PDF has no private object-store source")
            pdf = self._object_store.get_pdf(source["source_object_key"])
            if sha256(pdf).hexdigest() != source["source_sha256"]:
                raise RuntimeError("stored PDF failed source hash verification")
            if self._scanner is not None:
                self._scanner.scan(pdf)
            parse = self._parser.parse if self._parser is not None else parse_pdf
            parsed = parse(pdf, tenant_id=tenant_id, document_id=document_id,
                               document_version=document_version)
            if parsed.source_sha256 != source["source_sha256"]:
                raise RuntimeError("parser source hash does not match queued version")
            for index, chunk in enumerate(parsed.chunks):
                require_safe_text(chunk.content)
                if index:
                    require_safe_text(parsed.chunks[index-1].content + "\n" + chunk.content)
            try:
                with self._connect() as connection:
                    save_parsed_content(connection, parsed=parsed, event_id=event_id)
            except SourceVersionConflict:
                # A newer version or deletion can race the parse. The index
                # consumer rechecks the authoritative current version and
                # durably retires stale work without embedding it.
                pass
        with self._connect() as connection:
            indexed = process_index_event(
                connection, tenant_id=tenant_id, event_id=event_id,
                namespace_key=self._namespace_key, embedding_provider=self._models,
                vector_store=self._vector_store, embedding_model=self._embedding_model,
            )
        return indexed

    def document_status(self, *, tenant_id: str, document_id: str,
                        document_version: int, principal_id: str | None = None,
                        principal_role: str = "viewer") -> dict[str, Any] | None:
        with self._connect() as connection:
            with connection.transaction():
                connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                row = connection.execute(
                    """SELECT v.processing_status,v.created_at FROM knowledge_document_versions v
                       JOIN knowledge_documents d USING (tenant_id,document_id)
                       WHERE v.tenant_id=%s AND v.document_id=%s AND v.document_version=%s
                         AND d.deleted_at IS NULL
                         AND (CASE d.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END)
                             <= (CASE %s WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 WHEN 'admin' THEN 3 ELSE 0 END)
                         AND (cardinality(d.acl_principals)=0 OR %s::uuid=ANY(d.acl_principals))
                         AND (CASE v.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END)
                             <= (CASE %s WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 WHEN 'admin' THEN 3 ELSE 0 END)
                         AND (cardinality(v.acl_principals)=0 OR %s::uuid=ANY(v.acl_principals))""",
                    (tenant_id,document_id,document_version,principal_role,principal_id,principal_role,principal_id),
                ).fetchone()
        return ({"document_id": document_id, "document_version": document_version,
                 "status": row[0], "created_at": row[1].isoformat() if row[1] else None}
                if row else None)

    def record_index_failure(self, *, event: dict[str, Any], permanent: bool) -> bool:
        """Durably park invalid input or reschedule dependency failures before ACK."""
        with self._connect() as connection:
            with connection.transaction():
                connection.execute("SELECT set_config('app.tenant_id', %s, true)", (event['tenant_id'],))
                source = connection.execute(
                    """SELECT processed_at FROM knowledge_index_outbox
                       WHERE tenant_id=%s AND event_id=%s AND document_id=%s
                         AND document_version=%s FOR UPDATE""",
                    (event['tenant_id'], event['event_id'], event['document_id'], event['document_version']),
                ).fetchone()
                if source is None or source[0] is not None:
                    return True
                row = connection.execute(
                    """INSERT INTO knowledge_index_failures (tenant_id,event_id,reason)
                       VALUES (%s,%s,%s) ON CONFLICT (tenant_id,event_id) DO UPDATE
                       SET attempts=knowledge_index_failures.attempts+1,reason=EXCLUDED.reason,
                           updated_at=clock_timestamp() RETURNING attempts""",
                    (event['tenant_id'], event['event_id'], 'invalid_pdf' if permanent else 'index_unavailable'),
                ).fetchone()
                parked = permanent
                if parked:
                    connection.execute(
                        "UPDATE knowledge_index_failures SET quarantined_at=clock_timestamp() WHERE tenant_id=%s AND event_id=%s",
                        (event['tenant_id'], event['event_id']),
                    )
                    connection.execute(
                        "UPDATE knowledge_document_versions SET processing_status='failed' WHERE tenant_id=%s AND document_id=%s AND document_version=%s",
                        (event['tenant_id'], event['document_id'], event['document_version']),
                    )
                    connection.execute(
                        "UPDATE knowledge_index_outbox SET processed_at=clock_timestamp(),claim_token=NULL,claimed_until=NULL WHERE tenant_id=%s AND event_id=%s",
                        (event['tenant_id'], event['event_id']),
                    )
                else:
                    delay = min(15 * (2 ** min(max(row[0] - 1, 0), 5)), 300)
                    connection.execute(
                        """UPDATE knowledge_index_outbox
                           SET available_at=clock_timestamp()+(%s * interval '1 second'),
                               published_at=NULL,claim_token=NULL,claimed_until=NULL
                           WHERE tenant_id=%s AND event_id=%s AND processed_at IS NULL""",
                        (delay, event['tenant_id'], event['event_id']),
                    )
                # Both outcomes are durable. The relay republishes due rows;
                # retry counters are diagnostics, never a transient-failure cap.
                return True

    def index_pending(self, *, tenant_id: str, batch_size: int = 100) -> int:
        if type(batch_size) is not int or not 1 <= batch_size <= 500:
            raise ValueError("batch_size must be between 1 and 500")
        with self._connect() as connection:
            with connection.transaction():
                connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                events = [(str(row[0]), str(row[1])) for row in connection.execute(
                    """WITH candidates AS (
                           SELECT o.event_id FROM knowledge_index_outbox o
                           JOIN knowledge_document_versions v
                             ON v.tenant_id=o.tenant_id AND v.document_id=o.document_id
                            AND v.document_version=o.document_version
                           WHERE o.tenant_id=%s AND o.processed_at IS NULL
                             AND o.published_at IS NULL AND o.available_at<=clock_timestamp()
                             AND v.processing_status='parsed'
                             AND (o.claimed_until IS NULL OR o.claimed_until <= clock_timestamp())
                           ORDER BY o.created_at, o.event_id
                           FOR UPDATE OF o SKIP LOCKED LIMIT %s
                       )
                       UPDATE knowledge_index_outbox o
                       SET claim_token=gen_random_uuid(),
                           claimed_until=clock_timestamp() + interval '15 minutes'
                       FROM candidates c
                       WHERE o.tenant_id=%s AND o.event_id=c.event_id
                       RETURNING o.event_id::text, o.claim_token::text""",
                    (tenant_id, batch_size, tenant_id),
                ).fetchall()]
            indexed = 0
            for event_id, claim_token in events:
                indexed += process_index_event(
                    connection, tenant_id=tenant_id, event_id=event_id,
                    namespace_key=self._namespace_key,
                    embedding_provider=self._models, vector_store=self._vector_store,
                    embedding_model=self._embedding_model, claim_token=claim_token,
                )
            return indexed

    def ask(
        self, *, tenant_id: str, principal_id: str | None,
        principal_role: str, question: str, candidate_k: int = 20, context_k: int = 5,
        reauthorize: Callable[[], str] | None = None, require_membership: bool = False,
        require_database_membership: bool = True,
        mode: str = "question", document_id: str | None = None, document_version: int | None = None,
    ) -> RetrievedAnswer:
        if not isinstance(mode, str) or mode not in {"question", "document_summary", "structured"}:
            raise ValueError("invalid query mode")
        from .text_sql import execute_question, plan_question, preauthorize_planner, validate_plan
        if mode == "structured":
            used_planner = False
            plan = plan_question(question)
            if plan is None and callable(self._planner):
                with self._connect() as connection:
                    preauthorize_planner(connection, tenant_id=tenant_id, principal_id=principal_id,
                        principal_role=principal_role, reauthorize=reauthorize,
                        require_database_membership=require_database_membership)
                with verified_gateway_user(principal_id):
                    plan = validate_plan(self._planner(question, tenant_id=tenant_id,
                        model=self._structured_planner_model))
                    used_planner = True
                with self._connect() as connection:
                    preauthorize_planner(connection, tenant_id=tenant_id, principal_id=principal_id,
                        principal_role=principal_role, reauthorize=reauthorize,
                        require_database_membership=require_database_membership)
            if plan is None or plan.operation == "unsupported":
                raise ValueError("unsupported structured question")
            with self._connect() as connection:
                result = execute_question(
                    connection, tenant_id=tenant_id, principal_id=principal_id,
                    principal_role=principal_role, question=question, plan=plan,
                    document_id=document_id, document_version=document_version,
                    reauthorize=reauthorize, require_database_membership=require_database_membership,
                )
                return replace(result, retrieval={**result.retrieval, "structured_planner": int(used_planner)})
        with verified_gateway_user(principal_id, deadline_seconds=280 if mode == "document_summary" else 20, call_timeout_seconds=110 if mode == "document_summary" else None), self._connect() as connection:
            if mode == "document_summary":
                from .document_summary import summarize_document
                return summarize_document(
                    connection, tenant_id=tenant_id, principal_id=principal_id,
                    principal_role=principal_role, question=question,
                    document_id=document_id, document_version=document_version,
                    answer_generator=self._models, answer_model=self._answer_model,
                    reauthorize=reauthorize, require_membership=require_membership,
                )
            return retrieve_answer(
                connection, tenant_id=tenant_id, principal_id=principal_id,
                principal_role=principal_role, question=question,
                namespace_key=self._namespace_key,
                embedding_provider=self._models, vector_store=self._vector_store,
                reranker=self._models, answer_generator=self._models,
                embedding_model=self._embedding_model, reranker_model=self._reranker_model,
                answer_model=self._answer_model, candidate_k=candidate_k, context_k=context_k,
                reauthorize=reauthorize, require_membership=require_membership,
                document_id=document_id, document_version=document_version,
                cache=self._retrieval_cache,
            )
