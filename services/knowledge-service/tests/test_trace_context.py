import unittest
from knowledge_extensions.trace_context import incoming_trace_context, outbound_trace_headers, validated_traceparent

class TraceContextTests(unittest.TestCase):
    def test_validated_scoped_propagation(self):
        value='00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
        class Handler:
            headers={'traceparent': value}
            @incoming_trace_context
            def run(self):
                return outbound_trace_headers()
        self.assertEqual(Handler().run(),{'traceparent':value})
        self.assertEqual(outbound_trace_headers(),{})
        for invalid in ['', '00-'+'0'*32+'-0123456789abcdef-01',value+'\n',value.replace('-0123456789abcdef-','-'+'0'*16+'-')]:
            self.assertIsNone(validated_traceparent(invalid))

    def test_gateway_http_client_forwards_scoped_trace_without_baggage(self):
        from unittest.mock import patch
        from knowledge_extensions.model_gateway import ModelGatewayClient
        import io
        value='00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
        client=ModelGatewayClient(base_url='http://127.0.0.1:18089',task_token='local-token')
        observed=[]
        def transport(request,timeout):
            observed.append(dict(request.header_items()))
            return io.BytesIO(b'{}')
        class Handler:
            headers={'traceparent':value,'baggage':'tenant=private'}
            @incoming_trace_context
            def run(self):
                return client._post('/v1/embeddings',{},tenant_id='local')
        with patch('knowledge_extensions.model_gateway.urlopen',transport):
            Handler().run()
            client._post('/v1/embeddings',{},tenant_id='local')
        self.assertEqual(observed[0].get('Traceparent'),value)
        self.assertNotIn('Baggage',observed[0])
        self.assertNotIn('Traceparent',observed[1])
