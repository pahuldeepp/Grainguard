"""Tenant-scoped PostgreSQL persistence for the rebuildable outline projection."""

from __future__ import annotations

import re
from typing import Any, Protocol

from .outline import DocumentOutline, OutlineNode


_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class StaleOutlineVersion(ValueError):
    """An older parser result attempted to replace the current outline."""


class OutlineVersionConflict(ValueError):
    """One document version was associated with different source content."""


class Cursor(Protocol):
    def execute(self, query: str, params: tuple[Any, ...] = ()) -> Any: ...
    def fetchone(self) -> Any: ...


class TransactionConnection(Protocol):
    def transaction(self) -> Any: ...
    def execute(self, query: str, params: tuple[Any, ...] = ()) -> Cursor: ...


def _flatten(nodes: tuple[OutlineNode, ...] | list[OutlineNode], parent: str | None = None):
    rows = []
    for ordinal, node in enumerate(nodes):
        rows.append((node, parent, ordinal))
        rows.extend(_flatten(node.children, node.node_id))
    return rows


def save_outline(
    connection: TransactionConnection, *, tenant_id: str,
    outline: DocumentOutline, source_sha256: str,
) -> None:
    """Atomically replace one version's outline under the trusted tenant context."""
    if tenant_id != outline.tenant_id:
        raise ValueError("outline tenant must match trusted transaction tenant")
    if not isinstance(source_sha256, str) or not _SHA256.fullmatch(source_sha256):
        raise ValueError("source_sha256 must be lowercase SHA-256")
    node_rows = _flatten(outline.roots)
    citation_by_chunk = {citation.chunk_id: citation for citation in outline.citations}
    node_by_chunk = {
        chunk_id: node.node_id
        for node, _parent, _ordinal in node_rows
        for chunk_id in node.chunk_ids
    }
    if set(node_by_chunk) != set(citation_by_chunk) or set(node_by_chunk) != set(outline.chunk_ids):
        raise ValueError("outline nodes and citation metadata are inconsistent")

    with connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        connection.execute(
            """INSERT INTO knowledge_document_outlines
               (tenant_id, document_id, document_version, source_sha256)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (tenant_id, document_id, document_version) DO NOTHING""",
            (tenant_id, outline.document_id, outline.document_version, source_sha256),
        )
        current = connection.execute(
            """SELECT document_version, source_sha256
               FROM knowledge_document_outlines
               WHERE tenant_id=%s AND document_id=%s AND document_version=%s FOR UPDATE""",
            (tenant_id, outline.document_id, outline.document_version),
        ).fetchone()
        if current is None:
            raise RuntimeError("outline parent row disappeared during replacement")
        current_hash = current[1].strip()
        if current_hash != source_sha256:
            raise OutlineVersionConflict("same document version has different source hash")

        # Cascades remove prior node and chunk citation rows for this document.
        connection.execute(
            """DELETE FROM knowledge_outline_nodes WHERE tenant_id=%s AND document_id=%s
               AND document_version=%s""",
            (tenant_id, outline.document_id, outline.document_version),
        )
        for node, parent_id, ordinal in node_rows:
            connection.execute(
                """INSERT INTO knowledge_outline_nodes
                   (tenant_id, document_id, document_version, node_id, parent_node_id,
                    ordinal, title, level, page_start, page_end)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (tenant_id, outline.document_id, outline.document_version,
                 node.node_id, parent_id, ordinal, node.title, node.level,
                 node.page_start, node.page_end),
            )
            for chunk_id in node.chunk_ids:
                citation = citation_by_chunk[chunk_id]
                connection.execute(
                    """INSERT INTO knowledge_outline_chunks
                       (tenant_id, document_id, document_version, node_id, chunk_id,
                        page_start, page_end, heading_path)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (tenant_id, outline.document_id, outline.document_version,
                     node.node_id, chunk_id, citation.page_start,
                     citation.page_end, list(citation.heading_path)),
                )


def delete_outline(
    connection: TransactionConnection, *, tenant_id: str, document_id: str,
) -> None:
    """Remove outline rows for a document after source deletion/tombstoning."""
    with connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        connection.execute(
            "DELETE FROM knowledge_document_outlines WHERE tenant_id=%s AND document_id=%s",
            (tenant_id, document_id),
        )
