import unittest
from unittest.mock import Mock, patch
from evals.live_adapters import LivePorts
from knowledge_extensions.vector_store import VectorRecord

class LiveEvalCleanupTests(unittest.TestCase):
    def setUp(self):
        self.ports = LivePorts.__new__(LivePorts)
        self.ports.store = Mock()
        self.ports.writes = {}

    def test_ambiguous_write_is_still_cleaned(self):
        self.ports.store.upsert.side_effect = RuntimeError('timeout')
        record = VectorRecord('id', (1.0,), {})
        with self.assertRaises(RuntimeError):
            self.ports.upsert(namespace='isolated', records=[record])
        self.ports.close()
        self.ports.store.delete.assert_called_once_with(namespace='isolated', chunk_ids=['id'])

    def test_cleanup_failure_is_not_a_pass(self):
        self.ports.writes = {'a':{'one'}, 'b':{'two'}}
        self.ports.store.delete.side_effect = [RuntimeError('unavailable'), None]
        with self.assertRaisesRegex(RuntimeError, 'retry namespaces: a'):
            self.ports.close()
        self.assertEqual(self.ports.store.delete.call_count,2)

    def test_visibility_waits_for_whole_namespace(self):
        self.ports.writes = {'a':{'one','two'}}
        self.ports.store.describe_stats.side_effect = [
            {'namespaces':{'a':{'vectorCount':1}}},
            {'namespaces':{'a':{'vectorCount':2}}}]
        with patch('evals.live_adapters.time.sleep') as sleep:
            self.ports.await_index()
        sleep.assert_called_once_with(1)

class LiveEvalCachingTests(unittest.TestCase):
    def setUp(self):
        self.ports=LivePorts.__new__(LivePorts)
        self.ports.gateway=Mock()
        self.ports.tenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        self.ports.embedding_cache={}
        self.ports.ranking_cache={}
        self.ports.pace=Mock()

    def test_embedding_batch_deduplicates_and_separates_input_type(self):
        self.ports.gateway.embed.side_effect=[[[1.0],[2.0]],[[3.0]]]
        first=self.ports.embed(['one','two','one'],model='embed-v1',input_type='passage')
        self.assertEqual(first,[[1.0],[2.0],[1.0]])
        self.assertEqual(self.ports.embed(['one'],model='embed-v1',input_type='passage'),[[1.0]])
        self.assertEqual(self.ports.embed(['one'],model='embed-v1',input_type='query'),[[3.0]])
        self.assertEqual(self.ports.gateway.embed.call_count,2)

    def test_ranking_cache_respects_candidate_order(self):
        self.ports.gateway.rerank.return_value=[0]
        self.ports.rerank('q',['a','b'],model='rerank-v1',top_n=1)
        self.ports.rerank('q',['a','b'],model='rerank-v1',top_n=1)
        self.assertEqual(self.ports.gateway.rerank.call_count,1)
        self.ports.rerank('q',['b','a'],model='rerank-v1',top_n=1)
        self.assertEqual(self.ports.gateway.rerank.call_count,2)

    def test_answers_are_paced_and_never_cached(self):
        self.ports.answer('q',[],model='answer-v1')
        self.ports.answer('q',[],model='answer-v1')
        self.assertEqual(self.ports.pace.call_count,2)
        self.assertEqual(self.ports.gateway.answer.call_count,2)

class LiveEvalCleanupRetryTests(unittest.TestCase):
    def test_retry_only_retains_failed_namespaces(self):
        ports = LivePorts.__new__(LivePorts)
        ports.store = Mock()
        ports.writes = {'a':{'one'}, 'b':{'two'}}
        ports.store.delete.side_effect = [RuntimeError('unavailable'), None, None]
        with self.assertRaises(RuntimeError):
            ports.close()
        self.assertEqual(ports.writes, {'a':{'one'}})
        ports.close()
        self.assertEqual(ports.writes, {})
        self.assertEqual(ports.store.delete.call_count,3)
