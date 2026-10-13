"""Local real-Postgres leased summary acceptance with an explicit model double."""
from __future__ import annotations
import os,json
from pathlib import Path
from uuid import uuid4
import psycopg
from knowledge_extensions.summary_jobs import create_summary_job,get_summary_job,claim_summary_job,run_summary_job
from knowledge_extensions.oidc_auth import PostgresMemberships
from knowledge_extensions.document_summary import DocumentSummaryError


def main():
    if os.environ.get('KNOWLEDGE_ENVIRONMENT')!='local-synthetic':raise SystemExit('local-synthetic only')
    connect=lambda:psycopg.connect(os.environ['KNOWLEDGE_DATABASE_URL'])
    tokens=json.loads(Path(os.environ['KNOWLEDGE_MODEL_GATEWAY_TOKENS_FILE']).read_text())
    document='2ccb87ff-d4b2-4d3f-acc3-4b0e57a89ace'
    user=None
    for tenant in tokens:
        with connect() as c,c.transaction():
            c.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
            if c.execute('SELECT 1 FROM knowledge_documents WHERE tenant_id=%s AND document_id=%s',(tenant,document)).fetchone():
                user=c.execute("SELECT principal_id::text FROM knowledge_auth_memberships WHERE tenant_id=%s AND active AND 'admin'=ANY(roles) ORDER BY principal_id LIMIT 1",(tenant,)).fetchone()[0]
                break
    assert user
    key=str(uuid4())
    with connect() as c:
        created=create_summary_job(c,tenant_id=tenant,principal_id=user,principal_role='admin',document_id=document,
            document_version=1,question='Summarize every selected section.',idempotency_key=key,answer_model='explicit-local-double')
        replay=create_summary_job(c,tenant_id=tenant,principal_id=user,principal_role='admin',document_id=document,
            document_version=1,question='Summarize every selected section.',idempotency_key=key,answer_model='explicit-local-double')
    assert created['job_id']==replay['job_id']
    job_id=created['job_id']
    for denied_tenant,denied_user in ((str(uuid4()),user),(tenant,str(uuid4()))):
        with connect() as c:
            try:get_summary_job(c,tenant_id=denied_tenant,principal_id=denied_user,principal_role='admin',job_id=job_id)
            except DocumentSummaryError as exc:assert exc.status==404
            else:raise AssertionError('foreign scope leaked')
    with connect() as c,c.transaction():
        c.execute("SELECT set_config('app.tenant_id',%s,true),set_config('app.user_id',%s,true)",(tenant,str(uuid4())))
        assert c.execute('SELECT count(*) FROM assistant_summary_jobs WHERE job_id=%s',(job_id,)).fetchone()[0]==0
        assert not c.execute('SELECT * FROM knowledge_summary_pending_principals(%s::uuid)',(str(uuid4()),)).fetchall()
    with connect() as c:job=claim_summary_job(c,tenant,user)
    assert job and job['job_id']==job_id
    class Model:
        def answer(self,question,context,**kwargs):
            return dict(answer='\n\n'.join('Page '+str(s['page_start'])+': '+s['text'][:150] for s in context),cited_chunk_ids=[s['chunk_id'] for s in context])
    run_summary_job(connect,tenant=tenant,user=user,job=job,models=Model(),memberships=PostgresMemberships(connect))
    with connect() as c:
        completed=get_summary_job(c,tenant_id=tenant,principal_id=user,principal_role='admin',job_id=job_id)
        assert completed['status']=='completed',completed['error_code']
        assert completed['total_batches']==completed['completed_batches']>0
        assert completed['result']['citations']
        cancelled=get_summary_job(c,tenant_id=tenant,principal_id=user,principal_role='admin',job_id=job_id,cancel=True)
        assert cancelled['status']=='cancelled' and cancelled['result'] is None
    with connect() as c,c.transaction():
        c.execute("SELECT set_config('app.tenant_id',%s,true),set_config('app.user_id',%s,true)",(tenant,user))
        c.execute('DELETE FROM assistant_summary_jobs WHERE tenant_id=%s AND user_id=%s AND job_id=%s',(tenant,user,job_id))
    report=dict(real_postgres=True,forced_user_rls=True,cross_tenant_denied=True,cross_user_denied=True,
        discovery_foreign_tenant_denied=True,idempotent_create=True,lease_claim=True,
        persisted_completed_result=True,progress_batches=completed['total_batches'],cancellation_clears_result=True,
        provider='explicit-local-model-double',cleanup=True)
    out=Path('evidence/intelligence/summary-quality-local');out.mkdir(parents=True,exist_ok=True)
    (out/'postgres-jobs-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))

if __name__=='__main__':main()
