import copy
import json
import unittest
from evals.run_agent import DATASET, evaluate

class AgentEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.dataset=json.loads(DATASET.read_text())
        # Evaluator unit controls, never represented as model observations.
        self.controls=[{'case_id':c['id'],'status':c['expected_status'],
            'calls':copy.deepcopy(c['expected_calls']),
            'answer':' '.join(c['required_phrases']),
            'approval_required':c['approval_required'],'executed':False}
            for c in self.dataset['cases']]

    def test_positive_controls_and_provenance(self):
        report=evaluate(self.dataset,self.controls)
        self.assertEqual(report['failure_count'],0)
        self.assertFalse(report['provenance']['human_reviewed'])
        self.assertEqual(report['semantic_quality'],'not_run')
        self.assertEqual(report['tool_selection_accuracy'],1)

    def test_disabled_boundary_and_overblocking_are_detected(self):
        for id,field,value in [('revoked-after-generation','status',200),
                ('revoked-between-tools','answer','PRIVATE-CANARY'),
                ('count-ready','status',403),('ack-approval','approval_required',False),
                ('ack-approval','executed',True),('missing-readings','answer','20 degrees')]:
            with self.subTest(id=id,field=field):
                traces=copy.deepcopy(self.controls)
                next(t for t in traces if t['case_id']==id)[field]=value
                self.assertGreater(evaluate(self.dataset,traces)['failure_count'],0)

    def test_wrong_tool_order_operation_range_and_authority_are_detected(self):
        for mutate in [lambda calls:calls.reverse(),
                lambda calls:calls[0]['args'].update(tenant_id='foreign'),
                lambda calls:calls[1]['args'].update(operation='risk_history'),
                lambda calls:calls.pop()]:
            traces=copy.deepcopy(self.controls)
            mutate(next(t for t in traces if t['case_id']=='mixed-count-device')['calls'])
            report=evaluate(self.dataset,traces)
            self.assertLess(report['tool_selection_accuracy'],1)

    def test_bounded_history_arguments_are_exact(self):
        for field,value in [('from','2020-01-01T00:00:00Z'),('bucket','minute')]:
            traces=copy.deepcopy(self.controls)
            trace=next(t for t in traces if t['case_id']=='telemetry_rollups')
            trace['calls'][0]['args'][field]=value
            self.assertLess(evaluate(self.dataset,traces)['tool_selection_accuracy'],1)

    def test_incomplete_duplicate_extra_and_malformed_results_fail(self):
        for traces in [[],self.controls[:-1],self.controls+[self.controls[0]],
                self.controls+[{'case_id':'unexpected'}]]:
            with self.assertRaises(ValueError):evaluate(self.dataset,traces)
        for field in ['status','calls','answer','approval_required','executed']:
            traces=copy.deepcopy(self.controls)
            del traces[0][field]
            self.assertGreater(evaluate(self.dataset,traces)['failure_count'],0)

    def test_nonobject_trace_inputs_fail_with_value_error(self):
        for traces in (None, {}, [None], [{'case_id':[]}], 'invalid'):
            with self.assertRaises(ValueError):
                evaluate(self.dataset, traces)
