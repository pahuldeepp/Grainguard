"""End-to-end tenant-scoped hybrid retrieval and citation-backed answer flow."""

from __future__ import annotations

from .output_guardrails import validate_answer, OutputContractError, ABSTENTION
from .redaction import redact_text, redact_passages
from .prompt_guardrails import require_safe_text, inspect_text

from dataclasses import dataclass
import hashlib
import hmac
import math
import re
from typing import Any, Protocol, Callable
from uuid import UUID

from .vector_store import VectorRecord, VectorStore


class RetrievalError(RuntimeError):
    """Retrieval or answer generation failed closed."""


class Connection(Protocol):
    def transaction(self) -> Any: ...
    def execute(self, query: str, params: tuple[Any, ...] = ()) -> Any: ...


class EmbeddingProvider(Protocol):
    def embed(self, texts: list[str], *, tenant_id: str, model: str, input_type: str) -> list[list[float]]: ...


class Reranker(Protocol):
    def rerank(self, query: str, documents: list[str], *, tenant_id: str, model: str, top_n: int) -> list[int]: ...


class AnswerGenerator(Protocol):
    def answer(self, question: str, context: list[dict[str, Any]], *, tenant_id: str, model: str) -> dict[str, Any]: ...


def _generation_source(item: dict[str, Any]) -> dict[str, Any]:
    """Carry canonical hydrated metadata alongside evidence, never model-supplied IDs."""
    try:
        document_id = str(UUID(item["document_id"]))
    except (ValueError, TypeError, AttributeError) as exc:
        raise RetrievalError("invalid canonical document ID") from exc
    version, first, last = (item[key] for key in ("document_version", "page_start", "page_end"))
    if any(type(value) is not int or value < 1 for value in (version, first, last)) or last < first:
        raise RetrievalError("invalid canonical source metadata")
    return {key: item[key] for key in ("chunk_id", "trust", "text")} | {
        "document_id": document_id, "document_version": version,
        "page_start": first, "page_end": last,
    }


def _deduplicate_authorized_sources(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop exact duplicate evidence only after hydration/authorization and guards.

    Preserve fused order and the first authorized canonical citation. This does
    not merge permissions or substitute inaccessible copies of the same text.
    """
    seen: set[str] = set()
    unique = []
    for item in items:
        if item["text"] not in seen:
            seen.add(item["text"])
            unique.append(item)
    return unique


@dataclass(frozen=True, slots=True)
class RetrievedAnswer:
    answer: str
    citations: tuple[dict[str, Any], ...]
    retrieval: dict[str, int]
    structured_evidence: dict[str, Any] | None = None


def tenant_namespace(tenant_id: str, namespace_key: bytes) -> str:
    try:
        if str(UUID(tenant_id)) != tenant_id:
            raise ValueError
    except (ValueError, AttributeError) as exc:
        raise ValueError("tenant ID must be canonical UUID") from exc
    if len(namespace_key) < 32:
        raise ValueError("namespace key must contain at least 256 bits")
    pseudonym = hmac.new(namespace_key, tenant_id.encode(), hashlib.sha256).hexdigest()[:32]
    return f"t_{pseudonym}"


def reciprocal_rank_fusion(rankings: list[list[str]], *, k: int = 60,
                           limit: int = 50) -> list[str]:
    if type(k) is not int or k < 1 or type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("RRF bounds are invalid")
    scores: dict[str, float] = {}
    for ranking in rankings:
        seen: set[str] = set()
        for rank, item in enumerate(ranking, start=1):
            if item not in seen:
                scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
                seen.add(item)
    return sorted(scores, key=lambda item: (-scores[item], item))[:limit]


_ROLE_LEVEL = {"viewer": 1, "operator": 2, "admin": 3}


def _validate_caller(tenant_id: str, principal_id: str | None, role: str) -> None:
    try:
        if str(UUID(tenant_id)) != tenant_id:
            raise ValueError
        if principal_id is not None and str(UUID(principal_id)) != principal_id:
            raise ValueError
    except (ValueError, AttributeError) as exc:
        raise ValueError("caller identity must use canonical UUIDs") from exc
    if role not in _ROLE_LEVEL:
        raise ValueError("caller role is invalid")


def _set_tenant(connection: Connection, tenant_id: str) -> None:
    connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))


def _mark_index_event_processed(connection: Connection, *, tenant_id: str,
                                event_id: str, claim_token: str | None) -> Any:
    sql = """UPDATE knowledge_index_outbox SET processed_at=clock_timestamp(),
             claim_token=NULL,claimed_until=NULL
             WHERE tenant_id=%s AND event_id=%s AND processed_at IS NULL"""
    params: tuple[Any, ...] = (tenant_id, event_id)
    if claim_token is not None:
        sql += " AND claim_token IS NOT DISTINCT FROM %s"
        params += (claim_token,)
    return connection.execute(sql, params)


def _or_query_terms(query: str) -> str:
    """Use OR between parsed terms so natural questions can retrieve partial matches."""
    return " OR ".join(re.findall(r"[\w]+", query, flags=re.UNICODE)[:32])


def _accessible_docs_clause() -> str:
    return """(CASE d.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END)
              <= (CASE %s WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 WHEN 'admin' THEN 3 ELSE 0 END)
              AND (cardinality(d.acl_principals)=0 OR
                   (%s::uuid IS NOT NULL AND %s::uuid = ANY(d.acl_principals)))"""


def _redact_sources(items):
    groups = {}
    for index, item in enumerate(items):
        groups.setdefault((item["document_id"], item["document_version"]), []).append(index)
    result = list(items)
    for indices in groups.values():
        texts = redact_passages([items[index]["text"] for index in indices])
        for index, text in zip(indices, texts):
            result[index] = {**items[index], "text": text,
                "heading_path": [redact_text(h) for h in items[index]["heading_path"]]}
    return result


def _document_filter(scope, alias="c"):
    return (f" AND {alias}.document_id=%s AND {alias}.document_version=%s", scope) if scope else ("", ())


def _authorize_document_scope(connection, tenant, principal, role, scope, require_membership):
    from .document_summary import DocumentSummaryError
    document, version = scope
    membership = ""
    params = ()
    if require_membership:
        membership = """AND EXISTS (SELECT 1 FROM knowledge_auth_memberships m
            WHERE m.tenant_id=d.tenant_id AND m.principal_id=%s AND m.active
            AND (CASE WHEN 'admin'=ANY(m.roles) THEN 3 WHEN 'operator'=ANY(m.roles) THEN 2 ELSE 1 END)
            >= GREATEST(CASE d.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,
                        CASE v.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END))"""
        params = (principal,)
    with connection.transaction():
        _set_tenant(connection, tenant)
        row = connection.execute(f"""SELECT d.document_id FROM knowledge_documents d
            JOIN knowledge_document_versions v USING (tenant_id,document_id)
            WHERE d.tenant_id=%s AND d.document_id=%s AND v.document_version=%s
            AND d.current_version=v.document_version AND d.deleted_at IS NULL
            AND v.processing_status='ready' AND {_accessible_docs_clause()}
            AND {_accessible_docs_clause().replace('d.', 'v.')} {membership}""",
            (tenant, document, version, role, principal, principal, role, principal, principal) + params).fetchone()
    if row is None:
        raise DocumentSummaryError("document_scope_unavailable", 404)


def _search_fts(connection: Connection, tenant: str, principal: str | None,
                role: str, query: str, limit: int, document_scope: tuple[str, int] | None = None) -> list[str]:
    scope_sql, scope_params = _document_filter(document_scope)
    query = _or_query_terms(query)
    if not query:
        return []
    rows = connection.execute(
        f"""SELECT c.chunk_id::text
            FROM knowledge_chunks c JOIN knowledge_documents d
              USING (tenant_id, document_id)
            WHERE c.tenant_id=%s AND c.document_version=d.current_version
              AND d.deleted_at IS NULL AND {_accessible_docs_clause()}
              {scope_sql} AND c.search_vector @@ websearch_to_tsquery('simple', %s)
            ORDER BY ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', %s)) DESC,
                     c.document_id, c.ordinal LIMIT %s""",
        (tenant, role, principal, principal) + scope_params + (query, query, limit),
    ).fetchall()
    return [str(row[0]) for row in rows]


def _search_outline(connection: Connection, tenant: str, principal: str | None,
                    role: str, query: str, limit: int, document_scope: tuple[str, int] | None = None) -> list[str]:
    scope_sql, scope_params = _document_filter(document_scope)
    query = _or_query_terms(query)
    if not query:
        return []
    rows = connection.execute(
        f"""SELECT c.chunk_id::text,
                     max(ts_rank_cd(to_tsvector('simple', n.title),
                                    websearch_to_tsquery('simple', %s))) AS rank
            FROM knowledge_outline_nodes n
            JOIN knowledge_outline_chunks oc USING
              (tenant_id, document_id, document_version, node_id)
            JOIN knowledge_chunks c USING
              (tenant_id, document_id, document_version, chunk_id)
            JOIN knowledge_documents d USING (tenant_id, document_id)
            JOIN knowledge_document_outlines o USING
              (tenant_id, document_id, document_version)
            WHERE n.tenant_id=%s AND d.current_version=n.document_version
              AND d.deleted_at IS NULL AND {_accessible_docs_clause()}
              {scope_sql} AND to_tsvector('simple', n.title) @@ websearch_to_tsquery('simple', %s)
            GROUP BY c.chunk_id, c.document_id, c.ordinal
            ORDER BY rank DESC, c.document_id, c.ordinal LIMIT %s""",
        (query, tenant, role, principal, principal) + scope_params + (query, limit),
    ).fetchall()
    return [str(row[0]) for row in rows]


def _search_graph(connection: Connection, tenant: str, principal: str | None,
                  role: str, query: str, limit: int, document_scope: tuple[str, int] | None = None) -> list[str]:
    scope_sql, scope_params = _document_filter(document_scope)
    walk_sql, walk_params = _document_filter(document_scope, "candidate")
    query = _or_query_terms(query)
    if not query:
        return []
    rows = connection.execute(
        f"""WITH RECURSIVE seeds AS (
                SELECT e.entity_id FROM knowledge_graph_entities e
                WHERE e.tenant_id=%s AND to_tsvector('simple', e.display_label)
                      @@ websearch_to_tsquery('simple', %s)
                ORDER BY ts_rank(to_tsvector('simple', e.display_label),
                                 websearch_to_tsquery('simple', %s)) DESC
                LIMIT 8
            ), walk(entity_id, depth, path, document_id, document_version, chunk_id) AS (
                SELECT entity_id, 0, ARRAY[entity_id], NULL::uuid, NULL::bigint, NULL::uuid
                FROM seeds
                UNION ALL
                SELECT f.target_entity_id, w.depth+1, w.path || f.target_entity_id,
                       f.document_id, f.document_version, f.chunk_id
                FROM walk w CROSS JOIN LATERAL (
                    SELECT candidate.* FROM knowledge_graph_facts candidate
                    JOIN knowledge_documents d ON d.tenant_id=candidate.tenant_id
                      AND d.document_id=candidate.document_id
                      AND d.current_version=candidate.document_version
                    WHERE candidate.tenant_id=%s AND candidate.status='reviewed'
                      AND d.deleted_at IS NULL AND {_accessible_docs_clause()}
                      {walk_sql} AND candidate.source_entity_id=w.entity_id
                    ORDER BY candidate.fact_id LIMIT 64
                ) f
                WHERE w.depth < 2
                  AND NOT f.target_entity_id=ANY(w.path)
            )
            SELECT c.chunk_id::text, min(w.depth) AS depth
            FROM walk w
            JOIN knowledge_documents d ON d.tenant_id=%s AND d.document_id=w.document_id
            JOIN knowledge_chunks c ON c.tenant_id=d.tenant_id AND c.document_id=d.document_id
                 AND c.document_version=w.document_version AND c.chunk_id=w.chunk_id
            JOIN knowledge_document_outlines o ON o.tenant_id=c.tenant_id
                 AND o.document_id=c.document_id AND o.document_version=c.document_version
            JOIN knowledge_outline_chunks oc ON oc.tenant_id=c.tenant_id
                 AND oc.document_id=c.document_id AND oc.document_version=c.document_version
                 AND oc.chunk_id=c.chunk_id
            WHERE w.depth > 0 AND d.current_version=w.document_version
              AND d.deleted_at IS NULL AND {_accessible_docs_clause()}
            {scope_sql} GROUP BY c.chunk_id ORDER BY depth, c.chunk_id LIMIT %s""",
        (tenant, query, query, tenant, role, principal, principal) + walk_params + (tenant, role, principal, principal) + scope_params + (limit,),
    ).fetchall()
    return [str(row[0]) for row in rows]


def _hydrate(connection: Connection, tenant: str, principal: str | None,
             role: str, chunk_ids: list[str], *, require_membership: bool = False) -> list[dict[str, Any]]:
    if not chunk_ids or (require_membership and principal is None):
        return []
    membership_clause = ""
    membership_params = ()
    if require_membership:
        membership_clause = """AND EXISTS (
            SELECT 1 FROM knowledge_auth_memberships m
            WHERE m.tenant_id=c.tenant_id AND m.principal_id=%s AND m.active
            AND (CASE WHEN 'admin'=ANY(m.roles) THEN 3
                      WHEN 'operator'=ANY(m.roles) THEN 2 ELSE 1 END)
                >= GREATEST(CASE d.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,
                            CASE v.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END))"""
        membership_params = (principal,)
    rows = connection.execute(
        f"""SELECT c.chunk_id::text, c.document_id::text, c.document_version,
                   c.content, c.page_start, c.page_end, c.heading_path,
                   d.trust, d.min_role
            FROM knowledge_chunks c JOIN knowledge_documents d
              USING (tenant_id, document_id)
            JOIN knowledge_document_versions v USING
              (tenant_id, document_id, document_version)
            JOIN knowledge_document_outlines o USING
              (tenant_id, document_id, document_version)
            JOIN knowledge_outline_chunks oc USING
              (tenant_id, document_id, document_version, chunk_id)
            WHERE c.tenant_id=%s AND c.chunk_id=ANY(%s::uuid[])
              AND c.document_version=d.current_version AND d.deleted_at IS NULL
              AND v.processing_status='ready'
              AND {_accessible_docs_clause()}
              AND {_accessible_docs_clause().replace('d.', 'v.')} {membership_clause}""",
        (tenant, chunk_ids, role, principal, principal, role, principal, principal) + membership_params,
    ).fetchall()
    by_id = {
        str(row[0]): {
            "chunk_id": str(row[0]), "document_id": str(row[1]),
            "document_version": int(row[2]), "text": row[3],
            "page_start": int(row[4]), "page_end": int(row[5]),
            "heading_path": list(row[6]), "trust": row[7], "min_role": row[8],
        }
        for row in rows
    }
    return [by_id[item] for item in chunk_ids if item in by_id]


def process_index_event(connection: Connection, *, tenant_id: str, event_id: str,
                        namespace_key: bytes, embedding_provider: EmbeddingProvider,
                        vector_store: VectorStore, embedding_model: str,
                        claim_token: str | None = None) -> int:
    """Fence index writes against deletion using the parent transaction lock.

    Nested transactions in the implementation are savepoints: the parent lock
    remains held until the provider writes and durable cleanup intents commit.
    A provider failure rolls back publication and leaves the outbox retryable.
    """
    with connection.transaction():
        _set_tenant(connection,tenant_id)
        connection.execute("""SELECT d.document_id FROM knowledge_documents d
          JOIN knowledge_index_outbox o USING (tenant_id,document_id)
          WHERE d.tenant_id=%s AND o.event_id=%s FOR UPDATE OF d""",(tenant_id,event_id))
        return _process_index_event(connection,tenant_id=tenant_id,event_id=event_id,
          namespace_key=namespace_key,embedding_provider=embedding_provider,
          vector_store=vector_store,embedding_model=embedding_model,claim_token=claim_token)


def _process_index_event(
    connection: Connection, *, tenant_id: str, event_id: str,
    namespace_key: bytes, embedding_provider: EmbeddingProvider,
    vector_store: VectorStore, embedding_model: str, claim_token: str | None = None,
) -> int:
    """Consume one transactional outbox event with idempotent upsert semantics."""
    try:
        if str(UUID(event_id)) != event_id:
            raise ValueError
    except (ValueError, AttributeError) as exc:
        raise ValueError("event ID must be a canonical UUID") from exc
    if claim_token is not None:
        try:
            if str(UUID(claim_token)) != claim_token:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise ValueError("claim token must be a canonical UUID") from exc
    with connection.transaction():
        _set_tenant(connection, tenant_id)
        event = connection.execute(
            """SELECT document_id::text, document_version, chunk_ids, processed_at, claim_token::text
               FROM knowledge_index_outbox WHERE tenant_id=%s AND event_id=%s FOR UPDATE""",
            (tenant_id, event_id),
        ).fetchone()
        if event is None:
            raise RetrievalError("index event was not found for this tenant")
        if event[3] is not None:
            return 0
        if claim_token is not None and event[4] != claim_token:
            raise RetrievalError("index event claim was lost before processing")
        doc_id, version, chunk_ids = str(event[0]), int(event[1]), list(event[2])
        current = connection.execute(
            "SELECT current_version,latest_version FROM knowledge_documents WHERE tenant_id=%s AND document_id=%s",
            (tenant_id, doc_id),
        ).fetchone()
        if current is None or int(current[1]) > version or int(current[0]) > version:
            connection.execute(
                """UPDATE knowledge_document_versions SET processing_status='failed'
                   WHERE tenant_id=%s AND document_id=%s AND document_version=%s
                     AND processing_status IN ('queued','parsed')""",
                (tenant_id, doc_id, version),
            )
            _mark_index_event_processed(connection, tenant_id=tenant_id,
                                        event_id=event_id, claim_token=claim_token)
            return 0
        chunks = connection.execute(
            """SELECT c.chunk_id::text,c.content,c.document_version,d.trust,d.min_role
               FROM knowledge_chunks c JOIN knowledge_documents d USING (tenant_id,document_id)
               WHERE c.tenant_id=%s AND c.document_id=%s AND c.document_version=%s
                 AND c.chunk_id=ANY(%s::uuid[]) AND d.latest_version=c.document_version
                 AND d.deleted_at IS NULL ORDER BY c.ordinal""",
            (tenant_id, doc_id, version, chunk_ids),
        ).fetchall()
    if not chunks:
        with connection.transaction():
            _set_tenant(connection, tenant_id)
            connection.execute(
                """UPDATE knowledge_document_versions SET processing_status='failed'
                   WHERE tenant_id=%s AND document_id=%s AND document_version=%s
                     AND processing_status IN ('queued','parsed')""",
                (tenant_id, doc_id, version),
            )
            _mark_index_event_processed(connection, tenant_id=tenant_id,
                                        event_id=event_id, claim_token=claim_token)
        return 0
    # Reject the complete batch before any provider call or partial vector write.
    for index, row in enumerate(chunks):
        require_safe_text(str(row[1]))
        if index:
            require_safe_text(str(chunks[index-1][1]) + "\n" + str(row[1]))
    safe_chunk_texts = redact_passages([str(row[1]) for row in chunks])
    namespace = tenant_namespace(tenant_id, namespace_key)
    tenant_ref = namespace
    indexed = 0
    dimension: int | None = None
    for start in range(0, len(chunks), 100):
        batch = chunks[start:start + 100]
        vectors = embedding_provider.embed(safe_chunk_texts[start:start + 100],
                                           tenant_id=tenant_id, model=embedding_model,
                                           input_type="passage")
        if len(vectors) != len(batch) or not vectors:
            raise RetrievalError("embedding provider returned inconsistent vectors")
        batch_dimension = len(vectors[0])
        if not batch_dimension or (dimension is not None and batch_dimension != dimension):
            raise RetrievalError("embedding dimensions do not match across batches")
        dimension = batch_dimension
        if any(len(vector) != dimension or any(not math.isfinite(value) for value in vector)
               for vector in vectors):
            raise RetrievalError("embedding provider returned invalid vector values")
        records = [VectorRecord(
            chunk_id=str(row[0]), values=tuple(vector), metadata={
                "doc_id": doc_id, "doc_version": version, "tenant_ref": tenant_ref,
                "trust": str(row[3]), "acl_scope": str(row[4]),
                "embedding_version": embedding_model, "tombstone": False,
            },
        ) for row, vector in zip(batch, vectors, strict=True)]
        vector_store.upsert(namespace=namespace, records=records)
        indexed += len(records)
    with connection.transaction():
        _set_tenant(connection, tenant_id)
        result = _mark_index_event_processed(connection, tenant_id=tenant_id,
                                             event_id=event_id, claim_token=claim_token)
        if result.rowcount != 1:
            raise RetrievalError("index event claim was lost before completion")
        published = connection.execute(
            """UPDATE knowledge_documents d SET current_version=%s,min_role=v.min_role,
                      acl_principals=v.acl_principals
               FROM knowledge_document_versions v
               WHERE d.tenant_id=%s AND d.document_id=%s AND d.latest_version=%s
                 AND d.current_version <= %s AND d.deleted_at IS NULL AND v.tenant_id=d.tenant_id
                 AND v.document_id=d.document_id AND v.document_version=%s""",
            (version, tenant_id, doc_id, version, version, version),
        )
        if published.rowcount != 1:
            raise RetrievalError("document version changed before it could be served")
        connection.execute(
            """UPDATE knowledge_document_versions SET processing_status='ready'
               WHERE tenant_id=%s AND document_id=%s AND document_version=%s
                 AND processing_status='parsed'""",
            (tenant_id, doc_id, version),
        )
        from .document_lifecycle import enqueue_vectors
        enqueue_vectors(connection,tenant_id=tenant_id,document_id=doc_id,before_version=version)
    return indexed


def retrieve_answer(
    connection: Connection, *, tenant_id: str, principal_id: str | None,
    principal_role: str, question: str, namespace_key: bytes,
    embedding_provider: EmbeddingProvider, vector_store: VectorStore,
    reranker: Reranker, answer_generator: AnswerGenerator,
    embedding_model: str, reranker_model: str, answer_model: str,
    candidate_k: int = 20, context_k: int = 5,
    evaluation_trace: dict[str, Any] | None = None,
    reauthorize: Callable[[], str] | None = None,
    require_membership: bool = False,
    document_id: str | None = None, document_version: int | None = None,
    cache: Any | None = None,
) -> RetrievedAnswer:
    """Dense + FTS + PageIndex + graph → RRF → authorized text → rerank → answer."""
    _validate_caller(tenant_id, principal_id, principal_role)
    if not isinstance(question, str) or not 4 <= len(question.strip()) <= 2000:
        raise ValueError("question length is invalid")
    if (type(candidate_k) is not int or not 1 <= candidate_k <= 100
            or type(context_k) is not int or not 1 <= context_k <= min(8, candidate_k)):
        raise ValueError("retrieval bounds are invalid")
    scope = None
    if document_id is not None or document_version is not None:
        if (not isinstance(document_id, str) or str(UUID(document_id)) != document_id
                or type(document_version) is not int or not 1 <= document_version <= 2147483647):
            raise ValueError("invalid document scope")
        scope = (document_id, document_version)
        _authorize_document_scope(connection, tenant_id, principal_id, principal_role, scope, require_membership)
    question = question.strip()
    require_safe_text(question)
    question = redact_text(question)
    from .retrieval_cache import valid_vector, valid_rankings, corpus_revision
    namespace = tenant_namespace(tenant_id, namespace_key)
    cache_hit = False
    embedding_hit = False
    cache_key = None
    rankings = None
    if cache is not None:
        try:
            with connection.transaction():
                _set_tenant(connection, tenant_id)
                revision = corpus_revision(connection, tenant_id, scope)
        except Exception:
            # Cache revision availability cannot authorize reuse. The failed
            # transaction has rolled back; fresh searches/hydration still fail
            # closed on their own database/authentication errors.
            revision = None
        cache_key = cache.key("candidates", [namespace, principal_id, principal_role,
            embedding_model, reranker_model, answer_model, question, scope,
            candidate_k, require_membership, revision]) if revision is not None else None
        rankings = cache.get(cache_key) if cache_key is not None else None
        if not valid_rankings(rankings, candidate_k):
            rankings = None
        cache_hit = rankings is not None
        if hasattr(cache, 'record_lookup'):
            cache.record_lookup(tenant_id, 'retrieval', cache_hit)
    if rankings is None:
        embedding_key = cache.key("embedding", [namespace, embedding_model, "query", question]) if cache else None
        query_vector = cache.get(embedding_key) if cache else None
        embedding_hit = valid_vector(query_vector)
        if cache and hasattr(cache, 'record_lookup'):
            cache.record_lookup(tenant_id, 'embedding', embedding_hit)
        if not embedding_hit:
            query_vectors = embedding_provider.embed([question], tenant_id=tenant_id, model=embedding_model, input_type="query")
            if len(query_vectors) != 1 or not valid_vector(query_vectors[0]):
                raise RetrievalError("query embedding is invalid")
            query_vector = query_vectors[0]
            if cache:
                cache.put(embedding_key, query_vector, embedding=True)
        query_vectors = [query_vector]
        namespace = tenant_namespace(tenant_id, namespace_key)
        dense_hits = vector_store.search(namespace=namespace, vector=query_vectors[0], top_k=candidate_k, **({"document_scope": scope} if scope else {}))
        dense_ids: list[str] = []
        for hit in dense_hits:
            if (hit.metadata.get("tenant_ref") != namespace
                    or hit.metadata.get("embedding_version") != embedding_model
                    or hit.metadata.get("tombstone") is not False
                    or (scope and (hit.metadata.get("doc_id"), hit.metadata.get("doc_version")) != scope)):
                continue
            try:
                if str(UUID(hit.chunk_id)) == hit.chunk_id:
                    dense_ids.append(hit.chunk_id)
            except (ValueError, AttributeError):
                continue
    
        with connection.transaction():
            _set_tenant(connection, tenant_id)
            lexical = _search_fts(connection, tenant_id, principal_id, principal_role, question, candidate_k, **({"document_scope": scope} if scope else {}))
            outline = _search_outline(connection, tenant_id, principal_id, principal_role, question, candidate_k, **({"document_scope": scope} if scope else {}))
            graph = _search_graph(connection, tenant_id, principal_id, principal_role, question, candidate_k, **({"document_scope": scope} if scope else {}))
        rankings = {"dense": dense_ids, "fts": lexical, "pageindex": outline, "knowledge_graph": graph}
        if cache and cache_key is not None:
            cache.put(cache_key, rankings)
    dense_ids, lexical, outline, graph = (rankings[name] for name in ("dense", "fts", "pageindex", "knowledge_graph"))
    candidate_ids = reciprocal_rank_fusion(
        [dense_ids, lexical, outline, graph], k=60, limit=candidate_k,
    )
    with connection.transaction():
        _set_tenant(connection, tenant_id)
        authorized = _hydrate(connection, tenant_id, principal_id, principal_role, candidate_ids,
                              require_membership=require_membership)
    if scope:
        authorized = [item for item in authorized if (item["document_id"], item["document_version"]) == scope]
    authorized = authorized[:50]
    unsafe = {index for index, item in enumerate(authorized) if inspect_text(item['text'])}
    for index in range(1, len(authorized)):
        if index-1 not in unsafe and index not in unsafe and inspect_text(authorized[index-1]['text'] + "\n" + authorized[index]['text']):
            unsafe.update((index-1,index))
    blocked_context = len(unsafe)
    authorized = [item for index, item in enumerate(authorized) if index not in unsafe]
    authorized = _redact_sources(authorized)
    authorized = _deduplicate_authorized_sources(authorized)
    if evaluation_trace is not None:
        evaluation_trace.update(
            rankings={"dense": dense_ids, "fts": lexical, "pageindex": outline, "knowledge_graph": graph},
            fused_candidate_ids=candidate_ids,
            candidate_cache_hit=cache_hit, embedding_cache_hit=embedding_hit,
            candidate_ids=[item["chunk_id"] for item in authorized], context=[],
        )
    if not authorized:
        return RetrievedAnswer("I couldn't find an authorized source passage to answer that.", (), {
            "dense": len(dense_ids), "fts": len(lexical), "pageindex": len(outline),
            "guardrail_blocked_context": blocked_context, "knowledge_graph": len(graph), "fused": len(candidate_ids), "hydrated": 0,
        })

    rerank_count = min(context_k, len(authorized))
    ranked_indices = reranker.rerank(
        question, [item["text"] for item in authorized], tenant_id=tenant_id,
        model=reranker_model, top_n=rerank_count,
    )
    if (len(ranked_indices) != rerank_count or len(set(ranked_indices)) != len(ranked_indices)
            or any(type(index) is not int or not 0 <= index < len(authorized) for index in ranked_indices)):
        raise RetrievalError("reranker returned invalid candidate indices")
    selected = [authorized[index] for index in ranked_indices]
    context = [_generation_source(item) for item in selected]
    if evaluation_trace is not None:
        evaluation_trace["context"] = context
    generated = answer_generator.answer(question, context, tenant_id=tenant_id, model=answer_model)
    selected_by_id = {item["chunk_id"]: item for item in selected}
    try:
        answer, cited = validate_answer(generated, set(selected_by_id), context_k)
    except OutputContractError as exc:
        raise RetrievalError("answer model returned an invalid output contract") from exc
    # No network/model calls occur after this final authorization snapshot.
    # Re-authentication refreshes JWT expiry and authoritative membership roles.
    current_role = reauthorize() if reauthorize is not None else principal_role
    if current_role not in _ROLE_LEVEL:
        raise RetrievalError("invalid final authorization")
    if cited:
        with connection.transaction():
            _set_tenant(connection, tenant_id)
            current = _hydrate(connection, tenant_id, principal_id, current_role, list(selected_by_id), require_membership=require_membership)
        current_by_id = {item["chunk_id"]: item for item in _redact_sources(current)}
        # A changed passage/metadata cannot support the already generated prose.
        for chunk_id in selected_by_id:
            original = selected_by_id[chunk_id]
            fresh = current_by_id.get(chunk_id)
            if fresh is None or any(fresh[key] != original[key] for key in (
                    "document_id", "document_version", "page_start", "page_end", "trust")):
                answer, cited = ABSTENTION, []
                break
            if (fresh["text"] != original["text"]
                    or fresh["heading_path"] != original["heading_path"]):
                answer, cited = ABSTENTION, []
                break
    if not cited:
        # Discard uncited model prose: an insufficient-evidence response cannot
        # expose an invented answer or instructions copied from a source.
        return RetrievedAnswer("I couldn't find sufficient evidence in the authorized source passages to answer that.", (), {
            "dense": len(dense_ids), "fts": len(lexical), "pageindex": len(outline),
            "guardrail_blocked_context": blocked_context, "knowledge_graph": len(graph), "fused": len(candidate_ids),
            "hydrated": len(authorized), "reranked": len(selected),
        })
    citations = tuple({
        "chunk_id": chunk_id,
        "document_id": selected_by_id[chunk_id]["document_id"],
        "document_version": selected_by_id[chunk_id]["document_version"],
        "page_start": selected_by_id[chunk_id]["page_start"],
        "page_end": selected_by_id[chunk_id]["page_end"],
        "heading_path": selected_by_id[chunk_id]["heading_path"],
        "trust": selected_by_id[chunk_id]["trust"],
    } for chunk_id in cited)
    return RetrievedAnswer(redact_text(answer.strip()), citations, {
        "dense": len(dense_ids), "fts": len(lexical), "pageindex": len(outline),
        "guardrail_blocked_context": blocked_context, "knowledge_graph": len(graph), "fused": len(candidate_ids),
        "hydrated": len(authorized), "reranked": len(selected),
    })
