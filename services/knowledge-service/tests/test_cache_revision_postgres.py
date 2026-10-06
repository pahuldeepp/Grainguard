"""Explicit disposable PostgreSQL acceptance; never touches the running RAG DB."""
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
from uuid import uuid4
import unittest

from knowledge_extensions.retrieval_cache import corpus_revision

DSN = os.environ.get('KNOWLEDGE_CACHE_REVISION_TEST_DSN', '')

@unittest.skipUnless(DSN, 'explicit disposable cache revision DSN required')
class CacheRevisionPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        parsed=urlsplit(DSN)
        if parsed.hostname not in {'127.0.0.1','localhost','::1'} or parsed.path!='/greenguard_cache_revision_test':
            raise ValueError('only loopback greenguard_cache_revision_test allowed')
        cls.connect=lambda self: psycopg.connect(DSN,autocommit=True)
        with psycopg.connect(DSN,autocommit=True) as db:
            # An empty dedicated database is mandatory.
            if db.execute("SELECT to_regclass('knowledge_documents')").fetchone()[0]:
                raise ValueError('test database must be fresh/empty')
            for role in ('knowledge_app','knowledge_provisioner','knowledge_reviewer'):
                if not db.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(role,)).fetchone():
                    db.execute('CREATE ROLE '+role+' NOSUPERUSER NOBYPASSRLS')
            for path in sorted((Path(__file__).parents[1]/'migrations').glob('*.up.sql')):
                with db.transaction(): db.execute(path.read_text(),prepare=False)

    def setUp(self):
        self.tenant=str(uuid4()); self.other=str(uuid4()); self.doc=str(uuid4())
        with self.connect() as db:
            with db.transaction():
                db.execute('SET LOCAL ROLE knowledge_app')
                db.execute("SELECT set_config('app.tenant_id',%s,true)",(self.tenant,))
                db.execute('INSERT INTO knowledge_documents(tenant_id,document_id) VALUES(%s,%s)',(self.tenant,self.doc))

    def revision(self,db):
        return corpus_revision(db,self.tenant,None)

    def test_forced_rls_runtime_cannot_write_or_read_other_revision(self):
        import psycopg
        with self.connect() as db:
            self.assertEqual(db.execute("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='knowledge_cache_revisions'").fetchone(),(True,True))
            with db.transaction():
                db.execute('SET LOCAL ROLE knowledge_app')
                db.execute("SELECT set_config('app.tenant_id',%s,true)",(self.other,))
                self.assertIsNone(corpus_revision(db,self.tenant,None))
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    with db.transaction(): db.execute('UPDATE knowledge_cache_revisions SET revision=1')
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    with db.transaction(): db.execute('INSERT INTO knowledge_documents(tenant_id,document_id) VALUES(%s,%s)',(self.tenant,str(uuid4())))

    def test_acl_version_delete_and_membership_change_revision_atomically(self):
        with self.connect() as db:
            initial=self.revision(db)
            with db.transaction():
                db.execute('SET LOCAL ROLE knowledge_app')
                db.execute("SELECT set_config('app.tenant_id',%s,true)",(self.tenant,))
                db.execute("UPDATE knowledge_documents SET min_role='admin',acl_principals=ARRAY[%s]::uuid[] WHERE tenant_id=%s AND document_id=%s",(str(uuid4()),self.tenant,self.doc))
            self.assertEqual(self.revision(db),initial+1)
            try:
                with db.transaction():
                    db.execute('UPDATE knowledge_documents SET latest_version=1 WHERE tenant_id=%s',(self.tenant,))
                    raise RuntimeError('rollback')
            except RuntimeError: pass
            self.assertEqual(self.revision(db),initial+1)
            with db.transaction():
                db.execute('SET LOCAL ROLE knowledge_provisioner')
                db.execute("SELECT set_config('app.tenant_id',%s,true)",(self.tenant,))
                db.execute("INSERT INTO knowledge_auth_memberships(tenant_id,issuer,subject,principal_id,roles,active) VALUES(%s,'issuer','subject',%s,ARRAY['viewer'],true)",(self.tenant,str(uuid4())))
                db.execute('UPDATE knowledge_auth_memberships SET active=false,revision=revision+1 WHERE tenant_id=%s',(self.tenant,))
            self.assertEqual(self.revision(db),initial+3)
            # Privileged maintenance does not require an application tenant GUC.
            db.execute('DELETE FROM knowledge_auth_memberships WHERE tenant_id=%s',(self.tenant,))
            db.execute('UPDATE knowledge_documents SET latest_version=1,current_version=1 WHERE tenant_id=%s',(self.tenant,))
            db.execute('DELETE FROM knowledge_documents WHERE tenant_id=%s',(self.tenant,))
            self.assertEqual(self.revision(db),initial+6)

    def test_statement_bulk_update_bumps_once_and_concurrent_updates_do_not_lose_bumps(self):
        with self.connect() as db:
            db.execute('INSERT INTO knowledge_documents(tenant_id,document_id) SELECT %s,gen_random_uuid() FROM generate_series(1,20)',(self.tenant,))
            initial=self.revision(db)
            db.execute("UPDATE knowledge_documents SET min_role='operator' WHERE tenant_id=%s",(self.tenant,))
            self.assertEqual(self.revision(db),initial+1)
        def write(index):
            with self.connect() as db:
                with db.transaction():
                    db.execute('SET LOCAL ROLE knowledge_app')
                    db.execute("SELECT set_config('app.tenant_id',%s,true)",(self.tenant,))
                    db.execute('INSERT INTO knowledge_documents(tenant_id,document_id) VALUES(%s,%s)',(self.tenant,str(uuid4())))
        with ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(write,range(12)))
        with self.connect() as db: self.assertEqual(self.revision(db),initial+13)

    def test_all_projection_tables_have_statement_triggers(self):
        with self.connect() as db:
            for table in ('knowledge_documents','knowledge_document_versions','knowledge_chunks','knowledge_outline_nodes','knowledge_outline_chunks','knowledge_document_outlines','knowledge_graph_entities','knowledge_graph_facts','knowledge_auth_memberships'):
                rows=db.execute("SELECT tgname,tgtype::int FROM pg_trigger WHERE tgrelid=%s::regclass AND tgname LIKE 'cache_revision_%%'",(table,)).fetchall()
                self.assertEqual(len(rows),3,table)
                self.assertTrue(all(not flag & 1 for _,flag in rows),table)

    def test_stale_candidate_ids_are_denied_after_acl_membership_version_and_delete(self):
        from knowledge_extensions.retrieval import _hydrate
        from knowledge_extensions.retrieval_cache import RedisJsonCache
        principal=str(uuid4()); chunk=str(uuid4())
        with self.connect() as db:
            db.execute("INSERT INTO knowledge_document_versions(tenant_id,document_id,document_version,source_sha256,media_type,processing_status) VALUES(%s,%s,1,%s,'application/pdf','ready')",(self.tenant,self.doc,'a'*64))
            db.execute("INSERT INTO knowledge_chunks(tenant_id,document_id,document_version,chunk_id,ordinal,content,content_sha256,page_start,page_end) VALUES(%s,%s,1,%s,0,'local fixture',%s,1,1)",(self.tenant,self.doc,chunk,'b'*64))
            db.execute('UPDATE knowledge_documents SET current_version=1,latest_version=1 WHERE tenant_id=%s',(self.tenant,))
            db.execute("INSERT INTO knowledge_auth_memberships(tenant_id,issuer,subject,principal_id,roles,active) VALUES(%s,'issuer','subject',%s,ARRAY['viewer'],true)",(self.tenant,principal))
            initial=self.revision(db)
            key=lambda: RedisJsonCache.key('candidates',[self.tenant,principal,'viewer',self.revision(db)])
            original_key=key()
            self.assertEqual(len(_hydrate(db,self.tenant,principal,'viewer',[chunk],require_membership=True)),1)
            db.execute("UPDATE knowledge_documents SET acl_principals=ARRAY[%s]::uuid[] WHERE tenant_id=%s",(str(uuid4()),self.tenant))
            self.assertEqual(_hydrate(db,self.tenant,principal,'viewer',[chunk],require_membership=True),[])
            self.assertNotEqual(key(),original_key)
            db.execute("UPDATE knowledge_documents SET acl_principals='{}' WHERE tenant_id=%s",(self.tenant,))
            db.execute('UPDATE knowledge_auth_memberships SET active=false WHERE tenant_id=%s',(self.tenant,))
            self.assertEqual(_hydrate(db,self.tenant,principal,'viewer',[chunk],require_membership=True),[])
            db.execute('UPDATE knowledge_auth_memberships SET active=true WHERE tenant_id=%s',(self.tenant,))
            db.execute('UPDATE knowledge_documents SET current_version=2,latest_version=2 WHERE tenant_id=%s',(self.tenant,))
            self.assertEqual(_hydrate(db,self.tenant,principal,'viewer',[chunk],require_membership=True),[])
            db.execute('UPDATE knowledge_documents SET current_version=1 WHERE tenant_id=%s',(self.tenant,))
            db.execute('UPDATE knowledge_documents SET deleted_at=clock_timestamp() WHERE tenant_id=%s',(self.tenant,))
            self.assertEqual(_hydrate(db,self.tenant,principal,'viewer',[chunk],require_membership=True),[])
            self.assertGreater(self.revision(db),initial)
