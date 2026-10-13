"""Transactional lifecycle intents and retryable private resource cleanup.

Every writer locks the parent document before the job. Workers hold that lock
through bounded provider calls: a deleted version cannot be concurrently indexed
again after cleanup. Rollback after provider success safely repeats ID deletes.
Source retention is opt-in and uses an operator supplied policy, never defaults.
"""
from hashlib import sha256
from uuid import uuid4

from .retrieval import _set_tenant, tenant_namespace
from .redaction import redact_passages, redact_text


def enqueue_vectors(connection, *, tenant_id, document_id, before_version=None):
    connection.execute("""INSERT INTO knowledge_lifecycle_outbox
      (tenant_id,event_id,document_id,document_version,operation,chunk_ids)
      SELECT v.tenant_id,gen_random_uuid(),v.document_id,v.document_version,'vectors',
        ARRAY(SELECT c.chunk_id FROM knowledge_chunks c WHERE c.tenant_id=v.tenant_id
          AND c.document_id=v.document_id AND c.document_version=v.document_version)
      FROM knowledge_document_versions v WHERE v.tenant_id=%s AND v.document_id=%s
        AND (%s::bigint IS NULL OR v.document_version < %s)
      ON CONFLICT (tenant_id,document_id,document_version,operation) DO UPDATE
        SET completed_at=NULL,available_at=clock_timestamp(),chunk_ids=EXCLUDED.chunk_ids""",
      (tenant_id,document_id,before_version,before_version))


def enqueue_retention(connection, *, tenant_id, retention_days, batch_size=100):
    """Schedule sources only after a caller's existing deletion policy expires."""
    if type(retention_days) is not int or not 1 <= retention_days <= 3650:
        raise ValueError('explicit retention policy must be 1-3650 days')
    if type(batch_size) is not int or not 1 <= batch_size <= 1000:
        raise ValueError('retention batch must be 1-1000')
    with connection.transaction():
        _set_tenant(connection,tenant_id)
        rows=connection.execute("""SELECT d.document_id::text FROM knowledge_documents d
          WHERE d.tenant_id=%s AND d.deleted_at <= clock_timestamp() - (%s * interval '1 day')
            AND EXISTS (SELECT 1 FROM knowledge_document_versions v
              WHERE v.tenant_id=d.tenant_id AND v.document_id=d.document_id
                AND v.source_object_key IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM knowledge_lifecycle_outbox o
                  WHERE o.tenant_id=v.tenant_id AND o.document_id=v.document_id
                    AND o.document_version=v.document_version AND o.operation='source'))
          ORDER BY d.deleted_at,d.document_id LIMIT %s FOR UPDATE OF d SKIP LOCKED""",
          (tenant_id,retention_days,batch_size)).fetchall()
        for row in rows:
            connection.execute("""INSERT INTO knowledge_lifecycle_outbox
              (tenant_id,event_id,document_id,document_version,operation,source_object_key)
              SELECT tenant_id,gen_random_uuid(),document_id,document_version,'source',source_object_key
              FROM knowledge_document_versions WHERE tenant_id=%s AND document_id=%s
                AND source_object_key IS NOT NULL
              ON CONFLICT (tenant_id,document_id,document_version,operation) DO NOTHING""",
              (tenant_id,str(row[0])))
    return len(rows)


def process_cleanup(connection, *, tenant_id, event_id, vector_store, object_store, namespace_key, retention_days=None):
    """Process exactly one tenant intent. Exceptions keep it pending for retry."""
    with connection.transaction():
        _set_tenant(connection,tenant_id)
        binding=connection.execute("""SELECT document_id::text FROM knowledge_lifecycle_outbox
          WHERE tenant_id=%s AND event_id=%s""",(tenant_id,event_id)).fetchone()
        if binding is None:
            return False
        document_id=str(binding[0])
        parent=connection.execute("""SELECT deleted_at,current_version FROM knowledge_documents
          WHERE tenant_id=%s AND document_id=%s FOR UPDATE""",(tenant_id,document_id)).fetchone()
        job=connection.execute("""SELECT document_version,operation,chunk_ids,source_object_key
          FROM knowledge_lifecycle_outbox WHERE tenant_id=%s AND event_id=%s
          AND completed_at IS NULL AND available_at <= clock_timestamp() FOR UPDATE""",
          (tenant_id,event_id)).fetchone()
        if job is None:
            return False
        version,operation,ids,key=job
        if parent is None or (parent[0] is None and version >= parent[1]):
            raise ValueError('cleanup cannot remove a live document version')
        if operation=='vectors':
            namespace=tenant_namespace(tenant_id,namespace_key)
            for start in range(0,len(ids),1000):
                vector_store.delete(namespace=namespace,chunk_ids=[str(i) for i in ids[start:start+1000]])
        elif operation=='source':
            if type(retention_days) is not int or not 1<=retention_days<=3650:
                raise ValueError('source retention requires an explicit current policy')
            expired=connection.execute("""SELECT deleted_at <= clock_timestamp() - (%s * interval '1 day')
              FROM knowledge_documents WHERE tenant_id=%s AND document_id=%s""",
              (retention_days,tenant_id,document_id)).fetchone()
            if not expired or expired[0] is not True:
                raise ValueError('source retention policy has not expired')
            if parent[0] is None:
                raise ValueError('source retention requires a deleted document')
            pending=connection.execute("""SELECT event_id FROM knowledge_lifecycle_outbox
              WHERE tenant_id=%s AND document_id=%s AND document_version=%s
                AND operation='vectors' AND completed_at IS NOT NULL""",
              (tenant_id,document_id,version)).fetchone()
            if pending is None:
                raise ValueError('vector cleanup must finish before source retention')
            prefix=f'tenant/{tenant_id}/documents/{document_id}/versions/{version}/objects/'
            if key and not key.startswith(prefix):
                raise ValueError('source binding is invalid')
            if key:
                object_store.delete_pdf(key)
            connection.execute("""DELETE FROM knowledge_document_versions
              WHERE tenant_id=%s AND document_id=%s AND document_version=%s""",
              (tenant_id,document_id,version))
        else:
            raise ValueError('unsupported lifecycle operation')
        connection.execute("""UPDATE knowledge_lifecycle_outbox SET completed_at=clock_timestamp()
          WHERE tenant_id=%s AND event_id=%s""",(tenant_id,event_id))
    return True


def record_cleanup_failure(connection, *, tenant_id, event_id):
    """Content-free exponential backoff; pending jobs are never silently discarded."""
    with connection.transaction():
        _set_tenant(connection,tenant_id)
        connection.execute("""UPDATE knowledge_lifecycle_outbox SET attempts=attempts+1,
          available_at=clock_timestamp() + (LEAST(3600,power(2,LEAST(attempts+1,12))) * interval '1 second')
          WHERE tenant_id=%s AND event_id=%s AND completed_at IS NULL""",(tenant_id,event_id))


def reindex_redacted_document(connection, *, tenant_id, document_id, expected_version):
    """Explicit historical sanitization, preserving source bytes and document ACL.

    Revoke ready status while reindexing; chunk hashes invalidate retrieval caches.
    Old vectors are queued for deletion. Current vectors use identical IDs so
    retrying the new outbox event overwrites them without creating duplicates.
    """
    with connection.transaction():
        _set_tenant(connection,tenant_id)
        parent=connection.execute("""SELECT current_version,latest_version,deleted_at
          FROM knowledge_documents WHERE tenant_id=%s AND document_id=%s FOR UPDATE""",
          (tenant_id,document_id)).fetchone()
        if parent is None or parent[2] is not None or parent[0]!=expected_version or parent[1]!=expected_version:
            raise ValueError('document changed before reindex')
        rows=connection.execute("""SELECT document_version,chunk_id::text,content,heading_path FROM knowledge_chunks
          WHERE tenant_id=%s AND document_id=%s ORDER BY document_version,ordinal""",
          (tenant_id,document_id)).fetchall()
        # Process each version independently so adjacent-chunk detection does not
        # join unrelated source versions.
        for version in sorted({row[0] for row in rows}):
            batch=[row for row in rows if row[0]==version]
            safe=redact_passages([row[2] for row in batch])
            for row,text in zip(batch,safe,strict=True):
                connection.execute("""UPDATE knowledge_chunks SET content=%s,content_sha256=%s,heading_path=%s
                  WHERE tenant_id=%s AND document_id=%s AND document_version=%s AND chunk_id=%s""",
                  (text,sha256(text.encode()).hexdigest(),[redact_text(h) for h in row[3]],tenant_id,document_id,version,row[1]))
        links=connection.execute("""SELECT document_version,chunk_id::text,heading_path FROM knowledge_outline_chunks
          WHERE tenant_id=%s AND document_id=%s""",(tenant_id,document_id)).fetchall()
        for version,chunk_id,headings in links:
            connection.execute("""UPDATE knowledge_outline_chunks SET heading_path=%s
              WHERE tenant_id=%s AND document_id=%s AND document_version=%s AND chunk_id=%s""",
              ([redact_text(h) for h in headings],tenant_id,document_id,version,chunk_id))
        # Sanitization changes offsets and entity labels may contain raw data.
        # Invalidate the document's graph projection; extraction/review must
        # rebuild provenance against sanitized passages before graph reuse.
        connection.execute("DELETE FROM knowledge_graph_facts WHERE tenant_id=%s AND document_id=%s",
                           (tenant_id,document_id))
        nodes=connection.execute("""SELECT document_version,node_id::text,title FROM knowledge_outline_nodes
          WHERE tenant_id=%s AND document_id=%s""",(tenant_id,document_id)).fetchall()
        for version,node_id,title in nodes:
            connection.execute("""UPDATE knowledge_outline_nodes SET title=%s
              WHERE tenant_id=%s AND document_id=%s AND document_version=%s AND node_id=%s""",
              (redact_text(title),tenant_id,document_id,version,node_id))
        enqueue_vectors(connection,tenant_id=tenant_id,document_id=document_id,before_version=expected_version)
        connection.execute("""UPDATE knowledge_document_versions SET processing_status='parsed'
          WHERE tenant_id=%s AND document_id=%s AND document_version=%s""",
          (tenant_id,document_id,expected_version))
        event_id=str(uuid4())
        connection.execute("""INSERT INTO knowledge_index_outbox
          (event_id,tenant_id,document_id,document_version,chunk_ids)
          VALUES (%s,%s,%s,%s,%s)""",
          (event_id,tenant_id,document_id,expected_version,[row[1] for row in rows if row[0]==expected_version]))
    return event_id


def reserve_upload(connection, *, tenant_id, document_id, document_version, digest):
    """Commit a cleanup intent before a private immutable object write."""
    from uuid import UUID
    import re
    for value in (tenant_id,document_id):
        if str(UUID(value))!=value:
            raise ValueError('upload identities must be canonical UUIDs')
    if type(document_version) is not int or not 1<=document_version<=2147483647 or not re.fullmatch('[0-9a-f]{64}',digest):
        raise ValueError('invalid upload binding')
    intent=str(uuid4())
    key=f'tenant/{tenant_id}/documents/{document_id}/versions/{document_version}/objects/{intent}/{digest}.pdf'
    with connection.transaction():
        _set_tenant(connection,tenant_id)
        connection.execute("""INSERT INTO knowledge_upload_intents(tenant_id,intent_id,source_object_key)
          VALUES (%s,%s,%s)""",(tenant_id,intent,key))
    return intent,key


def reconcile_uploads(connection, *, tenant_id, object_store, batch_size=100):
    """Reclaim only abandoned known keys, after one hour, under intent locks.

    An in-progress upload holds the same intent lock until adoption commits.
    Referenced keys are acknowledged without deletion. Failure leaves the intent
    pending, including a provider-success/DB-crash retry.
    """
    if type(batch_size) is not int or not 1<=batch_size<=1000:
        raise ValueError('invalid upload reconciliation batch')
    with connection.transaction():
        _set_tenant(connection,tenant_id)
        rows=connection.execute("""SELECT intent_id::text,source_object_key FROM knowledge_upload_intents
          WHERE tenant_id=%s AND completed_at IS NULL
            AND created_at<=clock_timestamp()-interval '1 hour'
          ORDER BY created_at,intent_id LIMIT %s FOR UPDATE SKIP LOCKED""",
          (tenant_id,batch_size)).fetchall()
        for intent,key in rows:
            if not key.startswith(f'tenant/{tenant_id}/documents/'):
                raise ValueError('upload cleanup tenant binding is invalid')
            reference=connection.execute("""SELECT document_id FROM knowledge_document_versions
              WHERE tenant_id=%s AND source_object_key=%s""",(tenant_id,key)).fetchone()
            if reference is None:
                object_store.delete_pdf(key)
            connection.execute("""UPDATE knowledge_upload_intents SET completed_at=clock_timestamp()
              WHERE tenant_id=%s AND intent_id=%s""",(tenant_id,intent))
    return len(rows)
