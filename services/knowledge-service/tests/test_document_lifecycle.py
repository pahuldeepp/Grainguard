from contextlib import nullcontext
from unittest import TestCase
from unittest.mock import MagicMock
from knowledge_extensions.document_lifecycle import process_cleanup, record_cleanup_failure, reindex_redacted_document, enqueue_retention
from knowledge_extensions.document_access import delete_document
from knowledge_extensions.document_summary import DocumentSummaryError

T='11111111-1111-4111-8111-111111111111'
D='22222222-2222-4222-8222-222222222222'
U='33333333-3333-4333-8333-333333333333'
E='44444444-4444-4444-8444-444444444444'
C='55555555-5555-4555-8555-555555555555'


def db_with(rows):
    db=MagicMock();db.transaction.return_value=nullcontext()
    results=[]
    for row in rows:
        result=MagicMock();result.fetchone.return_value=row;results.append(result)
    db.execute.side_effect=results
    return db


class LifecycleTests(TestCase):
    def test_vector_failure_is_retryable_and_success_can_be_repeated(self):
        vectors=MagicMock();objects=MagicMock()
        vectors.delete.side_effect=RuntimeError('offline')
        db=db_with([None,(D,),('deleted',1),(1,'vectors',[C],None)])
        with self.assertRaises(RuntimeError):
            process_cleanup(db,tenant_id=T,event_id=E,vector_store=vectors,object_store=objects,namespace_key=b'x'*32)
        self.assertFalse(any('SET completed_at' in call.args[0] for call in db.execute.call_args_list))
        vectors.delete.side_effect=None
        db=db_with([None,(D,),('deleted',1),(1,'vectors',[C],None),None])
        self.assertTrue(process_cleanup(db,tenant_id=T,event_id=E,vector_store=vectors,object_store=objects,namespace_key=b'x'*32))
        self.assertEqual(vectors.delete.call_count,2)
        db=db_with([None,(D,),('deleted',1),None])
        self.assertFalse(process_cleanup(db,tenant_id=T,event_id=E,vector_store=vectors,object_store=objects,namespace_key=b'x'*32))
        self.assertEqual(vectors.delete.call_count,2)

    def test_cross_tenant_job_does_not_call_providers(self):
        db=db_with([None,None]);vectors=MagicMock();objects=MagicMock()
        self.assertFalse(process_cleanup(db,tenant_id=T,event_id=E,vector_store=vectors,object_store=objects,namespace_key=b'x'*32))
        vectors.delete.assert_not_called();objects.delete_pdf.assert_not_called()
        self.assertEqual(db.execute.call_args.args[1],(T,E))

    def test_current_live_version_cannot_be_deleted(self):
        db=db_with([None,(D,),(None,1),(1,'vectors',[C],None)])
        vectors=MagicMock()
        with self.assertRaises(ValueError):
            process_cleanup(db,tenant_id=T,event_id=E,vector_store=vectors,object_store=MagicMock(),namespace_key=b'x'*32)
        vectors.delete.assert_not_called()

    def test_source_waits_for_vector_cleanup(self):
        db=db_with([None,(D,),('deleted',1),(1,'source',[],f'tenant/{T}/documents/{D}/versions/1/objects/test'),(True,),None])
        objects=MagicMock()
        with self.assertRaises(ValueError):
            process_cleanup(db,tenant_id=T,event_id=E,vector_store=MagicMock(),object_store=objects,namespace_key=b'x'*32,retention_days=30)
        objects.delete_pdf.assert_not_called()

    def test_source_failure_does_not_delete_canonical_version(self):
        db=db_with([None,(D,),('deleted',1),(1,'source',[],f'tenant/{T}/documents/{D}/versions/1/objects/test'),(True,),(E,)])
        objects=MagicMock();objects.delete_pdf.side_effect=RuntimeError('offline')
        with self.assertRaises(RuntimeError):
            process_cleanup(db,tenant_id=T,event_id=E,vector_store=MagicMock(),object_store=objects,namespace_key=b'x'*32,retention_days=30)
        self.assertFalse(any('DELETE FROM knowledge_document_versions' in call.args[0] for call in db.execute.call_args_list))

    def test_retry_delete_does_not_reschedule_or_change_retention_clock(self):
        db=db_with([None,(D,'deleted')])
        self.assertEqual(delete_document(db,tenant_id=T,principal_id=U,principal_role='operator',document_id=D)['deleted'],True)
        self.assertEqual(db.execute.call_count,2)
        sql=db.execute.call_args.args[0]
        self.assertIn('m.active',sql);self.assertIn('FOR UPDATE OF d',sql)

    def test_reindex_stale_or_deleted_is_rejected_before_content_changes(self):
        for row in [(2,2,None),(1,2,None),(1,1,'deleted'),None]:
            db=db_with([None,row])
            with self.assertRaises(ValueError):
                reindex_redacted_document(db,tenant_id=T,document_id=D,expected_version=1)
            self.assertEqual(db.execute.call_count,2)

    def test_retention_requires_explicit_positive_policy(self):
        for days in [None,0,-1,True,3651]:
            db=MagicMock()
            with self.assertRaises(ValueError):enqueue_retention(db,tenant_id=T,retention_days=days)
            db.execute.assert_not_called()

    def test_failures_are_durable_bounded_backoff_with_tenant_selector(self):
        db=MagicMock();db.transaction.return_value=nullcontext()
        record_cleanup_failure(db,tenant_id=T,event_id=E)
        sql,params=db.execute.call_args.args
        self.assertIn('LEAST(3600',sql);self.assertIn('completed_at IS NULL',sql)
        self.assertEqual(params,(T,E))

    def test_pending_source_job_is_denied_when_policy_disabled(self):
        db=db_with([None,(D,),('deleted',1),(1,'source',[],None)])
        objects=MagicMock()
        with self.assertRaises(ValueError):
            process_cleanup(db,tenant_id=T,event_id=E,vector_store=MagicMock(),object_store=objects,namespace_key=b'x'*32)
        objects.delete_pdf.assert_not_called()

    def test_longer_current_retention_policy_prevents_pending_source_delete(self):
        db=db_with([None,(D,),('deleted',1),(1,'source',[],None),(False,)])
        objects=MagicMock()
        with self.assertRaises(ValueError):
            process_cleanup(db,tenant_id=T,event_id=E,vector_store=MagicMock(),object_store=objects,namespace_key=b'x'*32,retention_days=60)
        objects.delete_pdf.assert_not_called()


class RetentionSelectionTests(TestCase):
    def test_bounded_batches_skip_outboxed_and_unbound_sources_then_advance(self):
        # Execute the actual correlated selection/insertion against an in-memory
        # SQL engine, adapting only PostgreSQL timestamp/cast/locking syntax.
        # PostgreSQL locking is checked explicitly; no retention worker runs.
        import sqlite3
        sql_db=sqlite3.connect(':memory:')
        sql_db.create_function('gen_random_uuid',0,lambda:E)
        sql_db.executescript("""
          CREATE TABLE knowledge_documents(tenant_id TEXT,document_id TEXT,deleted_at INTEGER);
          CREATE TABLE knowledge_document_versions(tenant_id TEXT,document_id TEXT,document_version INTEGER,source_object_key TEXT);
          CREATE TABLE knowledge_lifecycle_outbox(tenant_id TEXT,event_id TEXT,document_id TEXT,document_version INTEGER,operation TEXT,source_object_key TEXT,
            UNIQUE(tenant_id,document_id,document_version,operation));
        """)
        foreign='66666666-6666-4666-8666-666666666666'
        # The oldest doc is already queued; the next has no retained source.
        # A foreign-tenant document shares an ID with an eligible local document.
        sql_db.executemany('INSERT INTO knowledge_documents VALUES(?,?,?)',[
            (T,'queued',1),(T,'no-source',2),(T,'eligible-one',3),
            (T,'eligible-two',4),(foreign,'eligible-one',1),(T,'unexpired',99)])
        sql_db.executemany('INSERT INTO knowledge_document_versions VALUES(?,?,?,?)',[
            (T,'queued',1,'queued-key'),(T,'no-source',1,None),
            (T,'eligible-one',1,'one-key'),(T,'eligible-one',2,'one-new-key'),
            (T,'eligible-two',1,'two-key'),(foreign,'eligible-one',1,'foreign-key'),
            (T,'unexpired',1,'live-key')])
        sql_db.execute("INSERT INTO knowledge_lifecycle_outbox VALUES(?,?,?,?,?,?)",
            (T,E,'queued',1,'source','queued-key'))
        # An intent for a different version must not block an eligible version.
        sql_db.execute("INSERT INTO knowledge_lifecycle_outbox VALUES(?,?,?,?,?,?)",
            (T,E,'eligible-one',1,'source','one-key'))
        db=MagicMock();db.transaction.return_value=nullcontext()
        def execute(sql,params):
            if "set_config" in sql:
                self.assertEqual(params,(T,))
                return MagicMock()
            if sql.lstrip().startswith('SELECT d.document_id'):
                self.assertIn('FOR UPDATE OF d SKIP LOCKED',sql)
                self.assertIn('o.document_version=v.document_version',sql)
                self.assertIn('o.tenant_id=v.tenant_id',sql)
                self.assertEqual(params,(T,30,1))
                sql=sql.replace('d.document_id::text','d.document_id').replace(
                    "clock_timestamp() - (%s * interval '1 day')",'50').replace(
                    ' FOR UPDATE OF d SKIP LOCKED','')
                params=(params[0],params[2])
            return sql_db.execute(sql.replace('%s','?'),params)
        db.execute.side_effect=execute
        try:
            self.assertEqual(enqueue_retention(db,tenant_id=T,retention_days=30,batch_size=1),1)
            self.assertEqual(enqueue_retention(db,tenant_id=T,retention_days=30,batch_size=1),1)
            self.assertEqual(enqueue_retention(db,tenant_id=T,retention_days=30,batch_size=1),0)
            intents=sql_db.execute("SELECT document_id,document_version FROM knowledge_lifecycle_outbox WHERE tenant_id=? AND operation='source' ORDER BY document_id,document_version",(T,)).fetchall()
            self.assertEqual(intents,[('eligible-one',1),('eligible-one',2),('eligible-two',1),('queued',1)])
            self.assertEqual(sql_db.execute('SELECT count(*) FROM knowledge_lifecycle_outbox WHERE tenant_id=?',(foreign,)).fetchone()[0],0)
        finally:
            sql_db.close()
