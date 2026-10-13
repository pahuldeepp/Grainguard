import json
from pathlib import Path
import tempfile
import unittest
from knowledge_extensions.operations_reports import evaluation_snapshot
from knowledge_extensions.retrieval_cache import RedisJsonCache

class OperationsReportsTests(unittest.TestCase):
    def test_report_is_allowlisted_synthetic_not_production(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'report.json'
            path.write_text(json.dumps({'dataset_version':'synthetic-answer-contract-v1','case_count':1,'passed':True,
                'cases':[{'passed':True,'prompt':'private prompt','token':'private secret'}],'tenant_id':'other','secret':'do not expose'}))
            result=evaluation_snapshot(path)
            self.assertTrue(result['available'])
            self.assertFalse(result['production_baseline'])
            self.assertEqual(result['passed_count'],1)
            self.assertNotIn('private',json.dumps(result))
            self.assertNotIn('do not expose',json.dumps(result))
            path.write_text('{bad')
            self.assertFalse(evaluation_snapshot(path)['available'])
    def test_invalid_missing_inconsistent_or_oversized_report(self):
        self.assertFalse(evaluation_snapshot(None)['available'])
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'report.json'
            for value in [[],{}, {'dataset_version':'synthetic-answer-contract-v1','case_count':1,'passed':True,'cases':[{'passed':False}]}, {'dataset_version':'production','case_count':1,'passed':True,'cases':[{'passed':True}]}]:
                path.write_text(json.dumps(value))
                self.assertFalse(evaluation_snapshot(path)['available'])
            path.write_text(' '*131073)
            self.assertFalse(evaluation_snapshot(path)['available'])
    def test_cache_metrics_are_tenant_scoped_bounded_and_content_free(self):
        cache=RedisJsonCache('redis://127.0.0.1:6379')
        cache.record_lookup('tenant-a','retrieval',True)
        cache.record_lookup('tenant-a','embedding',False)
        self.assertEqual(cache.snapshot('tenant-a')['hit_ratio'],.5)
        self.assertEqual(cache.snapshot('tenant-b')['retrieval_hits'],0)
        self.assertIsNone(cache.snapshot('tenant-b')['hit_ratio'])
        self.assertNotIn('tenant-a',json.dumps(cache.snapshot('tenant-a')))
        for i in range(1001):cache.record_lookup(str(i),'embedding',True)
        self.assertEqual(len(cache._metrics),1000)
        self.assertEqual(cache.snapshot('tenant-a')['retrieval_hits'],0)
