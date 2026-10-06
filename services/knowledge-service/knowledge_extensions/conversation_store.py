"""Tenant- and principal-scoped durable assistant conversation storage.

Callers must pass tenant_id and principal_id from verified authentication. The
repository repeats that scope in every query and sets transaction-local RLS
settings; client-provided identity must never be forwarded here.
"""

from __future__ import annotations

import re
from typing import Any, Protocol
from uuid import uuid4


_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_MAX_CONTENT = 20_000
_GENERATED_TITLE_LENGTH = 56
_MAX_CITATIONS = 100


class Cursor(Protocol):
    def fetchone(self) -> Any: ...
    def fetchall(self) -> Any: ...


class Connection(Protocol):
    def transaction(self) -> Any: ...
    def execute(self, query: str, params: tuple[Any, ...] = ()) -> Cursor: ...


def _uuid(value: str, name: str) -> str:
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise ValueError(f"{name} must be a canonical UUID")
    return value


def _scope(connection: Connection, tenant_id: str, principal_id: str) -> None:
    connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
    connection.execute("SELECT set_config('app.user_id', %s, true)", (principal_id,))


def _title_from_message(message: str) -> str:
    """Build a compact sidebar title from a user's first message."""
    normalized = " ".join(message.split())
    if len(normalized) <= _GENERATED_TITLE_LENGTH:
        return normalized
    return normalized[:_GENERATED_TITLE_LENGTH - 3].rstrip() + "..."


def _row(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "conversation_id": str(row[0]), "title": row[1],
        "created_at": row[2], "updated_at": row[3],
        "last_message_at": row[4],
    }


def create_conversation(
    connection: Connection, *, tenant_id: str, principal_id: str,
    title: str = "New chat",
) -> dict[str, Any]:
    """Create an empty conversation for the authenticated tenant/principal."""
    tenant_id = _uuid(tenant_id, "tenant_id")
    principal_id = _uuid(principal_id, "principal_id")
    if not isinstance(title, str) or not title.strip() or len(title) > 2_000:
        raise ValueError("title must contain 1-2000 characters")
    title = "New chat" if title == "New chat" else _title_from_message(title)
    conversation_id = str(uuid4())
    with connection.transaction():
        _scope(connection, tenant_id, principal_id)
        row = connection.execute(
            """INSERT INTO assistant_conversations
               (tenant_id,user_id,conversation_id,title)
               VALUES (%s,%s,%s,%s)
               RETURNING conversation_id::text,title,created_at,updated_at,last_message_at""",
            (tenant_id, principal_id, conversation_id, title.strip()),
        ).fetchone()
        if row is None:
            raise RuntimeError("conversation insert returned no row")
    return _row(row)  # type: ignore[return-value]


def list_conversations(
    connection: Connection, *, tenant_id: str, principal_id: str, limit: int = 50,
) -> list[dict[str, Any]]:
    """List recent non-deleted conversations belonging to this principal."""
    tenant_id = _uuid(tenant_id, "tenant_id")
    principal_id = _uuid(principal_id, "principal_id")
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100")
    with connection.transaction():
        _scope(connection, tenant_id, principal_id)
        rows = connection.execute(
            """SELECT conversation_id::text,title,created_at,updated_at,last_message_at
               FROM assistant_conversations
               WHERE tenant_id=%s AND user_id=%s AND deleted_at IS NULL
               ORDER BY last_message_at DESC NULLS LAST,updated_at DESC,conversation_id
               LIMIT %s""",
            (tenant_id, principal_id, limit),
        ).fetchall()
    return [_row(row) for row in rows]


def get_conversation(
    connection: Connection, *, tenant_id: str, principal_id: str,
    conversation_id: str,
) -> dict[str, Any] | None:
    """Fetch one owned conversation, its messages, and per-message citations."""
    tenant_id = _uuid(tenant_id, "tenant_id")
    principal_id = _uuid(principal_id, "principal_id")
    conversation_id = _uuid(conversation_id, "conversation_id")
    with connection.transaction():
        _scope(connection, tenant_id, principal_id)
        conversation = connection.execute(
            """SELECT conversation_id::text,title,created_at,updated_at,last_message_at
               FROM assistant_conversations WHERE tenant_id=%s AND user_id=%s
                 AND conversation_id=%s AND deleted_at IS NULL""",
            (tenant_id, principal_id, conversation_id),
        ).fetchone()
        if conversation is None:
            return None
        messages = connection.execute(
            """SELECT message_id::text,role,content,model,token_count,created_at
               FROM (
                   SELECT message_id,role,content,model,token_count,created_at
                   FROM assistant_messages WHERE tenant_id=%s AND user_id=%s AND conversation_id=%s
                   ORDER BY created_at DESC,message_id DESC LIMIT 100
               ) recent ORDER BY created_at,message_id""",
            (tenant_id, principal_id, conversation_id),
        ).fetchall()
        message_ids = [str(message[0]) for message in messages]
        citations_by_message: dict[str, list[dict[str, Any]]] = {key: [] for key in message_ids}
        if message_ids:
            citations = connection.execute(
                """SELECT message_id::text,document_id::text,document_version,chunk_id::text,
                          page_start,page_end,heading_path,trust,citation_ordinal
                   FROM assistant_message_citations WHERE tenant_id=%s AND user_id=%s
                     AND conversation_id=%s AND message_id = ANY(%s::uuid[])
                   ORDER BY message_id,citation_ordinal""",
                (tenant_id, principal_id, conversation_id, message_ids),
            ).fetchall()
            for citation in citations:
                citations_by_message.setdefault(str(citation[0]), []).append({
                    "document_id": str(citation[1]), "document_version": citation[2],
                    "chunk_id": str(citation[3]), "page_start": citation[4],
                    "page_end": citation[5], "heading_path": list(citation[6]),
                    "trust": citation[7],
                })
    result = _row(conversation)
    result["messages"] = [{
        "message_id": str(message[0]), "role": message[1], "content": message[2],
        "model": message[3], "token_count": message[4], "created_at": message[5],
        "citations": citations_by_message.get(str(message[0]), []),
    } for message in messages]
    return result


def conversation_exists(
    connection: Connection, *, tenant_id: str, principal_id: str,
    conversation_id: str,
) -> bool:
    """Check ownership before spending provider calls on a message request."""
    tenant_id = _uuid(tenant_id, "tenant_id")
    principal_id = _uuid(principal_id, "principal_id")
    conversation_id = _uuid(conversation_id, "conversation_id")
    with connection.transaction():
        _scope(connection, tenant_id, principal_id)
        row = connection.execute(
            """SELECT 1 FROM assistant_conversations WHERE tenant_id=%s AND user_id=%s
                 AND conversation_id=%s AND deleted_at IS NULL""",
            (tenant_id, principal_id, conversation_id),
        ).fetchone()
    return row is not None


def append_turn(
    connection: Connection, *, tenant_id: str, principal_id: str,
    conversation_id: str, question: str, answer: str,
    citations: list[dict[str, Any]] | tuple[dict[str, Any], ...] = (),
    model: str | None = None, token_count: int | None = None,
) -> dict[str, str]:
    """Atomically append a completed user/assistant turn and its citations.

    Run RAG before calling this method so provider latency is outside the DB
    transaction. The question, answer and citation rows are then committed as a
    single unit; a failed citation insert rolls back both messages.
    """
    tenant_id = _uuid(tenant_id, "tenant_id")
    principal_id = _uuid(principal_id, "principal_id")
    conversation_id = _uuid(conversation_id, "conversation_id")
    if not isinstance(question, str) or not question.strip() or len(question) > _MAX_CONTENT:
        raise ValueError("question must contain 1-20000 characters")
    if not isinstance(answer, str) or not answer.strip() or len(answer) > _MAX_CONTENT:
        raise ValueError("answer must contain 1-20000 characters")
    if model is not None and (not isinstance(model, str) or not model or len(model) > 128):
        raise ValueError("model must contain 1-128 characters")
    if token_count is not None and (type(token_count) is not int or token_count < 0):
        raise ValueError("token_count must be a non-negative integer")
    if not isinstance(citations, (list, tuple)) or len(citations) > _MAX_CITATIONS:
        raise ValueError("citations must be a list of at most 100 entries")
    normalized: list[tuple[Any, ...]] = []
    for citation in citations:
        if not isinstance(citation, dict):
            raise ValueError("citation must be an object")
        document_id = _uuid(citation.get("document_id"), "citation.document_id")
        chunk_id = _uuid(citation.get("chunk_id"), "citation.chunk_id")
        version = citation.get("document_version")
        page_start, page_end = citation.get("page_start"), citation.get("page_end")
        path, trust = citation.get("heading_path", []), citation.get("trust")
        if type(version) is not int or version < 1:
            raise ValueError("citation document_version must be positive")
        if type(page_start) is not int or page_start < 1 or type(page_end) is not int or page_end < page_start:
            raise ValueError("citation page range is invalid")
        if not isinstance(path, (list, tuple)) or len(path) > 64 or any(not isinstance(item, str) or len(item) > 240 for item in path):
            raise ValueError("citation heading_path is invalid")
        if trust not in {"curated", "licensed", "tenant_uploaded"}:
            raise ValueError("citation trust is invalid")
        normalized.append((document_id, version, chunk_id, page_start, page_end, list(path), trust))

    user_message_id, assistant_message_id = str(uuid4()), str(uuid4())
    with connection.transaction():
        _scope(connection, tenant_id, principal_id)
        conversation = connection.execute(
            """SELECT title FROM assistant_conversations WHERE tenant_id=%s AND user_id=%s
               AND conversation_id=%s AND deleted_at IS NULL FOR UPDATE""",
            (tenant_id, principal_id, conversation_id),
        ).fetchone()
        if conversation is None:
            raise LookupError("conversation not found")
        connection.execute(
            """INSERT INTO assistant_messages
               (tenant_id,user_id,conversation_id,message_id,role,content)
               VALUES (%s,%s,%s,%s,'user',%s)""",
            (tenant_id, principal_id, conversation_id, user_message_id, question.strip()),
        )
        connection.execute(
            """INSERT INTO assistant_messages
               (tenant_id,user_id,conversation_id,message_id,role,content,model,token_count)
               VALUES (%s,%s,%s,%s,'assistant',%s,%s,%s)""",
            (tenant_id, principal_id, conversation_id, assistant_message_id,
             answer.strip(), model, token_count),
        )
        for ordinal, citation in enumerate(normalized):
            connection.execute(
                """INSERT INTO assistant_message_citations
                   (tenant_id,user_id,conversation_id,message_id,citation_ordinal,document_id,
                    document_version,chunk_id,page_start,page_end,heading_path,trust)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (tenant_id, principal_id, conversation_id, assistant_message_id, ordinal, *citation),
            )
        connection.execute(
            """UPDATE assistant_conversations SET
                   title=CASE WHEN title='New chat' THEN %s ELSE title END,
                   updated_at=clock_timestamp(),last_message_at=clock_timestamp()
               WHERE tenant_id=%s AND user_id=%s AND conversation_id=%s AND deleted_at IS NULL""",
            (_title_from_message(question), tenant_id, principal_id, conversation_id),
        )
    return {"user_message_id": user_message_id, "assistant_message_id": assistant_message_id}


def soft_delete_conversation(
    connection: Connection, *, tenant_id: str, principal_id: str,
    conversation_id: str,
) -> bool:
    """Hide an owned conversation immediately; its data remains recoverable."""
    tenant_id = _uuid(tenant_id, "tenant_id")
    principal_id = _uuid(principal_id, "principal_id")
    conversation_id = _uuid(conversation_id, "conversation_id")
    with connection.transaction():
        _scope(connection, tenant_id, principal_id)
        row = connection.execute(
            """UPDATE assistant_conversations SET deleted_at=clock_timestamp(),
                   updated_at=clock_timestamp() WHERE tenant_id=%s AND user_id=%s
                 AND conversation_id=%s AND deleted_at IS NULL RETURNING conversation_id""",
            (tenant_id, principal_id, conversation_id),
        ).fetchone()
    return row is not None
