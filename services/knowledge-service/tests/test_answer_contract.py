"""Synthetic controls must detect weakened checks, not merely execute them."""
from copy import deepcopy
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from evals.run_answer_contract import evaluate, run


class AnswerContractTests(unittest.TestCase):
    def setUp(self):
        self.corpus = json.loads((Path(__file__).resolve().parents[1] / 'evals/answer_contract.v1.json').read_text())

    def test_authored_positive_and_negative_controls(self):
        report = evaluate(self.corpus)
        self.assertTrue(report['passed'], report['failure_ids'])
        self.assertEqual(report['case_count'], 29)
        self.assertFalse(report['production_baseline'])
        self.assertEqual(report['semantic_faithfulness'], 'not_run')

    def test_disabled_checks_fail_the_gate(self):
        with patch('evals.run_answer_contract.check_answer', return_value=[]):
            report = evaluate(self.corpus)
        self.assertFalse(report['passed'])
        self.assertEqual(len(report['failure_ids']), 25)

    def test_overblocking_checks_fail_positive_controls(self):
        with patch('evals.run_answer_contract.check_answer', return_value=['invalid_citation']):
            self.assertFalse(evaluate(self.corpus)['passed'])

    def test_empty_and_duplicate_datasets_fail(self):
        for cases in ([], [self.corpus['cases'][0]] * 2):
            corpus = deepcopy(self.corpus)
            corpus['cases'] = cases
            with self.assertRaises(ValueError):
                evaluate(corpus)

    def test_malformed_independent_review_records_fail_safely(self):
        from evals.calibration import calibrate
        for record in (None, [], 'supported', 1):
            with self.assertRaises(ValueError):
                calibrate([record])

    def test_runner_writes_failed_report_before_raising(self):
        import tempfile
        with tempfile.TemporaryDirectory() as destination:
            with patch('evals.run_answer_contract.check_answer', return_value=[]):
                with self.assertRaises(AssertionError):
                    run(destination)
            report = json.loads((Path(destination) / 'answer-contract.json').read_text())
            self.assertFalse(report['passed'])
            self.assertEqual(len(report['dataset_sha256']), 64)


class LiveAnswerProbeTests(unittest.TestCase):
    def test_provider_failures_never_become_model_security_passes(self):
        from unittest.mock import Mock
        from evals.run_answer_live import evaluate
        gateway = Mock()
        gateway.answer.side_effect = RuntimeError('synthetic private provider detail')
        report = evaluate(gateway, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        self.assertEqual(gateway.answer.call_count, 4)
        self.assertFalse(report['passed'])
        self.assertNotIn('private provider detail', json.dumps(report))
        self.assertEqual(report['model_attack_resistance'], 'not_established')

    def test_generated_canary_leak_fails_and_report_omits_response(self):
        from unittest.mock import Mock
        from evals.run_answer_live import evaluate
        gateway = Mock()
        gateway.answer.return_value = {'answer':'SYNTHETIC-KEY-CANARY-ALPHA', 'cited_chunk_ids':[]}
        report = evaluate(gateway, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        self.assertFalse(report['passed'])
        self.assertIn('secret_leakage', report['cases'][2]['errors'])
        self.assertNotIn('SYNTHETIC-KEY-CANARY-ALPHA', json.dumps(report))

    def test_secret_detection_mutation_fails_gate(self):
        corpus = json.loads((Path(__file__).resolve().parents[1] / 'evals/answer_contract.v1.json').read_text())
        with patch('evals.answer_checks._leaks', return_value=False):
            report = evaluate(corpus)
        self.assertFalse(report['passed'])
        self.assertEqual(len([case for case in report['failure_ids'] if case.startswith('secret-leak-')]),5)

    def test_malformed_context_fails_without_crashing(self):
        from evals.answer_checks import check_answer
        for context in (None, [{}], [{'chunk_id':'c','text':None}], [{'chunk_id':'c','text':'a'}]*2):
            self.assertEqual(check_answer({}, 'Answer', [], context), ['invalid_context'])

    def test_malformed_generated_payload_is_contract_failure(self):
        from unittest.mock import Mock
        from evals.run_answer_live import evaluate
        gateway = Mock()
        gateway.answer.return_value = {'answer':'Text'}
        report = evaluate(gateway, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        self.assertEqual(report['cases'][0]['status'], 'measured')
        self.assertEqual(report['cases'][0]['errors'], ['invalid_citation'])
