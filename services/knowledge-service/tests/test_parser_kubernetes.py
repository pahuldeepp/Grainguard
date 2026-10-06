import json
import sys
import subprocess
import unittest
from unittest.mock import patch
from knowledge_extensions.parser_kubernetes import KubernetesPdfParser
from knowledge_extensions.parser_sandbox import run_bounded
from knowledge_extensions.pdf_parser import PdfParseError

class KubernetesParserTests(unittest.TestCase):
    def setUp(self):
        self.parser=KubernetesPdfParser(image='parser@sha256:'+'a'*64)
        self.identity=dict(tenant_id='11111111-1111-4111-8111-111111111111',
                           document_id='22222222-2222-4222-8222-222222222222',document_version=1)

    def test_pod_has_no_identity_or_host_mounts(self):
        pod=self.parser.pod('gg-parser-test'); spec=pod['spec']
        self.assertEqual(pod['metadata']['namespace'],'greenguard-parser')
        self.assertFalse(spec['automountServiceAccountToken'])
        self.assertEqual(spec['runtimeClassName'],'greenguard-parser-runsc')
        self.assertNotIn('env',spec['containers'][0])
        self.assertTrue(spec['containers'][0]['securityContext']['readOnlyRootFilesystem'])
        self.assertEqual(spec['containers'][0]['securityContext']['capabilities']['drop'],['ALL'])
        self.assertEqual(list(spec['volumes'][0]),['name','emptyDir'])
        self.assertNotIn('tenant_id',json.dumps(pod))

    def test_streamed_output_bound_to_caller_and_deleted(self):
        passage=dict(content='Keep wheat dry.',page_start=1,page_end=1,heading_path=['Storage'])
        with patch('knowledge_extensions.parser_kubernetes.subprocess.run') as run, patch('knowledge_extensions.parser_kubernetes.run_bounded',return_value=json.dumps({'passages':[passage]}).encode()):
            result=self.parser.parse(b'%PDF-test',**self.identity)
        self.assertEqual(result.tenant_id,self.identity['tenant_id'])
        self.assertIn('delete',run.call_args.args[0])
        self.assertNotIn(self.identity['tenant_id'].encode(),run.call_args_list[0].kwargs['input'])

    def test_launch_failure_retryable_and_cleanup_attempted(self):
        with patch('knowledge_extensions.parser_kubernetes.subprocess.run',side_effect=subprocess.CalledProcessError(1,['kubectl'])) as run:
            with self.assertRaises(RuntimeError):
                self.parser.parse(b'%PDF-test',**self.identity)
        self.assertIn('delete',run.call_args.args[0])

    def test_bounded_stream_kills_overflow_and_timeout(self):
        with patch('knowledge_extensions.parser_sandbox.MAX_OUTPUT',32):
            with self.assertRaises(PdfParseError):
                run_bounded([sys.executable,'-c','import sys; sys.stdout.write("x"*100000)'],b'',2)
        with self.assertRaises(subprocess.TimeoutExpired):
            run_bounded([sys.executable,'-c','import time; time.sleep(5)'],b'',1)

    def test_rejects_namespace_escape_and_unpinned_image(self):
        with self.assertRaises(ValueError): KubernetesPdfParser(image='parser:latest')
        with self.assertRaises(ValueError): KubernetesPdfParser(image='parser@sha256:'+'a'*64,namespace='default')
