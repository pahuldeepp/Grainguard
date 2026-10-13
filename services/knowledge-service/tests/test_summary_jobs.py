from contextlib import nullcontext
from unittest.mock import patch
from uuid import uuid4
import unittest
from knowledge_extensions.document_summary import DocumentSummaryError
from knowledge_extensions.summary_jobs import create_summary_job,get_summary_job,claim_summary_job,run_summary_job

T='11111111-1111-4111-8111-111111111111'
U='33333333-3333-4333-8333-333333333333'
D='44444444-4444-4444-8444-444444444444'
J='55555555-5555-4555-8555-555555555555'
OTHER='22222222-2222-4222-8222-222222222222'

class Connection:
    def __init__(self,rows): self.rows=list(rows);self.calls=[]
    def transaction(self):return nullcontext()
    def __enter__(self):return self
    def __exit__(self,*_):pass
    def execute(self,sql,params=()):
        self.calls.append((sql,params))
        if sql.startswith('SELECT set_config') or 'advisory' in sql:return Result(None)
        return Result(self.rows.pop(0) if self.rows else None)
class Result:
    def __init__(self,row):self.row=row
    def fetchone(self):return self.row

class JobsTests(unittest.TestCase):
    def test_create_has_scope_admission_and_idempotency(self):
        row=(J,'queued',0,0,None,None,D,1)
        c=Connection([None,(0,),row])
        with patch('knowledge_extensions.summary_jobs.load_pdf_source') as auth:
            job=create_summary_job(c,tenant_id=T,principal_id=U,principal_role='viewer',document_id=D,
                document_version=1,question='Summarize every section.',idempotency_key=J,answer_model='test')
        self.assertEqual(job['status'],'queued')
        self.assertEqual(auth.call_args.kwargs['require_membership'],True)
        for sql,params in c.calls:
            if 'assistant_summary_jobs' in sql:
                self.assertIn(T,params);self.assertIn(U,params)
    def test_foreign_principal_and_tenant_jobs_are_not_found(self):
        for tenant,user in ((OTHER,U),(T,OTHER)):
            c=Connection([None])
            with self.assertRaises(DocumentSummaryError) as err:
                get_summary_job(c,tenant_id=tenant,principal_id=user,principal_role='viewer',job_id=J)
            self.assertEqual(err.exception.status,404)
            self.assertIn('tenant_id=%s AND user_id=%s',c.calls[-1][0])
    def test_replayed_key_with_changed_scope_conflicts(self):
        c=Connection([(J,'completed',1,1,None,{},D,1,'Different summary')])
        with patch('knowledge_extensions.summary_jobs.load_pdf_source'),self.assertRaises(DocumentSummaryError) as e:
            create_summary_job(c,tenant_id=T,principal_id=U,principal_role='viewer',document_id=D,
                document_version=1,question='Summarize every section.',idempotency_key=J,answer_model='test')
        self.assertEqual(e.exception.status,409)
    def test_more_than_two_active_jobs_is_429(self):
        c=Connection([None,(2,)])
        with patch('knowledge_extensions.summary_jobs.load_pdf_source'),self.assertRaises(DocumentSummaryError) as e:
            create_summary_job(c,tenant_id=T,principal_id=U,principal_role='viewer',document_id=D,
                document_version=1,question='Summarize every section.',idempotency_key=J,answer_model='test')
        self.assertEqual(e.exception.status,429)
    def test_cancel_clears_result_and_fences_inflight_worker(self):
        c=Connection([(J,'running',1,2,None,None,D,1),(J,'cancelled',1,2,None,None,D,1)])
        with patch('knowledge_extensions.summary_jobs.load_pdf_source'):
            result=get_summary_job(c,tenant_id=T,principal_id=U,principal_role='viewer',job_id=J,cancel=True)
        self.assertEqual(result['status'],'cancelled')
        self.assertIn('lease_token=NULL',c.calls[-1][0])
    def test_cancel_preserves_terminal_status_and_result(self):
        for status in ('completed', 'failed', 'cancelled'):
            row = (J, status, 2, 2, None, {'summary': 'retained'}, D, 1)
            c = Connection([row, None])
            with patch('knowledge_extensions.summary_jobs.load_pdf_source'):
                result = get_summary_job(c, tenant_id=T, principal_id=U,
                    principal_role='viewer', job_id=J, cancel=True)
            self.assertEqual(result['status'], status)
            self.assertEqual(result['result'], {'summary': 'retained'})
            self.assertIn("status IN ('queued','running')", c.calls[-1][0])

    def test_claim_is_tenant_user_scoped_skip_locked_and_lease_fenced(self):
        c=Connection([None,None,(J,D,1,'Summarize this','viewer','test',{}),None])
        result=claim_summary_job(c,T,U)
        self.assertEqual(result['job_id'],J)
        self.assertIn('FOR UPDATE SKIP LOCKED',c.calls[-2][0])
        self.assertIn('lease_expires_at',c.calls[-1][0])
    def test_revoked_membership_fails_without_model_and_safe_error(self):
        class Memberships:
            def resolve_principal(self,**kwargs):raise RuntimeError('sensitive message')
        c=Connection([(J,)])
        class Model:
            def answer(self,*a,**kw):raise AssertionError('must not call')
        job=dict(job_id=J,document_id=D,document_version=1,question='Summarize this',authorized_role='viewer',answer_model='test',parts={},lease_token=str(uuid4()))
        run_summary_job(lambda:c,tenant=T,user=U,job=job,models=Model(),memberships=Memberships())
        self.assertNotIn('sensitive message',str(c.calls))
        self.assertIn("status='failed'",c.calls[-1][0])
        self.assertIn('lease_token=%s',c.calls[-1][0])

if __name__=='__main__':unittest.main()

class WorkerCheckpointTests(unittest.TestCase):
    def job(self,parts=None):
        return dict(job_id=J,document_id=D,document_version=1,question='Summarize this',authorized_role='viewer',answer_model='test',parts=parts or {},lease_token=str(uuid4()))
    def membership(self):
        class M:
            def resolve_principal(self,**kwargs):
                class Principal:role='admin'
                return Principal()
        return M()
    def test_checkpoint_resume_reuses_validated_answer_without_provider(self):
        import hashlib,json
        from knowledge_extensions.retrieval import RetrievedAnswer
        context=[dict(chunk_id=J,document_id=D,document_version=1,page_start=1,page_end=1,text='Reviewed fact',trust='tenant_uploaded')]
        question='Batch summary prompt'
        result=dict(answer='Reviewed fact',cited_chunk_ids=[J])
        digest=hashlib.sha256(json.dumps(['test',question,context],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        c=Connection([(J,),(J,),(J,)])
        class Model:
            def answer(self,*args,**kwargs):raise AssertionError('checkpoint must avoid paid call')
        def summarize(connection,**kwargs):
            self.assertEqual(kwargs['principal_role'],'viewer')  # membership upgrade cannot expand initial grant
            kwargs['progress'](0,1)
            answer=kwargs['answer_generator'].answer(question,context,tenant_id=T,model='test')
            kwargs['progress'](1,1)
            return RetrievedAnswer(answer['answer'],tuple(context),{'summary_batches':1})
        with patch('knowledge_extensions.summary_jobs.summarize_document',side_effect=summarize):
            run_summary_job(lambda:c,tenant=T,user=U,job=self.job({digest:result}),models=Model(),memberships=self.membership())
        self.assertIn("status='completed'",c.calls[-1][0])
    def test_stale_worker_fence_prevents_provider_calls(self):
        c=Connection([None,None])
        class Model:
            def answer(self,*args,**kwargs):raise AssertionError('stale worker must not call')
        def summarize(connection,**kwargs):kwargs['progress'](0,1)
        with patch('knowledge_extensions.summary_jobs.summarize_document',side_effect=summarize):
            run_summary_job(lambda:c,tenant=T,user=U,job=self.job(),models=Model(),memberships=self.membership())
        self.assertIn('lease_expires_at>clock_timestamp()',c.calls[-1][0])
    def test_retry_exhaustion_update_precedes_claim(self):
        c=Connection([None,None,None])
        self.assertIsNone(claim_summary_job(c,T,U))
        exhausted=next(sql for sql,_ in c.calls if "summary_retry_exhausted" in sql)
        self.assertIn('attempts>=3',exhausted)

class WorkerShutdownTests(unittest.TestCase):
    def test_shutdown_requeues_checkpoint_without_model_call(self):
        import threading
        stop=threading.Event();stop.set()
        c=Connection([(J,)])
        job=dict(job_id=J,document_id=D,document_version=1,question='Summarize this',authorized_role='viewer',answer_model='test',parts={},lease_token=str(uuid4()))
        run_summary_job(lambda:c,tenant=T,user=U,job=job,models=None,memberships=None,stop=stop)
        self.assertIn("status='queued'",c.calls[-1][0])
        self.assertNotIn("parts='{}'",c.calls[-1][0])
