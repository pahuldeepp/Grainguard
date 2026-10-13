import unittest
from unittest.mock import patch
from local_indexer import validate_config,LocalSyntheticParser

class LocalProfileTests(unittest.TestCase):
    def env(self):
        return dict(KNOWLEDGE_ENVIRONMENT='local-synthetic',KNOWLEDGE_DATABASE_URL='postgresql://app@127.0.0.1/greenguard_knowledge',
            KNOWLEDGE_S3_ENDPOINT='http://127.0.0.1:19000',KNOWLEDGE_MODEL_GATEWAY_URL='http://localhost:18089',
            KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS='127.0.0.1:59092',KNOWLEDGE_LOCAL_PARSER_IMAGE_ID='sha256:'+'a'*64)
    def test_profile_only_accepts_explicit_local_synthetic_infrastructure(self):validate_config(self.env())
    def test_production_remote_or_mutable_configuration_is_denied(self):
        for key,value in (('KNOWLEDGE_ENVIRONMENT','production'),('KNOWLEDGE_DATABASE_URL','postgresql://app@remote/greenguard_knowledge'),
            ('KNOWLEDGE_S3_ENDPOINT','https://cloud.example'),('KNOWLEDGE_MODEL_GATEWAY_URL','http://admin:secret@localhost:18089'),
            ('KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS','cloud:9092'),('KNOWLEDGE_LOCAL_PARSER_IMAGE_ID','parser:latest')):
            with self.subTest(key=key),self.assertRaises(ValueError):validate_config({**self.env(),key:value})
    def test_parser_is_nonroot_network_free_bounded_no_mount_or_credentials(self):
        parser=LocalSyntheticParser('sha256:'+'a'*64)
        with patch('local_indexer.run_bounded',return_value=b'{}') as run,patch('local_indexer.bind_passages',return_value='parsed'),patch('local_indexer.subprocess.run'):
            self.assertEqual(parser.parse(b'%PDF-1.4\n',tenant_id='tenant',document_id='document',document_version=1),'parsed')
        command,data,timeout=run.call_args.args
        self.assertIn('--network=none',command);self.assertIn('--read-only',command);self.assertIn('--cap-drop=ALL',command)
        self.assertIn('--user=10001:10001',command)
        self.assertNotIn('--privileged',command);self.assertNotIn('--volume',command);self.assertNotIn('--runtime=runsc',command)
        self.assertEqual(timeout,120)
        self.assertNotIn('tenant',command);self.assertNotIn('document',command)
