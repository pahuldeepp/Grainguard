"""Disposable real PostgreSQL acceptance for the closed structured query catalog."""
import json
import hashlib
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from knowledge_extensions.http_api import create_server, ApiPrincipal
from knowledge_extensions.service import KnowledgeRagService
from pathlib import Path
import subprocess
import time
from uuid import uuid4
import psycopg
from knowledge_extensions.text_sql import execute_question
from postgres_acceptance import IMAGE


def run(*args, check=True):
    result = subprocess.run(args, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError('disposable database operation failed')
    return result


def main():
    name='gg-textsql-'+uuid4().hex[:10];secret=uuid4().hex
    tenant=str(uuid4());foreign=str(uuid4());user=str(uuid4());doc=str(uuid4())
    run('docker','run','--rm','-d','--name',name,'-e','POSTGRES_DB=greenguard_knowledge',
        '-e','POSTGRES_USER=knowledge_migrator','-e','POSTGRES_PASSWORD='+secret,'-p','127.0.0.1::5432',IMAGE)
    try:
        port=None
        for _ in range(45):
            mapped=run('docker','port',name,'5432/tcp',check=False)
            if mapped.returncode==0:
                port=mapped.stdout.strip().rsplit(':',1)[-1]
                try:
                    with psycopg.connect(f'postgresql://knowledge_migrator:{secret}@127.0.0.1:{port}/greenguard_knowledge',connect_timeout=1): break
                except psycopg.OperationalError: pass
            time.sleep(1)
        if not port: raise RuntimeError('database not ready')
        admin=f'postgresql://knowledge_migrator:{secret}@127.0.0.1:{port}/greenguard_knowledge'
        with psycopg.connect(admin,autocommit=True) as c:
            c.execute("CREATE ROLE knowledge_app LOGIN PASSWORD '"+secret+"'")
            for migration in sorted((Path(__file__).parent/'migrations').glob('*.up.sql')):
                c.execute(migration.read_text())
            for t in (tenant,foreign):
                c.execute("INSERT INTO knowledge_auth_memberships(tenant_id,principal_id,issuer,subject,roles,active) VALUES(%s,%s,%s,%s,%s,true)",(t,user,'https://synthetic.test','synthetic-user',['viewer']))
                d=doc if t==tenant else str(uuid4())
                c.execute('INSERT INTO knowledge_documents(tenant_id,document_id,current_version,latest_version) VALUES(%s,%s,1,1)',(t,d))
                c.execute("INSERT INTO knowledge_document_versions(tenant_id,document_id,document_version,source_sha256,media_type,processing_status,source_file_name) VALUES(%s,%s,1,%s,'application/pdf','ready','Synthetic SQL fixture.pdf')",(t,d,'a'*64))
            c.execute('REVOKE INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public FROM knowledge_app')
        app=f'postgresql://knowledge_app:{secret}@127.0.0.1:{port}/greenguard_knowledge'
        def ask(t=tenant,**extra):
            with psycopg.connect(app) as c:
                return execute_question(c,tenant_id=t,principal_id=user,principal_role='viewer',question='How many ready PDFs do I have?',**extra)
        assert '1 accessible' in ask().answer
        assert '1 accessible' in ask(foreign).answer
        assert '1 accessible' in ask(document_id=doc,document_version=1).answer
        assert '0 accessible' in ask(foreign,document_id=doc,document_version=1).answer
        from knowledge_extensions.text_sql import plan_question
        from unittest.mock import MagicMock
        paraphrase='Give me a tally of uploaded material'
        assert plan_question(paraphrase) is None
        planner=MagicMock()
        planner.plan.return_value={'operation':'count','status':'ready'}
        planned=KnowledgeRagService(connect=lambda:psycopg.connect(app),vector_store=object(),
            model_gateway=planner,namespace_key=b'synthetic-private-namespace-key-32bytes',
            embedding_model='unused',reranker_model='unused',answer_model='answer-v1')
        def fallback(t=tenant,**extra):
            return planned.ask(tenant_id=t,principal_id=user,principal_role='viewer',
                question=paraphrase,mode='structured',**extra)
        assert '1 accessible' in fallback().answer
        assert '0 accessible' in fallback(foreign,document_id=doc,document_version=1).answer
        planner.plan.return_value={'operation':'count','status':None,'sql':'SELECT secret'}
        try: fallback()
        except ValueError: pass
        else: raise AssertionError('model SQL field accepted')
        planner.plan.return_value={'operation':'unsupported','status':None}
        try: fallback()
        except ValueError: pass
        else: raise AssertionError('unsupported plan executed')
        planner.plan.return_value={'operation':'count','status':None}
        def revoke_during_plan(*args,**kwargs):
            with psycopg.connect(admin,autocommit=True) as c:
                c.execute('UPDATE knowledge_auth_memberships SET active=false WHERE tenant_id=%s AND principal_id=%s',(tenant,user))
            return {'operation':'count','status':None}
        planner.plan.side_effect=revoke_during_plan
        try: fallback()
        except PermissionError: pass
        else: raise AssertionError('revocation during planner allowed')
        before=planner.plan.call_count
        try: fallback()
        except PermissionError: pass
        else: raise AssertionError('revoked planner call allowed')
        assert planner.plan.call_count==before
        with psycopg.connect(admin,autocommit=True) as c:
            c.execute('UPDATE knowledge_auth_memberships SET active=true WHERE tenant_id=%s AND principal_id=%s',(tenant,user))
        token=uuid4().hex
        service=KnowledgeRagService(connect=lambda:psycopg.connect(app),vector_store=object(),
            model_gateway=object(),namespace_key=b'synthetic-private-namespace-key-32bytes',
            embedding_model='unused',reranker_model='unused',answer_model='unused')
        server=create_server(service=service,access_bindings={hashlib.sha256(token.encode()).hexdigest():ApiPrincipal(tenant,user,'viewer')},port=0)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            def request(body):
                req=Request(f'http://127.0.0.1:{server.server_port}/v1/query',data=json.dumps(body).encode(),
                    headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
                try:
                    with urlopen(req,timeout=5) as response: return response.status,json.loads(response.read())
                except HTTPError as error: return error.code,json.loads(error.read())
            status,body=request({'mode':'structured','question':'How many ready PDFs do I have?'})
            assert status==200 and body['retrieval']=={'structured_sql':1,'structured_planner':0} and '1 accessible' in body['answer']
            assert request({'mode':'structured','question':'Count PDFs','tenant_id':foreign})[0]==400
            assert request({'mode':'structured','question':'Count PDFs','plan':{'operation':'count','status':None}})[0]==400
            assert request({'mode':'structured','question':'SELECT * FROM knowledge_documents'})[0]==400
        finally:
            server.shutdown();server.server_close()
        with psycopg.connect(admin,autocommit=True) as c:
            c.execute("UPDATE knowledge_documents SET acl_principals=%s WHERE tenant_id=%s AND document_id=%s",([str(uuid4())],tenant,doc))
        assert '0 accessible' in ask().answer
        with psycopg.connect(admin,autocommit=True) as c:
            c.execute('UPDATE knowledge_auth_memberships SET active=false WHERE tenant_id=%s AND principal_id=%s',(tenant,user))
        try: ask()
        except PermissionError: pass
        else: raise AssertionError('revoked membership allowed')
        with psycopg.connect(admin) as c:
            try: execute_question(c,tenant_id=foreign,principal_id=user,principal_role='viewer',question='Count PDFs')
            except PermissionError: pass
            else: raise AssertionError('superuser allowed')
        print(json.dumps({'real_postgres':True,'loopback_authenticated_http':True,'live_provider_calls':0,'mock_planner_calls':planner.plan.call_count,'fallback_typed_plan':True,'model_sql_fields_denied':True,'planner_revocation_denied':True,'client_plan_denied':True,'read_only_select_role':True,'forced_rls':True,'cross_tenant_scope_denied':True,'acl_revocation_denied':True,'membership_revocation_denied':True,'superuser_denied':True}))
    finally:
        run('docker','rm','-f',name,check=False)

if __name__=='__main__': main()
