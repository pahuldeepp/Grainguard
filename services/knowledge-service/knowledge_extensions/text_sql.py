"""Closed natural-language query catalog; model/user SQL is never executable."""
from hashlib import sha256
import hmac
from dataclasses import dataclass
import re
from uuid import UUID
from .retrieval import RetrievedAnswer, _validate_caller, _set_tenant, _accessible_docs_clause
from .prompt_guardrails import require_safe_text
from .redaction import redact_text
from .conversation_store import _MAX_CONTENT


@dataclass(frozen=True)
class StructuredPlan:
    operation: str
    status: str | None = None


def plan_question(question: str) -> StructuredPlan | None:
    if not isinstance(question, str) or not 4 <= len(question.strip()) <= 2000:
        raise ValueError("invalid structured question")
    require_safe_text(question)
    text = question.strip().lower()
    # Deliberately reject executable syntax, even when mixed with supported words.
    if re.search(r"[;`]|--|/\*|\b(select|insert|update|delete|drop|union|grant|copy|pg_sleep)\b", text):
        return None
    # max(page_end) identifies the last indexed page, never coverage/cardinality.
    if re.search(r"\bpages?\b", text) and re.search(r"\b(how many|count|total|totals|number|coverage)\b", text):
        return StructuredPlan("unsupported")
    if not re.search(r"\b(documents?|pdfs?|files?)\b", text):
        return None
    # Auto-routing is limited to metadata vocabulary; content questions stay RAG.
    vocabulary = {"how", "many", "count", "number", "of", "show", "list", "what", "is", "are",
                  "the", "my", "i", "do", "have", "for", "in", "on", "all", "a", "an", "and",
                  "accessible", "uploaded", "selected", "catalog", "indexed", "indexing", "status", "statuses",
                  "page", "pages", "last", "highest", "total", "totals", "document", "documents", "pdf", "pdfs", "file", "files",
                  "queued", "parsed", "ready", "failed"}
    if any(word not in vocabulary for word in re.findall(r"[a-z0-9_]+", text)):
        return None
    statuses = [s for s in ("queued", "parsed", "ready", "failed") if re.search(rf"\b{s}\b", text)]
    if len(statuses) > 1:
        return None
    status = statuses[0] if statuses else None
    if re.search(r"\b(pages?|page totals?)\b", text) and re.search(r"\b(show|list|how many|total|number)\b", text):
        return StructuredPlan("pages", status)
    if re.search(r"\b(how many|count|number of)\b", text):
        return StructuredPlan("count", status)
    if re.search(r"\b(list|show|status|indexing)\b", text):
        return StructuredPlan("list", status)
    return None



def validate_plan(value) -> StructuredPlan:
    """Validate the closed contract; never accept SQL or expressions."""
    if isinstance(value, StructuredPlan):
        value = {"operation": value.operation, "status": value.status}
    if (type(value) is not dict or set(value) != {"operation", "status"}
            or type(value["operation"]) is not str
            or value["operation"] not in {"count", "list", "pages", "unsupported"}
            or (value["status"] is not None and (type(value["status"]) is not str
                or value["status"] not in {"queued", "parsed", "ready", "failed"}))
            or (value["operation"] == "unsupported" and value["status"] is not None)):
        raise ValueError("invalid structured plan")
    return StructuredPlan(value["operation"], value["status"])


def _check_database_authority(connection, tenant_id, principal_id, principal_role, *, require_database_membership=True):
    unsafe = connection.execute("""SELECT r.rolsuper OR r.rolbypassrls OR EXISTS (
        SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace
        AND c.relname IN ('knowledge_documents','knowledge_document_versions','knowledge_chunks','knowledge_auth_memberships')
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR pg_has_role(current_user,c.relowner,'USAGE')))
        FROM pg_roles r WHERE r.rolname=current_user""").fetchone()
    if unsafe is None or unsafe[0]:
        raise PermissionError("unsafe structured database role")
    if require_database_membership:
        member = connection.execute("""SELECT roles FROM knowledge_auth_memberships
            WHERE tenant_id=%s AND principal_id=%s AND active""", (tenant_id, principal_id)).fetchone()
        level = {"viewer": 1, "operator": 2, "admin": 3}
        if not member or max((level.get(r, 0) for r in member[0]), default=0) < level[principal_role]:
            raise PermissionError("inactive membership")


def preauthorize_planner(connection, *, tenant_id, principal_id, principal_role, reauthorize=None,
                         require_database_membership=True):
    """Check database authority before spending any model budget."""
    _validate_caller(tenant_id, principal_id, principal_role)
    if principal_id is None:
        raise PermissionError("structured queries require authenticated membership")
    if not require_database_membership and reauthorize is None:
        raise PermissionError("authoritative membership revalidation required")
    if reauthorize is not None and reauthorize() != principal_role:
        raise PermissionError("membership changed")
    with connection.transaction():
        connection.execute("SET TRANSACTION READ ONLY")
        connection.execute("SET LOCAL statement_timeout = '2000ms'")
        connection.execute("SET LOCAL lock_timeout = '500ms'")
        _set_tenant(connection, tenant_id)
        _check_database_authority(connection, tenant_id, principal_id, principal_role,
                                  require_database_membership=require_database_membership)


def execute_question(connection, *, tenant_id, principal_id, principal_role,
                     question, document_id=None, document_version=None, reauthorize=None, plan: StructuredPlan | None = None,
                     require_database_membership=True):
    """Execute only compiled catalog SELECTs with fresh membership and two ACLs."""
    _validate_caller(tenant_id, principal_id, principal_role)
    if principal_id is None:
        raise PermissionError("structured queries require authenticated membership")
    if not require_database_membership and reauthorize is None:
        raise PermissionError("authoritative membership revalidation required")
    if plan is not None and type(plan) is not StructuredPlan:
        raise ValueError("internal structured plan required")
    plan = plan_question(question) if plan is None else validate_plan(plan)
    if plan is None or plan.operation == "unsupported":
        raise ValueError("unsupported structured question")
    if (document_id is None) != (document_version is None):
        raise ValueError("invalid structured document scope")
    if document_id is not None:
        if str(UUID(document_id)) != document_id or type(document_version) is not int or not 1 <= document_version <= 2147483647:
            raise ValueError("invalid structured document scope")
    if reauthorize is not None and reauthorize() != principal_role:
        raise PermissionError("membership changed")
    with connection.transaction():
        connection.execute("SET TRANSACTION READ ONLY")
        connection.execute("SET LOCAL statement_timeout = '2000ms'")
        connection.execute("SET LOCAL lock_timeout = '500ms'")
        _set_tenant(connection, tenant_id)
        _check_database_authority(connection, tenant_id, principal_id, principal_role,
                                  require_database_membership=require_database_membership)
        where = f"""d.tenant_id=%s AND d.deleted_at IS NULL AND {_accessible_docs_clause()}
            AND (CASE v.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END)
            <= (CASE %s WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END)
            AND (cardinality(v.acl_principals)=0 OR %s::uuid=ANY(v.acl_principals))"""
        params = (tenant_id, principal_role, principal_id, principal_id, principal_role, principal_id)
        if document_id is not None:
            where += " AND d.document_id=%s AND v.document_version=%s"
            params += (document_id, document_version)
        if plan.status:
            where += " AND v.processing_status=%s"
            params += (plan.status,)
        base = f"""FROM knowledge_documents d JOIN knowledge_document_versions v
            ON v.tenant_id=d.tenant_id AND v.document_id=d.document_id AND v.document_version=d.latest_version
            WHERE {where}"""
        if plan.operation == "count":
            count = connection.execute("SELECT count(*) " + base, params).fetchone()[0]
            answer = f"You have {count} accessible documents" + (f" with status **{plan.status}**." if plan.status else ".")
        else:
            pages = """(SELECT max(c.page_end) FROM knowledge_chunks c WHERE c.tenant_id=d.tenant_id
                AND c.document_id=d.document_id AND c.document_version=v.document_version)"""
            rows = connection.execute(f"SELECT d.document_id,v.document_version,v.source_file_name,v.processing_status,{pages} "
                + base + " ORDER BY d.document_id LIMIT 101", params).fetchall()
            answer = "| PDF | Version | Status | Last indexed page |\n| --- | --- | --- | --- |"
            shown = 0
            for doc, version, name, state, page_count in rows[:100]:
                label = redact_text(name or f"document-{doc}.pdf")
                label = re.sub(r"[|\r\n<>`\[\]*_\\]", " ", label)[:240]
                row = f"\n| {label} | {version} | {state} | {page_count if page_count is not None else 'Not indexed'} |"
                notice = f"\n\nShowing the first {shown + 1} accessible documents."
                if len(answer) + len(row) + len(notice) > _MAX_CONTENT:
                    break
                answer += row
                shown += 1
            if not rows:
                answer = "No accessible documents match this request."
            elif shown < len(rows):
                answer += f"\n\nShowing the first {shown} accessible documents."
    if reauthorize is not None and reauthorize() != principal_role:
        raise PermissionError("membership changed")
    return RetrievedAnswer(answer=answer, citations=(), retrieval={"structured_sql": 1}, structured_evidence={"operation":plan.operation,"status":plan.status,"answer_sha256":sha256(answer.encode()).hexdigest()})


def authorize_evidence(connection, *, evidence, **identity):
    """Replay the fixed read catalog under fresh authority without model calls."""
    if type(evidence) is not dict or set(evidence) != {"operation", "status", "answer_sha256"}:
        raise ValueError("invalid structured evidence")
    digest = evidence["answer_sha256"]
    if type(digest) is not str or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("invalid structured evidence")
    plan = validate_plan({"operation":evidence["operation"],"status":evidence["status"]})
    if plan.operation == "unsupported":
        raise ValueError("unsupported structured evidence")
    current = execute_question(connection, question="Verify document inventory", plan=plan, **identity)
    if not hmac.compare_digest(digest, current.structured_evidence["answer_sha256"]):
        raise PermissionError("structured evidence changed")
    return {"authorized": True}
