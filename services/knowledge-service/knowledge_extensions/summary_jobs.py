"""Durable, principal-owned summary queue with leased resumable model work."""
from __future__ import annotations

import hashlib
import json
import time
from uuid import UUID, uuid4

from .document_access import load_pdf_source
from .document_summary import DocumentSummaryError, summarize_document
from .model_gateway import verified_gateway_user
from .output_guardrails import validate_answer
from .prompt_guardrails import require_safe_text
from .redaction import redact_text
from .retrieval import _validate_caller

_FIELDS = 'job_id::text,status,completed_batches,total_batches,error_code,result,document_id::text,document_version'
_RANK = {'viewer': 1, 'operator': 2, 'admin': 3}


def _uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError('invalid UUID')
    return value


def _scope(connection, tenant, user):
    connection.execute("SELECT set_config('app.tenant_id',%s,true),set_config('app.user_id',%s,true)", (tenant, user))


def _public(row):
    return dict(zip(('job_id', 'status', 'completed_batches', 'total_batches', 'error_code', 'result', 'document_id', 'document_version'), row))


def _authorized(connection, tenant, user, role, document, version, *, require_membership=True):
    return load_pdf_source(connection, tenant_id=tenant, principal_id=user, principal_role=role,
                           document_id=document, document_version=version, require_membership=require_membership)


def create_summary_job(connection, *, tenant_id, principal_id, principal_role, document_id,
                       document_version, question, idempotency_key, answer_model,
                       require_membership=True):
    _validate_caller(tenant_id, principal_id, principal_role)
    _uuid(principal_id); _uuid(document_id); _uuid(idempotency_key)
    if type(document_version) is not int or not 1 <= document_version <= 2147483647:
        raise ValueError('invalid version')
    if not isinstance(question, str) or not 4 <= len(question.strip()) <= 2000:
        raise ValueError('invalid question')
    require_safe_text(question)
    question = redact_text(question.strip())
    if not 4 <= len(question) <= 2000:
        raise ValueError("redacted question exceeds limits")
    _authorized(connection, tenant_id, principal_id, principal_role, document_id, document_version,
                require_membership=require_membership)
    with connection.transaction():
        _scope(connection, tenant_id, principal_id)
        # Serialize admissions per principal. At most two active jobs; no empty flood.
        connection.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', (f'summary:{tenant_id}:{principal_id}',))
        existing = connection.execute(
            f'SELECT {_FIELDS},question FROM assistant_summary_jobs WHERE tenant_id=%s AND user_id=%s AND idempotency_key=%s',
            (tenant_id, principal_id, idempotency_key)).fetchone()
        if existing:
            if (existing[6], existing[7], existing[8]) != (document_id, document_version, question):
                raise DocumentSummaryError('summary_idempotency_conflict', 409)
            return _public(existing[:8])
        count = connection.execute("SELECT count(*) FROM assistant_summary_jobs WHERE tenant_id=%s AND user_id=%s AND status IN ('queued','running') AND expires_at>clock_timestamp()", (tenant_id, principal_id)).fetchone()[0]
        if count >= 2:
            raise DocumentSummaryError('summary_jobs_busy', 429)
        row = connection.execute(
            f'''INSERT INTO assistant_summary_jobs(tenant_id,user_id,job_id,idempotency_key,document_id,document_version,question,authorized_role,answer_model)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING {_FIELDS}''',
            (tenant_id, principal_id, str(uuid4()), idempotency_key, document_id, document_version, question, principal_role, answer_model)).fetchone()
        return _public(row)


def get_summary_job(connection, *, tenant_id, principal_id, principal_role, job_id, cancel=False,
                    require_membership=True):
    _validate_caller(tenant_id, principal_id, principal_role)
    _uuid(principal_id); _uuid(job_id)
    with connection.transaction():
        _scope(connection, tenant_id, principal_id)
        row = connection.execute(f'SELECT {_FIELDS} FROM assistant_summary_jobs WHERE tenant_id=%s AND user_id=%s AND job_id=%s AND expires_at>clock_timestamp()', (tenant_id, principal_id, job_id)).fetchone()
        if not row:
            raise DocumentSummaryError('not_found', 404)
        _authorized(connection, tenant_id, principal_id, principal_role, row[6], row[7],
                    require_membership=require_membership)
        if cancel:
            updated = connection.execute(f'''UPDATE assistant_summary_jobs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,parts='{{}}',result=NULL,updated_at=clock_timestamp()
                WHERE tenant_id=%s AND user_id=%s AND job_id=%s AND status IN ('queued','running') RETURNING {_FIELDS}''', (tenant_id, principal_id, job_id)).fetchone()
            if updated is not None:
                row = updated
        return _public(row)


def claim_summary_job(connection, tenant, user):
    with connection.transaction():
        _scope(connection, tenant, user)
        connection.execute("DELETE FROM assistant_summary_jobs WHERE tenant_id=%s AND user_id=%s AND expires_at<=clock_timestamp()", (tenant, user))
        connection.execute("UPDATE assistant_summary_jobs SET status='failed',error_code='summary_retry_exhausted',parts='{}',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=%s AND user_id=%s AND status='running' AND lease_expires_at<clock_timestamp() AND attempts>=3", (tenant, user))
        row = connection.execute('''SELECT job_id::text,document_id::text,document_version,question,authorized_role,answer_model,parts
            FROM assistant_summary_jobs WHERE tenant_id=%s AND user_id=%s AND expires_at>clock_timestamp() AND attempts<3
            AND (status='queued' OR (status='running' AND lease_expires_at<clock_timestamp()))
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1''', (tenant, user)).fetchone()
        if not row:
            return None
        token = str(uuid4())
        connection.execute("UPDATE assistant_summary_jobs SET status='running',attempts=attempts+1,lease_token=%s,lease_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE tenant_id=%s AND user_id=%s AND job_id=%s", (token, tenant, user, row[0]))
        return dict(zip(('job_id','document_id','document_version','question','authorized_role','answer_model','parts'), row), lease_token=token)


def run_summary_job(connect, *, tenant, user, job, models, memberships, stop=None):
    """No user JWT is stored. Re-resolve membership and ACL before every batch.

    Saved per-batch contracts are keyed by model/question/authorized evidence hash.
    A crash can replay a successful batch without another provider charge. Lease
    fencing discards results from cancelled/expired/reclaimed workers.
    """
    deadline = time.monotonic() + 3600
    def role():
        if stop is not None and stop.is_set():
            raise DocumentSummaryError("summary_worker_stopping", 503)
        if time.monotonic() >= deadline:
            raise DocumentSummaryError("summary_deadline_exceeded", 408)
        fresh = memberships.resolve_principal(principal_id=user, tenant_id=tenant).role
        return min((fresh, job['authorized_role']), key=_RANK.__getitem__)

    def update(sql, params):
        with connect() as connection, connection.transaction():
            _scope(connection, tenant, user)
            row = connection.execute(sql + " WHERE tenant_id=%s AND user_id=%s AND job_id=%s AND status='running' AND lease_token=%s AND lease_expires_at>clock_timestamp() RETURNING job_id",
                params + (tenant,user,job['job_id'],job['lease_token'])).fetchone()
            if not row:
                raise DocumentSummaryError('summary_job_cancelled', 409)

    class CachedModel:
        def answer(self, question, context, **kwargs):
            role()
            digest = hashlib.sha256(json.dumps([job['answer_model'],question,context],sort_keys=True,separators=(',',':')).encode()).hexdigest()
            existing = job['parts'].get(digest)
            if existing:
                validate_answer(existing, {s['chunk_id'] for s in context}, len(context))
                return existing
            # Also renew/check the fence before starting another paid provider call.
            update("UPDATE assistant_summary_jobs SET lease_expires_at=clock_timestamp()+interval '5 minutes'", ())
            with verified_gateway_user(user, deadline_seconds=120, call_timeout_seconds=110):
                result = models.answer(question, context, **kwargs)
            answer, cited = validate_answer(result, {s['chunk_id'] for s in context}, len(context))
            if set(cited) != {s['chunk_id'] for s in context}:
                raise DocumentSummaryError('document_summary_incomplete')
            safe_result = {'answer':answer,'cited_chunk_ids':list(cited)}
            update("UPDATE assistant_summary_jobs SET parts=jsonb_set(parts,ARRAY[%s],%s::jsonb),updated_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes'", (digest,json.dumps(safe_result)))
            job['parts'][digest] = safe_result
            return safe_result

    def progress(done, total):
        update("UPDATE assistant_summary_jobs SET completed_batches=%s,total_batches=%s,updated_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes'", (done,total))

    try:
        with connect() as connection:
            answer = summarize_document(connection, tenant_id=tenant, principal_id=user,
                principal_role=role(), question=job['question'], document_id=job['document_id'],
                document_version=job['document_version'], answer_generator=CachedModel(),
                answer_model=job['answer_model'],
                require_membership=bool(getattr(memberships, 'uses_database_membership', False)), reauthorize=role,
                background=True, progress=progress)
        role()
        result = dict(answer=answer.answer,citations=list(answer.citations),retrieval=answer.retrieval)
        encoded = json.dumps(result, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > 1500000:
            raise DocumentSummaryError("summary_result_too_large")
        update("UPDATE assistant_summary_jobs SET status='completed',result=%s::jsonb,parts='{}',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()", (encoded,))
    except Exception as exc:
        code = exc.code if isinstance(exc,DocumentSummaryError) else ('summary_access_revoked' if getattr(exc,'status',None) in {401,403,404} else 'summary_provider_unavailable')
        # Shutdown requeues fenced checkpoints; provider/security failures are terminal.
        try:
            if code == 'summary_worker_stopping':
                update("UPDATE assistant_summary_jobs SET status='queued',attempts=GREATEST(attempts-1,0),lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()", ())
                return
            update("UPDATE assistant_summary_jobs SET status='failed',error_code=%s,parts='{}',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()", (code,))
        except DocumentSummaryError:
            pass
