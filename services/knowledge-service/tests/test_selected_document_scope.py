from contextlib import nullcontext
from unittest import TestCase
from unittest.mock import MagicMock, patch
from knowledge_extensions.retrieval import retrieve_answer, tenant_namespace, _search_fts, _search_outline, _search_graph, _redact_sources
from knowledge_extensions.vector_store import VectorHit, PineconeVectorStore
from knowledge_extensions.document_summary import DocumentSummaryError

TENANT='11111111-1111-4111-8111-111111111111'
DOC='22222222-2222-4222-8222-222222222222'
OTHER='33333333-3333-4333-8333-333333333333'
CHUNK='44444444-4444-4444-8444-444444444444'
FOREIGN='55555555-5555-4555-8555-555555555555'

def source(chunk, document):
    return dict(chunk_id=chunk, document_id=document, document_version=1, text='Storage target is 13 percent.', page_start=1, page_end=1, heading_path=['Storage'], trust='curated')

class ScopeTests(TestCase):
    def test_every_sql_ranker_filters_before_limit(self):
        for search in [_search_fts, _search_outline, _search_graph]:
            connection=MagicMock()
            search(connection, TENANT, None, 'viewer', 'storage', 5, (DOC, 1))
            sql, params=connection.execute.call_args.args
            self.assertIn('c.document_id=%s AND c.document_version=%s', sql)
            self.assertIn(DOC, params)
            if search==_search_graph:
                self.assertIn('candidate.document_id=%s AND candidate.document_version=%s', sql)

    def test_canonical_scope_excludes_poisoned_vector_and_sql_sources(self):
        connection=MagicMock();connection.transaction.side_effect=lambda:nullcontext()
        models=MagicMock();models.embed.return_value=[[1.0]];models.rerank.return_value=[0]
        models.answer.return_value={'answer':'The target is 13 percent.', 'cited_chunk_ids':[CHUNK]}
        vectors=MagicMock();namespace=tenant_namespace(TENANT,b'namespace-secret-long-key-32-bytes')
        metadata={'tenant_ref':namespace,'embedding_version':'embed','tombstone':False}
        vectors.search.return_value=[VectorHit(FOREIGN,1,{**metadata,'doc_id':OTHER,'doc_version':1}),VectorHit(CHUNK,1,{**metadata,'doc_id':DOC,'doc_version':1})]
        sources=[source(CHUNK,DOC),source(FOREIGN,OTHER)]
        with patch('knowledge_extensions.retrieval._hydrate',return_value=sources), patch('knowledge_extensions.retrieval._search_fts',return_value=[FOREIGN,CHUNK]), patch('knowledge_extensions.retrieval._search_outline',return_value=[]), patch('knowledge_extensions.retrieval._search_graph',return_value=[]):
            result=retrieve_answer(connection,tenant_id=TENANT,principal_id=None,principal_role='viewer',question='What is the storage target?',namespace_key=b'namespace-secret-long-key-32-bytes',embedding_provider=models,vector_store=vectors,reranker=models,answer_generator=models,embedding_model='embed',reranker_model='rank',answer_model='answer',document_id=DOC,document_version=1)
        self.assertEqual(vectors.search.call_args.kwargs['document_scope'],(DOC,1))
        self.assertEqual({c['document_id'] for c in result.citations},{DOC})
        self.assertEqual({c['document_id'] for c in models.answer.call_args.args[1]},{DOC})
        self.assertEqual(models.rerank.call_args.args[1],['Storage target is 13 percent.'])

    def test_unauthorized_or_foreign_scope_denies_before_provider_calls(self):
        connection=MagicMock();connection.transaction.side_effect=lambda:nullcontext()
        connection.execute.return_value.fetchone.return_value=None
        models=MagicMock()
        with self.assertRaises(DocumentSummaryError) as error:
            retrieve_answer(connection,tenant_id=TENANT,principal_id=None,principal_role='viewer',question='What is the target?',namespace_key=b'secret',embedding_provider=models,vector_store=models,reranker=models,answer_generator=models,embedding_model='embed',reranker_model='rank',answer_model='answer',document_id=OTHER,document_version=1,require_membership=True)
        self.assertEqual(error.exception.status,404)
        models.embed.assert_not_called()
        sql, params=connection.execute.call_args.args
        self.assertIn('d.tenant_id=%s AND d.document_id=%s',sql)
        self.assertEqual(params[:3],(TENANT,OTHER,1))
        self.assertIn('m.active',sql)
        self.assertIn('v.acl_principals',sql)
        self.assertIn('v.min_role',sql)

    def test_revoked_membership_blocks_all_rankers_before_context_provider_calls(self):
        connection=MagicMock();connection.transaction.side_effect=lambda:nullcontext()
        models=MagicMock();models.embed.return_value=[[1.0]]
        vectors=MagicMock();vectors.search.return_value=[]
        trace={}
        def hydrate(*args, **kwargs):
            return [] if kwargs.get('require_membership') else [source(CHUNK,DOC)]
        with patch('knowledge_extensions.retrieval._hydrate',side_effect=hydrate) as hydration, patch('knowledge_extensions.retrieval._search_fts',return_value=[CHUNK]), patch('knowledge_extensions.retrieval._search_outline',return_value=[CHUNK]), patch('knowledge_extensions.retrieval._search_graph',return_value=[CHUNK]):
            result=retrieve_answer(connection,tenant_id=TENANT,principal_id=FOREIGN,principal_role='viewer',question='What is the storage target?',namespace_key=b'namespace-secret-long-key-32-bytes',embedding_provider=models,vector_store=vectors,reranker=models,answer_generator=models,embedding_model='embed',reranker_model='rank',answer_model='answer',require_membership=True,evaluation_trace=trace)
        self.assertEqual(result.citations,())
        self.assertTrue(hydration.call_args.kwargs['require_membership'])
        self.assertEqual(trace['rankings']['pageindex'],[CHUNK])
        self.assertEqual(trace['rankings']['knowledge_graph'],[CHUNK])
        self.assertEqual(trace['fused_candidate_ids'],[CHUNK])
        self.assertEqual(trace['candidate_ids'],[])
        models.rerank.assert_not_called()
        models.answer.assert_not_called()

    def test_pinecone_filters_document_and_version_before_top_k(self):
        store=PineconeVectorStore(index_host='index.example.pinecone.io',api_key='test-key')
        with patch.object(store,'_request',return_value={'matches':[]}) as request:
            store.search(namespace='tenant',vector=[1.0],top_k=5,document_scope=(DOC,2))
        payload=request.call_args.args[1]
        self.assertEqual(payload['filter'],{'tombstone':{'$eq':False},'doc_id':{'$eq':DOC},'doc_version':{'$eq':2}})
        self.assertEqual(payload['topK'],5)

    def test_private_key_redaction_is_isolated_by_document_and_version(self):
        items=[source(CHUNK,DOC),source(FOREIGN,OTHER)]
        items[0]['text']='-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'
        result=_redact_sources(items)
        self.assertEqual(result[0]['text'],'[REDACTED_PRIVATE_KEY]')
        self.assertEqual(result[1]['text'],items[1]['text'])
        self.assertEqual([s['chunk_id'] for s in result],[CHUNK,FOREIGN])
