import unittest
from knowledge_extensions.model_gateway import ModelGatewayClient


class MeshGatewayTests(unittest.TestCase):
    def test_exact_mesh_origin_requires_explicit_opt_in(self):
        url = 'http://model-gateway.greenguard.svc.cluster.local:8080'
        with self.assertRaises(ValueError):
            ModelGatewayClient(base_url=url, task_token='internal-test-token')
        self.assertEqual(ModelGatewayClient(base_url=url, task_token='internal-test-token',
                         allow_mesh_http=True)._base_url, url)

    def test_mesh_opt_in_never_allows_other_http_origins_or_selectors(self):
        for url in ('http://model-gateway.other.svc.cluster.local:8080',
                    'http://model-gateway.greenguard.svc.cluster.local:8081',
                    'http://model-gateway.greenguard.svc.cluster.local:8080/other',
                    'http://model-gateway.greenguard.svc.cluster.local:8080?secret=1',
                    'http://user@model-gateway.greenguard.svc.cluster.local:8080',
                    'http://external.example:8080'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                ModelGatewayClient(base_url=url, task_token='internal-test-token', allow_mesh_http=True)
        with self.assertRaises(ValueError):
            ModelGatewayClient(base_url='http://model-gateway.greenguard.svc.cluster.local:8080',
                               task_token='internal-test-token', allow_mesh_http='true')
