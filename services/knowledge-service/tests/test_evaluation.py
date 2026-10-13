import math
import unittest
from knowledge_extensions.evaluation import recall_at_k, ndcg_at_k, unsupported_numbers, gate

class EvaluationTests(unittest.TestCase):
    def test_known_recall_and_graded_ndcg(self):
        labels={'a':3,'b':1}
        self.assertEqual(recall_at_k(['a','noise','b'],labels,1),0.5)
        self.assertEqual(recall_at_k(['a','noise','b'],labels,10),1.0)
        self.assertEqual(ndcg_at_k(['a','b'],labels,2),1.0)
        expected=(1+7/math.log2(3))/(7+1/math.log2(3))
        self.assertAlmostEqual(ndcg_at_k(['b','a'],labels,2),expected)
        self.assertEqual(ndcg_at_k([],labels,5),0)

    def test_invalid_or_duplicate_rankings_fail(self):
        for ranking,labels,k in [(['a','a'],{'a':1},5),(['a'],{},5),(['a'],{'a':1},True),(['a'],{'a':4},5)]:
            with self.assertRaises(ValueError):ndcg_at_k(ranking,labels,k)

    def test_numeric_support_is_not_semantic_faithfulness(self):
        self.assertEqual(unsupported_numbers('Moisture is 13 percent.', ['Dry to 13 percent.']),[])
        self.assertEqual(unsupported_numbers('Moisture is 99 percent.', ['Dry to 13 percent.']),['99'])

    def test_gate_fails_on_regressions_missing_and_nan_metrics(self):
        thresholds=dict(recall_at_10=.85,ndcg_at_5=.8,citation_accuracy=.98,reference_fact_coverage=1,unsupported_numbers=0,security_failures=0)
        good=dict(case_count=12,recall_at_10=1,ndcg_at_5=1,citation_accuracy=1,reference_fact_coverage=1,unsupported_numbers=0,security_failures=0)
        self.assertEqual(gate(good,thresholds),[])
        for metric,value in [('recall_at_10',.5),('ndcg_at_5',float('nan')),('citation_accuracy',0),('unsupported_numbers',1),('security_failures',1),('case_count',0)]:
            self.assertTrue(gate(good|{metric:value},thresholds),metric)
        self.assertTrue(gate({},thresholds))
        self.assertEqual(gate(good,thresholds|{"recall_at_10":float("nan")}),["invalid_threshold_policy"])
        self.assertEqual(gate(good,thresholds|{"security_failures":1}),["invalid_threshold_policy"])

class AnswerCheckTests(unittest.TestCase):
    def test_nonempty_context_abstention_and_forbidden_output(self):
        from evals.answer_checks import check_answer
        context=[{'chunk_id':'c','text':'Check temperature daily.'}]
        case={'kind':'unanswerable','must_not_contain':['PRIVATE-42']}
        self.assertEqual(check_answer(case, "I couldn't find sufficient evidence in the authorized source passages to answer that.", [], context), [])
        self.assertIn('expected_abstention',check_answer(case,'Invented policy.',[{'chunk_id':'c'}],context))
        self.assertIn('forbidden_output',check_answer(case,'PRIVATE-42',[],context))

    def test_conflict_requires_both_reference_facts_and_citations(self):
        from evals.answer_checks import check_answer
        case={'kind':'conflicting','must_contain':['Monday','Thursday']}
        context=[{'chunk_id':'a','text':'Monday.'},{'chunk_id':'b','text':'Thursday.'}]
        self.assertEqual(check_answer(case,'A says Monday; B says Thursday.',[{'chunk_id':'a'},{'chunk_id':'b'}],context),[])
        self.assertIn('reference_fact_missing',check_answer(case,'Monday.',[{'chunk_id':'a'}],context))
        self.assertIn('invalid_citation',check_answer(case,'Monday and Thursday.',[{'chunk_id':'foreign'}],context))

class CalibrationTests(unittest.TestCase):
    def test_no_invented_labels_or_uncalibrated_success(self):
        from evals.calibration import calibrate
        self.assertEqual(calibrate([])['status'],'insufficient_reviewed_sample')
        with self.assertRaises(ValueError):
            calibrate([{'case_id':'x','claim_id':'1','human_label':None,'judge_label':'supported'}])
        rows=[{'case_id':'x','claim_id':str(i),'human_label':'supported' if i%2 else 'unsupported','judge_label':'supported'} for i in range(30)]
        result=calibrate(rows)
        self.assertEqual(result['agreement'],.5)
        self.assertEqual(result['false_support_rate'],1)
        with self.assertRaises(ValueError):calibrate(rows+[rows[0]])

class ExpandedGateTests(unittest.TestCase):
    def test_behavior_failures_cannot_be_averaged_away(self):
        thresholds=dict(recall_at_10=.85,ndcg_at_5=.8,citation_accuracy=.98,reference_fact_coverage=1,unsupported_numbers=0,security_failures=0,behavior_failures=0)
        good=dict(case_count=12,recall_at_10=1,ndcg_at_5=1,citation_accuracy=1,reference_fact_coverage=1,unsupported_numbers=0,security_failures=0,behavior_failures=0)
        self.assertEqual(gate(good,thresholds),[])
        self.assertIn('behavior_failures',gate(good|{'behavior_failures':1},thresholds))
        self.assertIn('behavior_failures',gate(good|{'behavior_failures':None},thresholds))
