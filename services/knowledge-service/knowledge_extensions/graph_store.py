"""Forced-RLS PostgreSQL repository for provenance-backed graph candidates."""

from __future__ import annotations

from typing import Any, Protocol

from .graph import GraphEntity, GraphFact, InvalidGraphFact, PREDICATES, _label


class Cursor(Protocol):
    def fetchone(self) -> Any: ...
    def fetchall(self) -> list[Any]: ...


class Connection(Protocol):
    def transaction(self) -> Any: ...
    def execute(self, query: str, params: tuple[Any, ...] = ()) -> Cursor: ...


def persist_candidate_fact(
    connection: Connection, *, tenant_id: str,
    source: GraphEntity, fact: GraphFact, target: GraphEntity,
) -> None:
    """Persist entities and a candidate fact atomically under one tenant context."""
    if (tenant_id != fact.tenant_id or source.tenant_id != tenant_id
            or target.tenant_id != tenant_id or fact.status != "candidate"
            or fact.source_entity_id != source.entity_id
            or fact.target_entity_id != target.entity_id
            or fact.predicate not in PREDICATES):
        raise InvalidGraphFact("candidate graph fact identity is inconsistent")
    with connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        for entity in (source, target):
            normalized_label = _label(entity.label, "label").casefold()
            connection.execute(
                """INSERT INTO knowledge_graph_entities
                   (tenant_id, entity_id, entity_type, normalized_label, display_label)
                   VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (tenant_id, entity_id) DO NOTHING""",
                (tenant_id, entity.entity_id, entity.entity_type,
                 normalized_label, entity.label),
            )
            stored = connection.execute(
                """SELECT entity_type, normalized_label FROM knowledge_graph_entities
                   WHERE tenant_id=%s AND entity_id=%s""",
                (tenant_id, entity.entity_id),
            ).fetchone()
            if stored is None or stored[0] != entity.entity_type or stored[1] != normalized_label:
                raise InvalidGraphFact("entity ID conflicts with existing graph identity")
        connection.execute(
            """INSERT INTO knowledge_graph_facts
               (tenant_id, fact_id, source_entity_id, predicate, target_entity_id,
                document_id, document_version, chunk_id, span_start, span_end, trust, status)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'candidate')
               ON CONFLICT (tenant_id, fact_id) DO NOTHING""",
            (tenant_id, fact.edge_id, source.entity_id, fact.predicate, target.entity_id,
             fact.document_id, fact.document_version, fact.chunk_id,
             fact.span_start, fact.span_end, fact.trust),
        )
        provenance = connection.execute(
            """SELECT 1 FROM knowledge_outline_chunks c
               JOIN knowledge_document_outlines o USING (tenant_id, document_id, document_version)
               JOIN knowledge_documents d USING (tenant_id, document_id)
               WHERE c.tenant_id=%s AND c.document_id=%s AND c.document_version=%s
                 AND c.chunk_id=%s AND o.document_version=%s
                 AND d.current_version=c.document_version AND d.deleted_at IS NULL""",
            (tenant_id, fact.document_id, fact.document_version,
             fact.chunk_id, fact.document_version),
        ).fetchone()
        if provenance is None:
            raise InvalidGraphFact("graph provenance chunk is not in the current outline")


def retrieve_reviewed_facts(
    connection: Connection, *, tenant_id: str, start_entity_id: str,
    authorized_chunk_ids: set[str], max_depth: int = 2, max_facts: int = 20,
) -> tuple[dict[str, Any], ...]:
    """Traverse authorized chunks, checking current versions/deletion each hop."""
    from .graph import _uuid

    _uuid(tenant_id, "tenant_id")
    _uuid(start_entity_id, "start_entity_id")
    if type(max_depth) is not int or not 1 <= max_depth <= 2 or type(max_facts) is not int or not 1 <= max_facts <= 100:
        raise InvalidGraphFact("traversal bounds exceeded")
    for chunk_id in authorized_chunk_ids:
        _uuid(chunk_id, "authorized_chunk_id")
    if not authorized_chunk_ids:
        return ()
    results: list[dict[str, Any]] = []
    frontier = {start_entity_id}
    seen: set[str] = set()
    with connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        for _ in range(max_depth):
            if not frontier:
                break
            rows = connection.execute(
                """SELECT f.fact_id, f.source_entity_id, f.predicate, f.target_entity_id,
                          f.document_id, f.document_version, f.chunk_id,
                          f.span_start, f.span_end, f.trust
                   FROM knowledge_graph_facts f
                   JOIN knowledge_document_outlines o
                     ON o.tenant_id=f.tenant_id AND o.document_id=f.document_id
                    AND o.document_version=f.document_version
                   JOIN knowledge_outline_chunks c
                     ON c.tenant_id=f.tenant_id AND c.document_id=f.document_id
                    AND c.document_version=f.document_version AND c.chunk_id=f.chunk_id
                   JOIN knowledge_documents d ON d.tenant_id=f.tenant_id
                    AND d.document_id=f.document_id AND d.current_version=f.document_version
                    AND d.deleted_at IS NULL
                   WHERE f.tenant_id=%s AND f.source_entity_id = ANY(%s::uuid[])
                     AND f.status='reviewed' AND f.chunk_id = ANY(%s::uuid[])
                     AND NOT (f.fact_id = ANY(%s::uuid[]))
                   ORDER BY f.fact_id LIMIT %s""",
                (tenant_id, list(frontier), list(authorized_chunk_ids), list(seen), max_facts - len(results)),
            ).fetchall()
            next_frontier: set[str] = set()
            for row in rows:
                fact_id = str(row[0])
                if fact_id in seen:
                    continue
                seen.add(fact_id)
                results.append({
                    "fact_id": row[0], "source_entity_id": str(row[1]),
                    "predicate": row[2], "target_entity_id": str(row[3]),
                    "document_id": str(row[4]), "document_version": row[5],
                    "chunk_id": str(row[6]), "span_start": row[7],
                    "span_end": row[8], "trust": row[9],
                })
                next_frontier.add(str(row[3]))
            frontier = next_frontier
            if len(results) >= max_facts:
                break
    return tuple(results)
