"""Authorized source-PDF metadata; never expose storage keys to the browser."""
import re
from uuid import UUID
from .retrieval import _accessible_docs_clause, _set_tenant, _validate_caller
from .document_summary import DocumentSummaryError


def safe_pdf_name(name):
    if name is None:
        return None
    if not isinstance(name, str) or not name or len(name) > 240 or re.search(r'[\x00-\x1f\x7f/\\]', name) or not name.lower().endswith('.pdf'):
        raise ValueError('invalid PDF filename')
    return name


def load_pdf_source(connection, *, tenant_id, principal_id, principal_role, document_id, document_version, require_membership=False):
    _validate_caller(tenant_id, principal_id, principal_role)
    if str(UUID(document_id)) != document_id or type(document_version) is not int or not 1 <= document_version <= 2147483647:
        raise ValueError('invalid document version')
    membership='';extra=()
    if require_membership:
        membership="""AND EXISTS (SELECT 1 FROM knowledge_auth_memberships m
          WHERE m.tenant_id=d.tenant_id AND m.principal_id=%s AND m.active
          AND (CASE WHEN 'admin'=ANY(m.roles) THEN 3 WHEN 'operator'=ANY(m.roles) THEN 2 ELSE 1 END)
          >= (CASE d.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END))"""
        extra=(principal_id,)
    with connection.transaction():
        _set_tenant(connection,tenant_id)
        row=connection.execute(f"""SELECT v.source_object_key,v.source_sha256,v.source_file_name
          FROM knowledge_documents d JOIN knowledge_document_versions v USING (tenant_id,document_id)
          WHERE d.tenant_id=%s AND d.document_id=%s AND v.document_version=%s
          AND d.current_version=v.document_version AND d.deleted_at IS NULL
          AND v.processing_status='ready' AND {_accessible_docs_clause()} {membership}""",
          (tenant_id,document_id,document_version,principal_role,principal_id,principal_id)+extra).fetchone()
    if row is None or not row[0]:
        raise DocumentSummaryError('not_found',404)
    prefix=f'tenant/{tenant_id}/documents/{document_id}/versions/{document_version}/objects/'
    if not row[0].startswith(prefix):
        raise RuntimeError('source binding is invalid')
    return {'key':row[0],'sha256':row[1],'filename':safe_pdf_name(row[2]) or f'document-{document_id}.pdf'}


def list_documents(connection, *, tenant_id, principal_id, principal_role):
    """Bounded authorized latest-version list, including indexing progress."""
    _validate_caller(tenant_id, principal_id, principal_role)
    with connection.transaction():
        _set_tenant(connection, tenant_id)
        rows = connection.execute(f"""SELECT d.document_id,v.document_version,v.processing_status,
            v.source_file_name,v.created_at FROM knowledge_documents d
            JOIN knowledge_document_versions v ON v.tenant_id=d.tenant_id
              AND v.document_id=d.document_id AND v.document_version=d.latest_version
            WHERE d.tenant_id=%s AND d.deleted_at IS NULL AND {_accessible_docs_clause()}
              AND (CASE v.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END)
                <= (CASE %s WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END)
              AND (cardinality(v.acl_principals)=0 OR %s::uuid=ANY(v.acl_principals))
            ORDER BY v.created_at DESC,d.document_id LIMIT 200""",
            (tenant_id, principal_role, principal_id, principal_id, principal_role, principal_id)).fetchall()
    return [{"document_id":str(row[0]), "document_version":row[1], "status":row[2],
             "filename":safe_pdf_name(row[3]) or f"document-{row[0]}.pdf",
             "created_at":row[4].isoformat() if row[4] else None} for row in rows]


def delete_document(connection, *, tenant_id, principal_id, principal_role, document_id, require_membership=True):
    """Deny immediately and atomically schedule retryable vector deletion."""
    _validate_caller(tenant_id, principal_id, principal_role)
    if principal_role not in {"operator", "admin"}:
        raise DocumentSummaryError("forbidden", 403)
    if str(UUID(document_id)) != document_id:
        raise ValueError("invalid document ID")
    from .document_lifecycle import enqueue_vectors
    membership_clause = """
              AND EXISTS (SELECT 1 FROM knowledge_auth_memberships m
                WHERE m.tenant_id=d.tenant_id AND m.principal_id=%s AND m.active
                AND ('operator'=ANY(m.roles) OR 'admin'=ANY(m.roles))
                AND (CASE WHEN 'admin'=ANY(m.roles) THEN 3 ELSE 2 END)
                  >= (CASE d.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END))""" if require_membership else ""
    membership_params = (principal_id,) if require_membership else ()
    with connection.transaction():
        _set_tenant(connection, tenant_id)
        row=connection.execute(f"""SELECT d.document_id,d.deleted_at FROM knowledge_documents d
            WHERE d.tenant_id=%s AND d.document_id=%s
              AND {_accessible_docs_clause()}
              {membership_clause}
              FOR UPDATE OF d""",
            (tenant_id, document_id, principal_role, principal_id, principal_id) + membership_params).fetchone()
        if row is None:
            raise DocumentSummaryError("not_found",404)
        if row[1] is None:
            connection.execute("""UPDATE knowledge_documents SET deleted_at=clock_timestamp()
                WHERE tenant_id=%s AND document_id=%s""",(tenant_id,document_id))
            enqueue_vectors(connection,tenant_id=tenant_id,document_id=document_id)
    return {"deleted":True, "document_id":document_id}
