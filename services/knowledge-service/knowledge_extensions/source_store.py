"""Canonical versioned document/chunk persistence and index outbox writes."""

from __future__ import annotations

import re
from typing import Any, Protocol
from uuid import UUID, uuid4
from hashlib import sha256

from .outline_store import save_outline
from .pdf_parser import ParsedPdf


class SourceVersionConflict(ValueError):
    """A source version is stale or was already associated with other bytes."""


def save_pdf_upload(connection: SourceConnection, *, tenant_id: str, document_id: str,
                    document_version: int, pdf_bytes: bytes, source_object_key: str,
                    min_role: str = "viewer", acl_principals: set[str] | None = None,
                    principal_id: str | None = None, principal_role: str | None = None,
                    source_file_name: str | None = None) -> tuple[str, bool]:
    """Commit a queued version and ID-only indexing event after the object upload."""
    if (principal_id is None)!=(principal_role is None):
        raise ValueError("complete upload caller identity required")
    if principal_role is not None and principal_role not in {"operator","admin"}:
        raise PermissionError("upload requires an operator membership")
    from .document_access import safe_pdf_name
    source_file_name = safe_pdf_name(source_file_name)
    digest = sha256(pdf_bytes).hexdigest()
    expected = f"tenant/{tenant_id}/documents/{document_id}/versions/{document_version}/objects/"
    if (not source_object_key.startswith(expected) or not re.fullmatch(
        re.escape(expected) + r"[0-9a-f-]{36}/" + digest + r"\.pdf", source_object_key
    )):
        raise ValueError("source object key does not match uploaded PDF")
    if min_role not in {"viewer", "operator", "admin"}:
        raise ValueError("min_role is invalid")
    principals = acl_principals or set()
    for principal in principals:
        try:
            if str(UUID(principal)) != principal:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise ValueError("ACL principals must be canonical UUIDs") from exc
    event_id = str(uuid4())
    with connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        connection.execute(
            """INSERT INTO knowledge_documents (tenant_id,document_id,current_version,latest_version,min_role,acl_principals)
               VALUES (%s,%s,0,0,%s,%s) ON CONFLICT (tenant_id,document_id) DO NOTHING""",
            (tenant_id, document_id, min_role, sorted(principals)),
        )
        row = connection.execute(
            "SELECT latest_version,min_role,acl_principals,deleted_at FROM knowledge_documents WHERE tenant_id=%s AND document_id=%s FOR UPDATE",
            (tenant_id, document_id),
        ).fetchone()
        if row is None:
            raise RuntimeError("document parent disappeared during upload")
        if row[3] is not None:
            raise SourceVersionConflict("deleted document cannot accept a new version")
        if principal_role is not None:
            levels={"viewer":1,"operator":2,"admin":3}
            if row[3] is not None or levels[principal_role]<levels[row[1]] or (row[2] and principal_id not in {str(p) for p in row[2]}):
                raise PermissionError("document upload is not authorized")
            # HTTP version updates preserve the parent's authorization policy.
            min_role=row[1]
            principals={str(p) for p in row[2]}
        current = int(row[0])
        if current >= document_version:
            prior = connection.execute(
                """SELECT source_sha256 FROM knowledge_document_versions
                   WHERE tenant_id=%s AND document_id=%s AND document_version=%s""",
                (tenant_id, document_id, document_version),
            ).fetchone()
            if current == document_version and prior and prior[0].strip() == digest:
                existing = connection.execute(
                    """SELECT event_id::text FROM knowledge_index_outbox
                       WHERE tenant_id=%s AND document_id=%s AND document_version=%s""",
                    (tenant_id, document_id, document_version),
                ).fetchone()
                return (str(existing[0]) if existing else "", False)
            raise SourceVersionConflict("document version is stale or has different source bytes")
        if document_version != current + 1:
            raise SourceVersionConflict("document versions must advance by exactly one")
        connection.execute(
            """UPDATE knowledge_documents SET latest_version=%s
               WHERE tenant_id=%s AND document_id=%s""",
            (document_version, tenant_id, document_id),
        )
        connection.execute(
            """INSERT INTO knowledge_document_versions
               (tenant_id,document_id,document_version,source_sha256,media_type,source_object_key,
                min_role,acl_principals,processing_status,source_file_name)
               VALUES (%s,%s,%s,%s,'application/pdf',%s,%s,%s,'queued',%s)""",
            (tenant_id, document_id, document_version, digest, source_object_key,
             min_role, sorted(principals), source_file_name),
        )
        connection.execute(
            """INSERT INTO knowledge_index_outbox
               (event_id,tenant_id,document_id,document_version,chunk_ids)
               VALUES (%s,%s,%s,%s,'{}')""",
            (event_id, tenant_id, document_id, document_version),
        )
    return event_id, True


def load_index_source(connection: SourceConnection, *, tenant_id: str, document_id: str,
                      document_version: int, event_id: str) -> dict[str, Any] | None:
    """Load tenant-scoped source metadata for an already validated Kafka event."""
    with connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        row = connection.execute(
            """SELECT v.source_sha256,v.source_object_key,v.processing_status,o.processed_at,
                      d.latest_version,d.deleted_at
               FROM knowledge_document_versions v JOIN knowledge_index_outbox o USING
               (tenant_id,document_id,document_version)
               JOIN knowledge_documents d USING (tenant_id,document_id)
               WHERE v.tenant_id=%s AND v.document_id=%s AND v.document_version=%s AND o.event_id=%s""",
            (tenant_id, document_id, document_version, event_id),
        ).fetchone()
    if row is None:
        return None
    return {"source_sha256": row[0].strip(), "source_object_key": row[1],
            "processing_status": row[2], "processed": row[3] is not None,
            "latest_version": int(row[4]), "deleted": row[5] is not None}


def save_parsed_content(connection: SourceConnection, *, parsed: ParsedPdf, event_id: str) -> None:
    """Persist worker-produced canonical chunks and outline for a queued upload."""
    with connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (parsed.tenant_id,))
        parent = connection.execute(
            "SELECT deleted_at,latest_version FROM knowledge_documents WHERE tenant_id=%s AND document_id=%s FOR UPDATE",
            (parsed.tenant_id, parsed.document_id),
        ).fetchone()
        if parent is None or parent[0] is not None or parent[1] != parsed.document_version:
            raise SourceVersionConflict("document is deleted or parsing version is stale")
        row = connection.execute(
            """SELECT source_sha256,processing_status FROM knowledge_document_versions
               WHERE tenant_id=%s AND document_id=%s AND document_version=%s FOR UPDATE""",
            (parsed.tenant_id, parsed.document_id, parsed.document_version),
        ).fetchone()
        if row is None or row[0].strip() != parsed.source_sha256:
            raise SourceVersionConflict("worker PDF does not match the queued source version")
        if row[1] in {"parsed", "ready"}:
            return
        if row[1] != "queued":
            raise SourceVersionConflict("source version is not queued for parsing")
        for chunk in parsed.chunks:
            connection.execute(
                """INSERT INTO knowledge_chunks
                   (tenant_id,document_id,document_version,chunk_id,ordinal,content,content_sha256,
                    page_start,page_end,heading_path) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (tenant_id,document_id,document_version,chunk_id) DO NOTHING""",
                (parsed.tenant_id, parsed.document_id, parsed.document_version, chunk.chunk_id,
                 chunk.ordinal, chunk.content, chunk.content_sha256, chunk.page_start,
                 chunk.page_end, list(chunk.heading_path)),
            )
        save_outline(connection, tenant_id=parsed.tenant_id, outline=parsed.outline,
                     source_sha256=parsed.source_sha256)
        connection.execute(
            """UPDATE knowledge_document_versions SET processing_status='parsed'
               WHERE tenant_id=%s AND document_id=%s AND document_version=%s""",
            (parsed.tenant_id, parsed.document_id, parsed.document_version),
        )
        connection.execute(
            """UPDATE knowledge_index_outbox SET chunk_ids=%s
               WHERE tenant_id=%s AND document_id=%s AND document_version=%s AND event_id=%s""",
            ([chunk.chunk_id for chunk in parsed.chunks], parsed.tenant_id,
             parsed.document_id, parsed.document_version, event_id),
        )


class SourceConnection(Protocol):
    def transaction(self) -> Any: ...
    def execute(self, query: str, params: tuple[Any, ...] = ()) -> Any: ...


def save_parsed_pdf(
    connection: SourceConnection, *, parsed: ParsedPdf,
    min_role: str = "viewer", acl_principals: set[str] | None = None,
    source_object_key: str | None = None,
) -> bool:
    """Atomically store source version, canonical text, outline, and index event.

    Returns False for an idempotent retry. Vector indexing happens later from the
    outbox, so Postgres remains authoritative if a provider is unavailable.
    """
    if min_role not in {"viewer", "operator", "admin"}:
        raise ValueError("min_role is invalid")
    principals = acl_principals or set()
    for principal in principals:
        try:
            if str(UUID(principal)) != principal:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise ValueError("ACL principals must be canonical UUIDs") from exc
    if (parsed.outline.tenant_id != parsed.tenant_id
            or parsed.outline.document_id != parsed.document_id
            or parsed.outline.document_version != parsed.document_version
            or parsed.outline.chunk_ids != tuple(chunk.chunk_id for chunk in parsed.chunks)):
        raise ValueError("parsed PDF and its outline are inconsistent")

    tenant_id = parsed.tenant_id
    document_id = parsed.document_id
    version = parsed.document_version
    expected_object_key = (f"tenant/{tenant_id}/documents/{document_id}/"
                           f"versions/{version}/objects/")
    if (source_object_key is not None
            and (not source_object_key.startswith(expected_object_key)
                 or not re.fullmatch(re.escape(expected_object_key) +
                                     r"[0-9a-f-]{36}/[0-9a-f]{64}\.pdf", source_object_key)
                 or not source_object_key.endswith(f"/{parsed.source_sha256}.pdf"))):
        raise ValueError("source object key does not match parsed document identity")
    with connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        connection.execute(
            """INSERT INTO knowledge_documents
               (tenant_id, document_id, current_version, latest_version, min_role, acl_principals)
               VALUES (%s,%s,0,0,%s,%s) ON CONFLICT (tenant_id, document_id) DO NOTHING""",
            (tenant_id, document_id, min_role, sorted(principals)),
        )
        current = connection.execute(
            "SELECT latest_version,deleted_at FROM knowledge_documents WHERE tenant_id=%s AND document_id=%s FOR UPDATE",
            (tenant_id, document_id),
        ).fetchone()
        if current is None:
            raise RuntimeError("document parent disappeared during ingest")
        if current[1] is not None:
            raise SourceVersionConflict("deleted document cannot be restored by ingest")
        current_version = int(current[0])
        if current_version > version:
            raise SourceVersionConflict("an older document version cannot replace the current version")
        if current_version == version:
            stored = connection.execute(
                """SELECT source_sha256 FROM knowledge_document_versions
                   WHERE tenant_id=%s AND document_id=%s AND document_version=%s""",
                (tenant_id, document_id, version),
            ).fetchone()
            if stored is None or stored[0].strip() != parsed.source_sha256:
                raise SourceVersionConflict("same document version has different source bytes")
            return False
        if version != current_version + 1:
            raise SourceVersionConflict("document versions must advance by exactly one")

        connection.execute(
            """UPDATE knowledge_documents SET current_version=%s, latest_version=%s, min_role=%s,
                      acl_principals=%s, deleted_at=NULL
               WHERE tenant_id=%s AND document_id=%s""",
            (version, version, min_role, sorted(principals), tenant_id, document_id),
        )
        connection.execute(
            """INSERT INTO knowledge_document_versions
               (tenant_id, document_id, document_version, source_sha256, media_type, source_object_key,
                min_role,acl_principals,processing_status)
               VALUES (%s,%s,%s,%s,'application/pdf',%s,%s,%s,'parsed')""",
            (tenant_id, document_id, version, parsed.source_sha256, source_object_key,
             min_role, sorted(principals)),
        )
        for chunk in parsed.chunks:
            connection.execute(
                """INSERT INTO knowledge_chunks
                   (tenant_id, document_id, document_version, chunk_id, ordinal,
                    content, content_sha256, page_start, page_end, heading_path)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (tenant_id, document_id, version, chunk.chunk_id, chunk.ordinal,
                 chunk.content, chunk.content_sha256, chunk.page_start,
                 chunk.page_end, list(chunk.heading_path)),
            )
        save_outline(connection, tenant_id=tenant_id, outline=parsed.outline,
                     source_sha256=parsed.source_sha256)
        connection.execute(
            """INSERT INTO knowledge_index_outbox
               (event_id, tenant_id, document_id, document_version, chunk_ids)
               VALUES (%s,%s,%s,%s,%s)""",
            (str(uuid4()), tenant_id, document_id, version,
             [chunk.chunk_id for chunk in parsed.chunks]),
        )
    return True
