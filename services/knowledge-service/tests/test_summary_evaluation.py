import unittest
from knowledge_extensions.summary_evaluation import evaluate_summary,require_summary_quality

class SummaryEvalTests(unittest.TestCase):
    def setUp(self):
        self.sources=[dict(chunk_id='a',document_id='d',document_version=1,page_start=1,page_end=1),
                      dict(chunk_id='b',document_id='d',document_version=1,page_start=2,page_end=2)]
        self.sections=[dict(heading='Drying',facts=['Record the drying temperature']),
                       dict(heading='Emergency isolation',facts=['Disconnect the supply before maintenance'])]
        self.answer='## Drying\nRecord the drying temperature.\n## Emergency isolation\nDisconnect the supply before maintenance.'
    def eval(self,answer=None,citations=None):
        return evaluate_summary(dict(answer=answer or self.answer,citations=self.sources if citations is None else citations),sections=self.sections,sources=self.sources)
    def test_complete_summary_passes_four_independent_contract_metrics(self):
        self.assertTrue(require_summary_quality(self.eval()))
    def test_omitted_section_and_fact_fail_quality_gate(self):
        result=self.eval(answer='Drying: Record the drying temperature.')
        self.assertEqual(result['section_coverage'],0.5)
        self.assertEqual(result['expected_fact_coverage'],0.5)
        self.assertFalse(require_summary_quality(result))
    def test_fabricated_pages_and_missing_citations_fail(self):
        bad=[{**self.sources[0],'page_start':99}]
        result=self.eval(citations=bad)
        self.assertEqual(result['citation_accuracy'],0)
        self.assertEqual(result['citation_completeness'],0)
        self.assertFalse(require_summary_quality(result))
    def test_metric_does_not_claim_semantic_faithfulness(self):
        self.assertEqual(self.eval()['semantic_faithfulness'],'requires_independent_review')
