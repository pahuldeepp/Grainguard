import json
import unittest
from knowledge_extensions.parser_sandbox import bind_passages,ContainerPdfParser
from knowledge_extensions.pdf_parser import PdfParseError

class SandboxTests(unittest.TestCase):
    def test_result_bound_to_trusted_identity(self):
        args=dict(data=b'%PDF-test',tenant_id='11111111-1111-4111-8111-111111111111',
                  document_id='22222222-2222-4222-8222-222222222222',document_version=1)
        passage=dict(content='Store wheat dry.',page_start=1,page_end=1,heading_path=['Storage'])
        result=bind_passages(json.dumps({'passages':[passage]}).encode(),**args)
        self.assertEqual(result.tenant_id,args['tenant_id'])
        with self.assertRaises(PdfParseError):
            bind_passages(json.dumps({'tenant_id':'attacker','passages':[passage]}).encode(),**args)
        passage['page_end']=251
        with self.assertRaises(PdfParseError):
            bind_passages(json.dumps({'passages':[passage]}).encode(),**args)
    def test_runtime_cannot_fall_back_to_runc(self):
        with self.assertRaises(ValueError):
            ContainerPdfParser(image='parser@sha256:'+'a'*64,runtime='runc')

class HeadingPathRegressionTests(unittest.TestCase):
    def test_return_to_parent_emits_a_new_heading_block(self):
        args=dict(data=b'%PDF-test',tenant_id='11111111-1111-4111-8111-111111111111',document_id='22222222-2222-4222-8222-222222222222',document_version=1)
        passages=[dict(content='first',page_start=1,page_end=1,heading_path=['Storage','Wheat']),dict(content='second',page_start=2,page_end=2,heading_path=['Storage'])]
        result=bind_passages(json.dumps({'passages':passages}).encode(),**args)
        self.assertEqual([node.title for node in result.outline.roots],['Storage','Storage'])
        self.assertEqual(result.outline.roots[-1].chunk_ids,[result.chunks[-1].chunk_id])
