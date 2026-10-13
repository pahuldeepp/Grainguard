from contextlib import nullcontext
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest import TestCase
from unittest.mock import MagicMock, patch
from knowledge_extensions.retrieval import retrieve_answer
from knowledge_extensions.retrieval_cache import RedisJsonCache, valid_rankings, valid_vector, corpus_revision
from test_selected_document_scope import TENANT, DOC, CHUNK, FOREIGN, source


class MemoryCache:
    key = staticmethod(RedisJsonCache.key)
    def __init__(self): self.values={}
    def get(self,key): return self.values.get(key)
    def put(self,key,value,**kwargs): self.values[key]=value


class RetrievalCacheTests(TestCase):
    def test_keys_hide_question_and_tenant_and_bind_all_identity_dimensions(self):
        base=[TENANT,'principal','viewer','model','question about private warehouse',(DOC,1),'revision']
        key=RedisJsonCache.key('candidates',base)
        self.assertNotIn(TENANT,key);self.assertNotIn('warehouse',key)
        for index in range(len(base)):
            changed=base.copy();changed[index]='different'
            self.assertNotEqual(key,RedisJsonCache.key('candidates',changed))
        self.assertFalse(valid_vector([float('nan')]));self.assertFalse(valid_vector([True]))
        self.assertFalse(valid_rankings({'dense':[CHUNK]},20))
        self.assertFalse(valid_rankings(dict(dense=['notuuid'],fts=[],pageindex=[],knowledge_graph=[]),20))

    def test_redis_outage_and_poisoned_json_are_cache_misses(self):
        cache=RedisJsonCache('redis://127.0.0.1:1')
        with patch.object(cache,'_command',side_effect=OSError):
            self.assertIsNone(cache.get('key'));cache.put('key',{'dense':[]})
        with patch('knowledge_extensions.retrieval_cache.time.monotonic', return_value=cache._retry_after + 1), patch.object(cache,'_command',return_value=b'not-json'):
            self.assertIsNone(cache.get('key'))
        for ttl in (0,301):
            with self.assertRaises(ValueError):RedisJsonCache('redis://localhost',ttl_seconds=ttl)

    def test_repeated_cached_candidates_rehydrate_and_revision_or_membership_invalidates(self):
        db=MagicMock();db.transaction.side_effect=lambda:nullcontext()
        models=MagicMock();models.embed.return_value=[[1.0]];models.rerank.return_value=[0]
        models.answer.return_value={'answer':'The storage target is 13 percent.','cited_chunk_ids':[CHUNK]}
        vectors=MagicMock();vectors.search.return_value=[]
        cache=MemoryCache();state={'revision':'one','authorized':True}
        def hydration(*args,**kwargs):
            self.assertTrue(kwargs['require_membership'])
            return [source(CHUNK,DOC)] if state['authorized'] else []
        def ask(trace,tenant=TENANT):
            return retrieve_answer(db,tenant_id=tenant,principal_id=FOREIGN,principal_role='viewer',question='What is the storage target?',namespace_key=b'namespace-secret-long-key-32-bytes',embedding_provider=models,vector_store=vectors,reranker=models,answer_generator=models,embedding_model='embed',reranker_model='rank',answer_model='answer',context_k=1,require_membership=True,cache=cache,evaluation_trace=trace)
        with patch('knowledge_extensions.retrieval_cache.corpus_revision',side_effect=lambda *a:state['revision']),patch('knowledge_extensions.retrieval._hydrate',side_effect=hydration),patch('knowledge_extensions.retrieval._search_fts',return_value=[]),patch('knowledge_extensions.retrieval._search_outline',return_value=[CHUNK]) as outline,patch('knowledge_extensions.retrieval._search_graph',return_value=[CHUNK]):
            first={};self.assertTrue(ask(first).citations)
            second={};self.assertTrue(ask(second).citations)
            self.assertTrue(second['candidate_cache_hit']);self.assertEqual(models.embed.call_count,1);self.assertEqual(outline.call_count,1)
            state['authorized']=False;revoked={};self.assertFalse(ask(revoked).citations)
            self.assertTrue(revoked['candidate_cache_hit']);self.assertEqual(models.answer.call_count,2)
            state['revision']='two';new={};ask(new)
            self.assertFalse(new['candidate_cache_hit']);self.assertTrue(new['embedding_cache_hit']);self.assertEqual(outline.call_count,2)
            foreign={};ask(foreign,tenant='66666666-6666-4666-8666-666666666666')
            self.assertFalse(foreign['candidate_cache_hit']);self.assertFalse(foreign['embedding_cache_hit']);self.assertEqual(models.embed.call_count,2)

    def test_missing_or_unavailable_revision_bypasses_candidates_and_hydrates(self):
        db=MagicMock();db.transaction.side_effect=lambda:nullcontext()
        models=MagicMock();models.embed.return_value=[[1.0]];models.rerank.return_value=[0]
        models.answer.return_value={'answer':'The storage target is 13 percent.','cited_chunk_ids':[CHUNK]}
        vectors=MagicMock();vectors.search.return_value=[]
        for failure in (None,RuntimeError('revision unavailable')):
            cache=MemoryCache()
            effect = failure if isinstance(failure,Exception) else lambda *args:None
            with patch('knowledge_extensions.retrieval_cache.corpus_revision',side_effect=effect),patch('knowledge_extensions.retrieval._hydrate',return_value=[source(CHUNK,DOC)]) as hydrate,patch('knowledge_extensions.retrieval._search_fts',return_value=[CHUNK]) as lexical,patch('knowledge_extensions.retrieval._search_outline',return_value=[]),patch('knowledge_extensions.retrieval._search_graph',return_value=[]):
                for _ in range(2):
                    trace={}
                    result=retrieve_answer(db,tenant_id=TENANT,principal_id=FOREIGN,principal_role='viewer',question='What is the storage target?',namespace_key=b'namespace-secret-long-key-32-bytes',embedding_provider=models,vector_store=vectors,reranker=models,answer_generator=models,embedding_model='embed',reranker_model='rank',answer_model='answer',context_k=1,require_membership=True,cache=cache,evaluation_trace=trace)
                    self.assertTrue(result.citations)
                    self.assertFalse(trace['candidate_cache_hit'])
                self.assertEqual(lexical.call_count,2)
                # Each query hydrates its retrieval candidates and independently
                # rehydrates cited rows immediately before returning the answer.
                # The second check is the authorization/version race guard.
                self.assertEqual(hydrate.call_count,4)
                self.assertTrue(all(':embedding:' in key for key in cache.values))

    def test_corpus_revision_is_tenant_primary_key_lookup_and_missing_bypasses(self):
        db=MagicMock();db.execute.return_value.fetchone.return_value=(17,)
        self.assertEqual(corpus_revision(db,TENANT,(DOC,2)),17)
        sql,params=db.execute.call_args.args
        self.assertEqual(sql,'SELECT revision FROM knowledge_cache_revisions WHERE tenant_id=%s')
        self.assertEqual(params,(TENANT,))
        for row in (None,(0,),('invalid',),(True,)):
            db.execute.return_value.fetchone.return_value=row
            self.assertIsNone(corpus_revision(db,TENANT,None))

    def test_passage_embeddings_batch_misses_and_separate_tenant_model_type(self):
        from knowledge_extensions.retrieval_cache import CachedModelPorts
        cache=MemoryCache();models=MagicMock()
        models.embed.side_effect=lambda texts,**kwargs:[[float(len(t))] for t in texts]
        wrapped=CachedModelPorts(models,cache,b'namespace-secret-long-key-32-bytes')
        args=dict(tenant_id=TENANT,model='embedding-model',input_type='passage')
        first=wrapped.embed(['one','two'],**args)
        self.assertEqual(wrapped.embed(['one','two'],**args),first)
        self.assertEqual(models.embed.call_count,1)
        wrapped.embed(['one','new'],**args)
        self.assertEqual(models.embed.call_args.args[0],['new'])
        for change in ({'tenant_id':DOC},{'model':'new-model'},{'input_type':'query'}):
            wrapped.embed(['one'],**(args|change))
        self.assertEqual(models.embed.call_count,5)
        self.assertTrue(all('one' not in key for key in cache.values))
        models.embed.return_value=[[float('nan')]];models.embed.side_effect=None
        with self.assertRaises(Exception):wrapped.embed(['invalid'],**args)

    def test_hydration_checks_parent_and_version_permissions_before_provider(self):
        from knowledge_extensions.retrieval import _hydrate
        db=MagicMock();db.execute.return_value.fetchall.return_value=[]
        self.assertEqual(_hydrate(db,TENANT,FOREIGN,'viewer',[CHUNK],require_membership=True),[])
        sql,params=db.execute.call_args.args
        for fragment in ("v.processing_status='ready'",'v.min_role','v.acl_principals','m.active','GREATEST'):
            self.assertIn(fragment,sql)
        self.assertEqual(params,(TENANT,[CHUNK],'viewer',FOREIGN,FOREIGN,'viewer',FOREIGN,FOREIGN,FOREIGN))


class RedisFailureCooldownTests(TestCase):
    def test_failure_skips_get_and_put_until_monotonic_recovery_probe(self):
        cache = RedisJsonCache('redis://localhost', failure_cooldown_seconds=5)
        now = [100.0]
        with patch('knowledge_extensions.retrieval_cache.time.monotonic', side_effect=lambda:now[0]), patch.object(cache, '_command', side_effect=OSError) as command:
            self.assertIsNone(cache.get('first'))
            for _ in range(100):
                self.assertIsNone(cache.get('next'))
                cache.put('key', [1.0])
            self.assertEqual(command.call_count, 1)
            now[0] = 104.999
            self.assertIsNone(cache.get('still cooling'))
            self.assertEqual(command.call_count, 1)
            now[0] = 105.0
            command.side_effect = None
            command.return_value = b'[1.0]'
            self.assertEqual(cache.get('recovered'), [1.0])
            self.assertEqual(cache.get('healthy'), [1.0])
            self.assertEqual(command.call_count, 3)

    def test_concurrent_outage_and_recovery_allow_only_one_probe(self):
        cache = RedisJsonCache('redis://localhost')
        entered = Event()
        release = Event()
        def failure(*parts):
            entered.set()
            self.assertTrue(release.wait(2))
            raise OSError('unavailable')
        # A previous failure has ended its cooldown; only this recovery probe runs.
        cache._retry_after = 1.0
        with patch.object(cache, '_command', side_effect=failure) as command, ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(cache.get, 'first')
            self.assertTrue(entered.wait(2))
            self.assertIsNone(pool.submit(cache.get, 'second').result(timeout=1))
            cache.put('key', [1.0])
            self.assertEqual(command.call_count, 1)
            release.set()
            self.assertIsNone(first.result(timeout=1))
            self.assertIsNone(cache.get('cooldown'))
            self.assertEqual(command.call_count, 1)
        entered.clear()
        release.clear()
        def recovered(*parts):
            entered.set()
            self.assertTrue(release.wait(2))
            return b'[2.0]'
        with patch('knowledge_extensions.retrieval_cache.time.monotonic', return_value=cache._retry_after), patch.object(cache, '_command', side_effect=recovered) as command, ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(cache.get, 'probe')
            self.assertTrue(entered.wait(2))
            self.assertIsNone(pool.submit(cache.get, 'concurrent').result(timeout=1))
            self.assertEqual(command.call_count, 1)
            release.set()
            self.assertEqual(first.result(timeout=1), [2.0])
            self.assertEqual(cache.get('healthy'), [2.0])

    def test_invalid_cooldowns_rejected(self):
        for value in (0, 31, float('nan'), True):
            with self.assertRaises(ValueError):
                RedisJsonCache('redis://localhost', failure_cooldown_seconds=value)

    def test_healthy_commands_run_concurrently(self):
        cache = RedisJsonCache('redis://localhost')
        from threading import Barrier
        barrier = Barrier(2)
        def command(*parts):
            barrier.wait(timeout=2)
            return b'[3.0]'
        with patch.object(cache, '_command', side_effect=command) as run, ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(cache.get, 'one')
            second = pool.submit(cache.get, 'two')
            self.assertEqual(first.result(timeout=3), [3.0])
            self.assertEqual(second.result(timeout=3), [3.0])
            self.assertEqual(run.call_count, 2)

    def test_healthy_completion_does_not_clear_concurrent_failure_cooldown(self):
        cache = RedisJsonCache('redis://localhost')
        entered, release = Event(), Event()
        def command(*parts):
            if parts[-1] == 'slow':
                entered.set()
                self.assertTrue(release.wait(2))
                return b'[1.0]'
            raise OSError('unavailable')
        with patch.object(cache, '_command', side_effect=command), ThreadPoolExecutor(max_workers=2) as pool:
            slow = pool.submit(cache.get, 'slow')
            self.assertTrue(entered.wait(2))
            self.assertIsNone(cache.get('failure'))
            cooldown = cache._retry_after
            release.set()
            self.assertEqual(slow.result(timeout=2), [1.0])
            self.assertEqual(cache._retry_after, cooldown)


class PrivateRedisCATests(TestCase):
    def test_private_ca_is_explicit_and_keeps_tls_verification(self):
        with patch("knowledge_extensions.retrieval_cache.ssl.create_default_context") as context:
            cache = RedisJsonCache("rediss://ai-redis.greenguard.svc.cluster.local:6379", ca_file="/redis-ca/ca.pem")
            context.assert_called_once_with(cafile="/redis-ca/ca.pem")
            self.assertIs(cache.tls_context, context.return_value)
        with self.assertRaises(ValueError):
            RedisJsonCache("redis://localhost", ca_file="/redis-ca/ca.pem")
