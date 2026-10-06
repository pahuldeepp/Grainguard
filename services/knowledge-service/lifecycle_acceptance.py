"""Disposable synthetic PostgreSQL lifecycle proof; vector/object ports are fakes.

Creates its own container and random tenant/document IDs. Never connects to an
existing database or cloud provider. No user documents are touched.
"""
import os
from pathlib import Path
import subprocess
import sys
from threading import Thread, Event
import time
from uuid import uuid4
import psycopg
from knowledge_extensions.document_lifecycle import process_cleanup, record_cleanup_failure, enqueue_retention, reindex_redacted_document, reserve_upload, reconcile_uploads
from knowledge_extensions.document_access import delete_document, load_pdf_source
from knowledge_extensions.document_summary import DocumentSummaryError
from knowledge_extensions.source_store import save_parsed_pdf
from knowledge_extensions.pdf_parser import parse_pdf
from knowledge_extensions.retrieval import process_index_event, tenant_namespace

HERE=Path(__file__).parent
sys.path.insert(0,str(HERE/'tests'))
from local_rag_adapters import LocalVectorStore, LocalEmbedding
from pdf_fixture import make_text_pdf
IMAGE='postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
KEY=b'synthetic-lifecycle-acceptance-key-32-bytes'


def run(*args):
    return subprocess.run(args,check=True,text=True,capture_output=True)


def main():
    name='greenguard-synthetic-lifecycle-'+uuid4().hex[:10]
    password=uuid4().hex
    run('docker','run','--rm','-d','--name',name,'-e','POSTGRES_DB=greenguard_knowledge',
        '-e','POSTGRES_USER=knowledge_migrator','-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432',IMAGE)
    try:
        for _ in range(60):
            port=run('docker','port',name,'5432/tcp').stdout.strip().rsplit(':',1)[-1]
            admin=f'postgresql://knowledge_migrator:{password}@127.0.0.1:{port}/greenguard_knowledge'
            try:
                with psycopg.connect(admin,connect_timeout=1):break
            except psycopg.OperationalError:time.sleep(1)
        with psycopg.connect(admin,autocommit=True) as db:
            db.execute(f"CREATE ROLE knowledge_app LOGIN PASSWORD '{password}' NOBYPASSRLS")
        env=dict(os.environ,KNOWLEDGE_ENVIRONMENT='local-synthetic',KNOWLEDGE_MIGRATION_DATABASE_URL=admin)
        run_result=subprocess.run([sys.executable,str(HERE/'migrate.py')],env=env,capture_output=True,text=True)
        if run_result.returncode:raise RuntimeError('synthetic lifecycle migrations failed: '+run_result.stderr)
        app=f'postgresql://knowledge_app:{password}@127.0.0.1:{port}/greenguard_knowledge'
        tenant,other,doc,user=[str(uuid4()) for _ in range(4)]
        with psycopg.connect(admin) as db:
            db.execute("INSERT INTO knowledge_auth_memberships(tenant_id,issuer,subject,principal_id,roles,active) VALUES (%s,'synthetic','synthetic',%s,ARRAY['admin'],true)",(tenant,user))
        models=LocalEmbedding();vectors=LocalVectorStore()
        class Objects:
            fail=True
            deleted=[]
            def delete_pdf(self,key):
                if self.fail:raise RuntimeError('synthetic object failure')
                self.deleted.append(key)
        objects=Objects()
        def ingest(version):
            parsed=parse_pdf(make_text_pdf([[f'Synthetic lifecycle version {version}.', 'Contact synthetic.person@example.test for grain checks.']]),tenant_id=tenant,document_id=doc,document_version=version)
            key=f'tenant/{tenant}/documents/{doc}/versions/{version}/objects/{uuid4()}/{parsed.source_sha256}.pdf'
            with psycopg.connect(app) as db:
                save_parsed_pdf(db,parsed=parsed,source_object_key=key)
                with db.transaction():
                    db.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
                    event=str(db.execute('SELECT event_id FROM knowledge_index_outbox WHERE tenant_id=%s AND document_id=%s AND document_version=%s',(tenant,doc,version)).fetchone()[0])
            return event
        def index(event,embedding=models):
            with psycopg.connect(app) as db:
                process_index_event(db,tenant_id=tenant,event_id=event,namespace_key=KEY,embedding_provider=embedding,vector_store=vectors,embedding_model=models.model)
        def jobs():
            with psycopg.connect(app) as db:
                db.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
                return [(str(r[0]),r[1]) for r in db.execute('SELECT event_id,operation FROM knowledge_lifecycle_outbox WHERE tenant_id=%s AND completed_at IS NULL',(tenant,)).fetchall()]
        def cleanup(event,scope=tenant):
            with psycopg.connect(app) as db:
                return process_cleanup(db,tenant_id=scope,event_id=event,vector_store=vectors,object_store=objects,namespace_key=KEY,retention_days=30)
        # Reserve before a simulated provider failure. Only this fixture's clock
        # is advanced to exercise orphan reconciliation, with a real RLS role.
        with psycopg.connect(app) as db:
            intent,orphan=reserve_upload(db,tenant_id=tenant,document_id=doc,document_version=1,digest='a'*64)
        with psycopg.connect(admin) as db:
            db.execute("UPDATE knowledge_upload_intents SET created_at=clock_timestamp()-interval '2 hours' WHERE tenant_id=%s AND intent_id=%s",(tenant,intent))
        with psycopg.connect(app) as db:
            assert reconcile_uploads(db,tenant_id=other,object_store=objects)==0
            try:reconcile_uploads(db,tenant_id=tenant,object_store=objects)
            except RuntimeError:pass
            else:raise AssertionError('orphan failure was not injected')
        objects.fail=False
        with psycopg.connect(app) as db:
            assert reconcile_uploads(db,tenant_id=tenant,object_store=objects)==1
            assert reconcile_uploads(db,tenant_id=tenant,object_store=objects)==0
        assert objects.deleted==[orphan];objects.fail=True
        event=ingest(1);index(event)
        with psycopg.connect(admin) as db:
            chunk=db.execute('SELECT chunk_id FROM knowledge_chunks WHERE tenant_id=%s AND document_id=%s LIMIT 1',(tenant,doc)).fetchone()[0]
            source,target=str(uuid4()),str(uuid4())
            for entity,kind,label in [(source,'grain','synthetic grain'),(target,'hazard','synthetic.person@example.test')]:
                db.execute('INSERT INTO knowledge_graph_entities(tenant_id,entity_id,entity_type,normalized_label,display_label) VALUES (%s,%s,%s,%s,%s)',(tenant,entity,kind,label,label))
            db.execute("""INSERT INTO knowledge_graph_facts(tenant_id,fact_id,source_entity_id,predicate,target_entity_id,
              document_id,document_version,chunk_id,span_start,span_end,trust,status)
              VALUES (%s,%s,%s,'has_hazard',%s,%s,1,%s,0,5,'tenant_uploaded','reviewed')""",
              (tenant,'a'*64,source,target,doc,chunk))
        with psycopg.connect(app) as db:
            changed=reindex_redacted_document(db,tenant_id=tenant,document_id=doc,expected_version=1)
        index(changed)
        with psycopg.connect(app) as db:
            db.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
            assert '@' not in db.execute('SELECT content FROM knowledge_chunks WHERE tenant_id=%s',(tenant,)).fetchone()[0]
            assert db.execute('SELECT count(*) FROM knowledge_graph_facts WHERE tenant_id=%s AND document_id=%s',(tenant,doc)).fetchone()[0]==0
        with psycopg.connect(app) as db:
            try:reindex_redacted_document(db,tenant_id=tenant,document_id=doc,expected_version=2)
            except ValueError:pass
            else:raise AssertionError('stale reindex accepted')
        event2=ingest(2)
        # A stale v1 event is harmless. Parent lock excludes concurrent delete while
        # an index provider call is in flight, then deletion wins after publication.
        index(event)
        entered,release,deleted=Event(),Event(),Event()
        errors=[]
        class Blocking:
            def embed(self,*args,**kwargs):
                entered.set();assert release.wait(5)
                return models.embed(*args,**kwargs)
        def indexing():
            try:index(event2,Blocking())
            except Exception as exc:errors.append(exc)
        def deleting():
            try:
                with psycopg.connect(app) as db:
                    delete_document(db,tenant_id=tenant,principal_id=user,principal_role='admin',document_id=doc)
                deleted.set()
            except Exception as exc:errors.append(exc)
        first=Thread(target=indexing);first.start();assert entered.wait(5)
        second=Thread(target=deleting);second.start();time.sleep(.15);assert not deleted.is_set()
        release.set();first.join(10);second.join(10);assert deleted.is_set() and not errors
        with psycopg.connect(app) as db:
            delete_document(db,tenant_id=tenant,principal_id=user,principal_role='admin',document_id=doc)
            try:load_pdf_source(db,tenant_id=tenant,principal_id=user,principal_role='admin',document_id=doc,document_version=2,require_membership=True)
            except DocumentSummaryError:pass
            else:raise AssertionError('deleted PDF source was readable')
        for event,operation in jobs():
            assert not cleanup(event,other)
            assert cleanup(event)
            assert not cleanup(event)
        assert not vectors.records.get(tenant_namespace(tenant,KEY))
        # Synthetic clock change in this disposable fixture only.
        with psycopg.connect(admin) as db:
            db.execute("UPDATE knowledge_documents SET deleted_at=clock_timestamp()-interval '31 days' WHERE tenant_id=%s AND document_id=%s",(tenant,doc))
        with psycopg.connect(app) as db:
            assert enqueue_retention(db,tenant_id=tenant,retention_days=30)==1
        for event,operation in jobs():
            try:cleanup(event)
            except RuntimeError:pass
            else:raise AssertionError('injected failure was not observed')
            with psycopg.connect(app) as db:
                record_cleanup_failure(db,tenant_id=tenant,event_id=event)
            # Simulate retry due now in synthetic fixture, not a real policy.
            with psycopg.connect(admin) as db:
                db.execute('UPDATE knowledge_lifecycle_outbox SET available_at=clock_timestamp() WHERE tenant_id=%s AND event_id=%s',(tenant,event))
            objects.fail=False;assert cleanup(event);objects.fail=True
        with psycopg.connect(app) as db:
            db.execute("SELECT set_config('app.tenant_id',%s,true)",(tenant,))
            assert db.execute('SELECT count(*) FROM knowledge_document_versions WHERE tenant_id=%s',(tenant,)).fetchone()[0]==0
            db.execute("SELECT set_config('app.tenant_id',%s,true)",(other,))
            assert db.execute('SELECT count(*) FROM knowledge_lifecycle_outbox').fetchone()[0]==0
        print('LIFECYCLE_SYNTHETIC_POSTGRES_PASS: RLS, orphan compensation, stale reindex, serialized index/delete, retry, idempotence, source denial, retention. Provider ports are fakes.')
    finally:
        run('docker','rm','-f',name)


if __name__=='__main__':main()
