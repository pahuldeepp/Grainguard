"""Bounded hard deletion for conversations that passed their recovery window.

The worker is configured with an explicit tenant allowlist. It scopes every
transaction using the same forced-RLS settings as the API and deletes only
soft-deleted rows older than the configured retention period. Message and
citation rows are removed by the schema's ON DELETE CASCADE constraints.
"""

from __future__ import annotations

from typing import Any, Callable


def purge_expired_deleted_conversations(
    connect: Callable[[], Any], *, scopes: list[dict[str, str]],
    retention_days: int = 30, batch_size: int = 100,
) -> int:
    """Purge at most ``batch_size`` expired conversations per user/tenant.

    Tenant and user identities come from the worker's protected scope list,
    never from an API request. Batches use
    ``FOR UPDATE SKIP LOCKED`` so replicas can safely share the job.
    """
    if type(retention_days) is not int or not 1 <= retention_days <= 3650:
        raise ValueError("retention_days must be between 1 and 3650")
    if type(batch_size) is not int or not 1 <= batch_size <= 1000:
        raise ValueError("batch_size must be between 1 and 1000")
    if not isinstance(scopes, list) or not scopes:
        raise ValueError("scopes must be a non-empty list")
    purged = 0
    with connect() as connection:
        unique_scopes = {(scope.get("tenant_id"), scope.get("user_id")) for scope in scopes
                         if isinstance(scope, dict)}
        if len(unique_scopes) != len(scopes) or any(not tenant or not user for tenant, user in unique_scopes):
            raise ValueError("each scope must have tenant_id and user_id")
        for tenant_id, user_id in sorted(unique_scopes):
            with connection.transaction():
                connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                connection.execute("SELECT set_config('app.user_id', %s, true)", (user_id,))
                rows = connection.execute(
                    """WITH expired AS (
                           SELECT ctid FROM assistant_conversations
                           WHERE tenant_id=%s AND user_id=%s AND deleted_at IS NOT NULL
                             AND deleted_at < clock_timestamp() - (%s * interval '1 day')
                           ORDER BY deleted_at, conversation_id
                           LIMIT %s FOR UPDATE SKIP LOCKED
                       )
                       DELETE FROM assistant_conversations AS conversation
                       USING expired WHERE conversation.ctid=expired.ctid
                       RETURNING conversation.conversation_id""",
                    (tenant_id, user_id, retention_days, batch_size),
                ).fetchall()
                purged += len(rows)
    return purged
