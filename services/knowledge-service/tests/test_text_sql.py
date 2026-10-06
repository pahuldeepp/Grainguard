from contextlib import nullcontext
from unittest import TestCase
from unittest.mock import MagicMock
from knowledge_extensions.text_sql import plan_question, execute_question
TENANT='11111111-1111-4111-8111-111111111111'
USER='22222222-2222-4222-8222-222222222222'

class StructuredSqlTests(TestCase):
    def connection(self, count=2):
        connection=MagicMock();connection.transaction.side_effect=lambda:nullcontext()
        def execute(sql, params=()):
            result=MagicMock()
            if 'pg_roles' in sql: result.fetchone.return_value=(False,)
            elif 'SELECT roles' in sql: result.fetchone.return_value=(['viewer'],)
            elif 'count(*)' in sql: result.fetchone.return_value=(count,)
            else: result.fetchall.return_value=[]
            return result
        connection.execute.side_effect=execute
        return connection
    def test_compiles_natural_language_catalog_and_rejects_raw_sql(self):
        self.assertEqual(plan_question('How many ready PDFs do I have?').operation,'count')
        self.assertEqual(plan_question('Show indexed pages for my PDFs').operation,'pages')
        for question in ['SELECT * FROM knowledge_documents', 'Count PDFs; DROP TABLE secrets', 'List PDFs UNION SELECT passwords', 'Read temperatures from other tenants', 'List what my PDFs say about temperature']:
            self.assertIsNone(plan_question(question))
    def test_read_only_bounded_parameterized_tenant_and_double_acl(self):
        conn=self.connection()
        answer=execute_question(conn,tenant_id=TENANT,principal_id=USER,principal_role='viewer',question='How many ready PDFs do I have?',reauthorize=lambda:'viewer')
        self.assertIn('2',answer.answer)
        calls=[c.args for c in conn.execute.call_args_list]
        self.assertEqual(calls[0][0],'SET TRANSACTION READ ONLY')
        self.assertTrue(any('statement_timeout' in c[0] for c in calls))
        sql,params=next(c for c in calls if 'count(*)' in c[0])
        self.assertIn('d.tenant_id=%s',sql);self.assertIn('v.acl_principals',sql)
        self.assertNotIn(TENANT,sql);self.assertEqual(params[0],TENANT)
        self.assertIn(USER,params);self.assertEqual(params[-1],'ready')
    def test_downgrade_during_query_denies_result(self):
        roles=iter(['viewer','operator'])
        with self.assertRaises(PermissionError):
            execute_question(self.connection(),tenant_id=TENANT,principal_id=USER,principal_role='viewer',question='Count my PDFs',reauthorize=lambda:next(roles))
    def test_inactive_membership_and_privileged_database_role_denied(self):
        for unsafe,roles in [(True,['viewer']),(False,None)]:
            conn=self.connection()
            original=conn.execute.side_effect
            def execute(sql,params=()):
                result=original(sql,params)
                if 'pg_roles' in sql: result.fetchone.return_value=(unsafe,)
                if 'SELECT roles' in sql: result.fetchone.return_value=(roles,) if roles else None
                return result
            conn.execute.side_effect=execute
            with self.assertRaises(PermissionError):
                execute_question(conn,tenant_id=TENANT,principal_id=USER,principal_role='viewer',question='Count my PDFs')
    def test_anonymous_and_arbitrary_sql_denied_without_execution(self):
        conn=self.connection()
        with self.assertRaises(PermissionError):
            execute_question(conn,tenant_id=TENANT,principal_id=None,principal_role='viewer',question='Count my PDFs')
        with self.assertRaises(ValueError):
            execute_question(conn,tenant_id=TENANT,principal_id=USER,principal_role='viewer',question='SELECT count(*) FROM secrets')
        conn.execute.assert_not_called()

class PlannerFallbackTests(StructuredSqlTests):
    def service(self, conn, planner):
        from knowledge_extensions.service import KnowledgeRagService
        return KnowledgeRagService(connect=lambda:nullcontext(conn), vector_store=MagicMock(),
            model_gateway=planner, namespace_key=b'x'*32, embedding_model='e', reranker_model='r', answer_model='answer-v1')

    def ask(self, service, **kwargs):
        return service.ask(tenant_id=TENANT, principal_id=USER, principal_role='viewer',
            question='Give me a tally of uploaded material', mode='structured', **kwargs)

    def test_agent_catalog_paraphrase_uses_fixed_count_without_model(self):
        conn=self.connection(); model=MagicMock()
        service=self.service(conn,model)
        result=service.ask(tenant_id=TENANT,principal_id=USER,principal_role='viewer',
            question='document catalog ready status count',mode='structured')
        self.assertIn('2',result.answer)
        self.assertEqual(result.retrieval, {'structured_sql':1,'structured_planner':0})
        model.plan.assert_not_called()
        model.embed.assert_not_called()
        sql=[call.args[0] for call in conn.execute.call_args_list if 'count(*)' in call.args[0].lower()]
        self.assertEqual(len(sql),1)

    def test_unsupported_native_plan_never_falls_back_to_retrieval(self):
        conn=self.connection(); model=MagicMock()
        model.plan.return_value={'operation':'unsupported','status':None}
        with self.assertRaisesRegex(ValueError,'unsupported structured question'):
            self.ask(self.service(conn,model))
        model.embed.assert_not_called()
        model.rerank.assert_not_called()
        model.answer.assert_not_called()

    def test_fallback_closed_plan_and_regex_fast_path(self):
        conn=self.connection(); model=MagicMock(); model.plan.return_value={'operation':'count','status':'ready'}
        service=self.service(conn,model)
        result=self.ask(service)
        self.assertIn('2',result.answer)
        self.assertEqual(result.retrieval, {'structured_sql':1,'structured_planner':1})
        model.plan.assert_called_once_with('Give me a tally of uploaded material',tenant_id=TENANT,model='answer-v1')
        fast=service.ask(tenant_id=TENANT,principal_id=USER,principal_role='viewer',question='Count my PDFs',mode='structured')
        self.assertEqual(fast.retrieval, {'structured_sql':1,'structured_planner':0})
        self.assertEqual(model.plan.call_count,1)

    def test_malicious_plans_never_query_document_data(self):
        for payload in [{'operation':'count','status':None,'sql':'SELECT secrets'},
            {'operation':'drop','status':None}, {'operation':'count','status':'ready OR true'},
            {'operation':'count'}, {'operation':'unsupported','status':'ready'},
            {'operation':[],'status':None}, {'operation':'count','status':[]}]:
            conn=self.connection();model=MagicMock();model.plan.return_value=payload
            with self.assertRaises(ValueError): self.ask(self.service(conn,model))
            self.assertFalse(any('FROM knowledge_documents d' in c.args[0] for c in conn.execute.call_args_list))

    def test_unsupported_and_provider_failure_do_not_query_documents(self):
        from knowledge_extensions.model_gateway import ModelGatewayError
        for failed in [False,True]:
            conn=self.connection();model=MagicMock();model.plan.return_value={'operation':'unsupported','status':None}
            if failed:model.plan.side_effect=ModelGatewayError('unavailable')
            with self.assertRaises(ModelGatewayError if failed else ValueError):self.ask(self.service(conn,model))
            self.assertFalse(any('FROM knowledge_documents d' in c.args[0] for c in conn.execute.call_args_list))

    def test_revocation_before_planner_and_after_planner(self):
        for roles, expected_calls in [(['operator'],0),(['viewer','operator'],1)]:
            conn=self.connection();model=MagicMock();model.plan.return_value={'operation':'count','status':None}
            roles=iter(roles)
            with self.assertRaises(PermissionError):self.ask(self.service(conn,model),reauthorize=lambda:next(roles))
            self.assertEqual(model.plan.call_count,expected_calls)
            self.assertFalse(any('FROM knowledge_documents d' in c.args[0] for c in conn.execute.call_args_list))

    def test_long_table_stays_within_conversation_limit(self):
        from knowledge_extensions.conversation_store import _MAX_CONTENT
        conn=self.connection();original=conn.execute.side_effect
        def execute(sql,params=()):
            result=original(sql,params)
            if 'SELECT d.document_id' in sql:
                result.fetchall.return_value=[(USER,2147483647,'x'*240,'ready',2147483647)]*101
            return result
        conn.execute.side_effect=execute
        answer=execute_question(conn,tenant_id=TENANT,principal_id=USER,principal_role='viewer',question='List PDFs').answer
        self.assertLessEqual(len(answer),_MAX_CONTENT)
        shown=sum(line.startswith('| ') for line in answer.splitlines())-2
        self.assertGreater(shown,0);self.assertLess(shown,100)
        self.assertIn(f'Showing the first {shown} accessible documents.',answer)

    def test_executor_only_accepts_internal_plan_type(self):
        conn=self.connection()
        with self.assertRaises(ValueError):
            execute_question(conn,tenant_id=TENANT,principal_id=USER,principal_role='viewer',
                question='Count PDFs',plan={'operation':'count','status':None})
        conn.execute.assert_not_called()

    def test_inactive_tenant_membership_blocks_model_budget(self):
        conn=self.connection();original=conn.execute.side_effect
        def execute(sql,params=()):
            result=original(sql,params)
            if 'SELECT roles' in sql:
                self.assertEqual(params,(TENANT,USER));result.fetchone.return_value=None
            return result
        conn.execute.side_effect=execute;model=MagicMock()
        with self.assertRaises(PermissionError):self.ask(self.service(conn,model))
        model.plan.assert_not_called()

    def test_fallback_binds_verified_user_without_leaking_question_or_sql(self):
        from knowledge_extensions.model_gateway import _verified_user
        conn=self.connection();model=MagicMock()
        def plan(question, **kwargs):
            self.assertEqual(_verified_user.get(), USER)
            return {'operation':'pages','status':None}
        model.plan.side_effect=plan
        result=self.ask(self.service(conn,model))
        self.assertEqual(result.retrieval, {'structured_sql':1,'structured_planner':1})
        self.assertIsNone(_verified_user.get())

    def test_privileged_database_role_blocks_planner_before_egress(self):
        conn=self.connection();original=conn.execute.side_effect
        def execute(sql, params=()):
            result=original(sql,params)
            if 'pg_roles' in sql: result.fetchone.return_value=(True,)
            return result
        conn.execute.side_effect=execute;model=MagicMock()
        with self.assertRaises(PermissionError):self.ask(self.service(conn,model))
        model.plan.assert_not_called()

    def test_page_cardinality_is_unsupported_without_model_egress(self):
        conn=self.connection();model=MagicMock();service=self.service(conn,model)
        for question in ('How many pages do my PDFs have?', 'Show total pages for PDFs', 'List page coverage for PDFs'):
            self.assertEqual(plan_question(question).operation,'unsupported')
            with self.assertRaises(ValueError):
                service.ask(tenant_id=TENANT,principal_id=USER,principal_role='viewer',question=question,mode='structured')
        model.plan.assert_not_called()
        conn.execute.assert_not_called()

    def test_pages_report_last_indexed_page_without_claiming_coverage(self):
        conn=self.connection();original=conn.execute.side_effect
        def execute(sql,params=()):
            result=original(sql,params)
            if 'FROM knowledge_documents d' in sql:
                self.assertIn('max(c.page_end)',sql)
                result.fetchall.return_value=[('doc',2,'synthetic.pdf','ready',7)]
            return result
        conn.execute.side_effect=execute
        result=execute_question(conn,tenant_id=TENANT,principal_id=USER,principal_role='viewer',question='Show last indexed page for my PDFs')
        self.assertIn('Last indexed page',result.answer)
        self.assertIn('| 7 |',result.answer)

class StructuredEvidenceTests(StructuredSqlTests):
    def test_fresh_replay_and_changed_inventory(self):
        from knowledge_extensions.text_sql import authorize_evidence
        identity=dict(tenant_id=TENANT,principal_id=USER,principal_role='viewer')
        evidence=execute_question(self.connection(2),question='Count my PDFs',**identity).structured_evidence
        self.assertEqual(authorize_evidence(self.connection(2),evidence=evidence,**identity),{'authorized':True})
        with self.assertRaises(PermissionError): authorize_evidence(self.connection(1),evidence=evidence,**identity)
    def test_replay_rejects_untrusted_plan_fields_and_revocation(self):
        from knowledge_extensions.text_sql import authorize_evidence
        evidence={'operation':'count','status':None,'answer_sha256':'0'*64}
        identity=dict(tenant_id=TENANT,principal_id=USER,principal_role='viewer')
        for invalid in [{**evidence,'sql':'SELECT secret'},{**evidence,'operation':'delete'}, {**evidence,'answer_sha256':'bad'}]:
            with self.assertRaises(ValueError): authorize_evidence(self.connection(),evidence=invalid,**identity)
        with self.assertRaises(PermissionError):
            authorize_evidence(self.connection(),evidence=evidence,reauthorize=lambda:'admin',**identity)
