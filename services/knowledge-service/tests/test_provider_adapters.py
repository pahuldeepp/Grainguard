import json
import unittest
from unittest.mock import patch

from knowledge_extensions.model_gateway import ModelGatewayClient
from knowledge_extensions.vector_store import PineconeVectorStore, VectorHit, VectorRecord


class _Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit):
        return self.payload


class ProviderAdapterTests(unittest.TestCase):
    def test_pinecone_adapter_uses_namespace_and_minimal_metadata(self):
        responses = [
            {"upsertedCount": 1},
            {"matches": [{"id": "44444444-4444-4444-8444-444444444444",
                          "score": 0.9, "metadata": {"tenant_ref": "t_example",
                          "embedding_version": "model-v1", "tombstone": False}}]},
            {},
        ]
        seen = []

        def fake_urlopen(request, timeout):
            seen.append((request, timeout, json.loads(request.data)))
            return _Response(responses.pop(0))

        store = PineconeVectorStore(index_host="index.example.pinecone.io", api_key="test-key")
        metadata = {"doc_id": "33333333-3333-4333-8333-333333333333", "doc_version": 1,
                    "tenant_ref": "t_example", "trust": "tenant_uploaded", "acl_scope": "viewer",
                    "embedding_version": "model-v1", "tombstone": False}
        record = VectorRecord("44444444-4444-4444-8444-444444444444", (0.1, 0.2), metadata)
        with patch("knowledge_extensions.vector_store.urlopen", side_effect=fake_urlopen):
            store.upsert(namespace="t_example", records=[record])
            hits = store.search(namespace="t_example", vector=[0.1, 0.2], top_k=5)
            store.delete(namespace="t_example", chunk_ids=[record.chunk_id])
        self.assertEqual(len(hits), 1)
        self.assertIsInstance(hits[0], VectorHit)
        self.assertEqual(seen[0][0].full_url, "https://index.example.pinecone.io/vectors/upsert")
        self.assertEqual(seen[1][0].full_url, "https://index.example.pinecone.io/query")
        self.assertEqual(seen[2][0].full_url, "https://index.example.pinecone.io/vectors/delete")
        self.assertNotIn("text", seen[0][2]["vectors"][0]["metadata"])

    def test_pinecone_adapter_rejects_text_or_extra_metadata(self):
        store = PineconeVectorStore(index_host="index.example.pinecone.io", api_key="test-key")
        record = VectorRecord("44444444-4444-4444-8444-444444444444", (0.1,), {"text": "must not leave postgres"})
        with self.assertRaises(ValueError):
            store.upsert(namespace="t_example", records=[record])

    def test_model_gateway_client_validates_embeddings_reranking_and_citations(self):
        client = ModelGatewayClient(base_url="http://localhost", task_token="short-lived-token")
        responses = [
            {"data": [{"index": 0, "embedding": [0.1, 0.2]}]},
            {"results": [{"index": 1}, {"index": 0}]},
            {"answer": "Keep the grain dry.", "cited_chunk_ids": ["chunk-1"]},
        ]
        requests = []

        def fake_urlopen(request, timeout):
            requests.append((request.full_url, request.get_header("Authorization"), json.loads(request.data)))
            return _Response(responses.pop(0))

        with patch("knowledge_extensions.model_gateway.urlopen", side_effect=fake_urlopen):
            embeddings = client.embed(["one"], tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="embed-v1", input_type="query")
            order = client.rerank("query", ["one", "two"], tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="rerank-v1", top_n=2)
            answer = client.answer("question", [{"chunk_id": "chunk-1", "trust": "licensed", "text": "text", "document_id": "11111111-1111-4111-8111-111111111111", "document_version": 2, "page_start": 4, "page_end": 5}],
                                   tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="answer-v1")
        self.assertEqual(embeddings, [[0.1, 0.2]])
        self.assertEqual(order, [1, 0])
        self.assertEqual(answer["cited_chunk_ids"], ["chunk-1"])
        source = requests[2][2]["context"][0]
        self.assertEqual((source["document_version"], source["page_start"], source["page_end"]), (2, 4, 5))
        self.assertEqual([request[0] for request in requests], [
            "http://localhost/v1/embeddings", "http://localhost/v1/rerank",
            "http://localhost/v1/answers",
        ])
        self.assertTrue(all(request[1] == "Bearer short-lived-token" for request in requests))

class GatewayIdentityTests(unittest.TestCase):
    def test_default_and_summary_deadlines_are_bounded_and_do_not_extend_parent(self):
        from knowledge_extensions.model_gateway import verified_gateway_user, _deadline
        with patch("knowledge_extensions.model_gateway.time.monotonic", return_value=100):
            with verified_gateway_user(None):
                self.assertEqual(_deadline.get(), 120)
                with verified_gateway_user(None, deadline_seconds=280):
                    self.assertEqual(_deadline.get(), 120)
            self.assertIsNone(_deadline.get())
            with verified_gateway_user(None, deadline_seconds=280):
                self.assertEqual(_deadline.get(), 380)
            for bad in (True, 0, -1, 301, float("inf"), float("nan")):
                with self.subTest(deadline=bad), self.assertRaises(ValueError):
                    with verified_gateway_user(None, deadline_seconds=bad):
                        pass

    def test_service_selects_summary_or_normal_total_deadline(self):
        from contextlib import nullcontext
        from knowledge_extensions.model_gateway import _deadline
        from knowledge_extensions.service import KnowledgeRagService
        service = KnowledgeRagService(connect=lambda: nullcontext(object()), vector_store=None,
            model_gateway=None, namespace_key=b"k" * 32, embedding_model="embed-v1",
            reranker_model="rerank-v1", answer_model="answer-v1")
        tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        with patch("knowledge_extensions.model_gateway.time.monotonic", return_value=100), \
             patch("knowledge_extensions.service.retrieve_answer", side_effect=lambda *args, **kwargs: _deadline.get()), \
             patch("knowledge_extensions.document_summary.summarize_document", side_effect=lambda *args, **kwargs: _deadline.get()):
            self.assertEqual(service.ask(tenant_id=tenant, principal_id=None, principal_role="viewer", question="Storage?"), 120)
            self.assertEqual(service.ask(tenant_id=tenant, principal_id=None, principal_role="viewer", question="Summarize.",
                mode="document_summary", document_id=tenant, document_version=1), 380)
        self.assertIsNone(_deadline.get())

    def test_exhausted_summary_deadline_never_dispatches_another_provider_call(self):
        from knowledge_extensions.model_gateway import verified_gateway_user, ModelGatewayError
        client = ModelGatewayClient(base_url="http://localhost", task_token="workload", timeout_seconds=30)
        with patch("knowledge_extensions.model_gateway.time.monotonic", side_effect=[100, 381]), \
             patch("knowledge_extensions.model_gateway.urlopen") as transport:
            with verified_gateway_user(None, deadline_seconds=280):
                with self.assertRaises(ModelGatewayError):
                    client.embed(["one"], tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="embed-v1", input_type="query")
            transport.assert_not_called()

    def test_summary_deadline_keeps_per_call_timeout(self):
        from knowledge_extensions.model_gateway import verified_gateway_user
        client = ModelGatewayClient(base_url="http://localhost", task_token="workload", timeout_seconds=30)
        with patch("knowledge_extensions.model_gateway.time.monotonic", return_value=100), \
             patch("knowledge_extensions.model_gateway.urlopen", return_value=_Response({"data": [{"index": 0, "embedding": [0.1]}]})) as transport:
            with verified_gateway_user(None, deadline_seconds=280):
                client.embed(["one"], tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="embed-v1", input_type="query")
            self.assertEqual(transport.call_args.kwargs["timeout"], 30)
            self.assertEqual(transport.call_args.args[0].get_header("X-ai-timeout-ms"), "30000")

    def test_summary_call_timeout_override_is_bounded_and_resets(self):
        from knowledge_extensions.model_gateway import verified_gateway_user, _call_timeout
        client = ModelGatewayClient(base_url="http://localhost", task_token="workload")
        with patch("knowledge_extensions.model_gateway.time.monotonic", return_value=100), \
             patch("knowledge_extensions.model_gateway.urlopen", return_value=_Response({"data": [{"index": 0, "embedding": [0.1]}]})) as transport:
            with verified_gateway_user(None, deadline_seconds=280, call_timeout_seconds=35):
                client.embed(["one"], tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="embed-v1", input_type="query")
            self.assertEqual(transport.call_args.kwargs["timeout"], 35)
            self.assertEqual(transport.call_args.args[0].get_header("X-ai-timeout-ms"), "35000")
        self.assertIsNone(_call_timeout.get())
        for invalid in (0, 121, True, float("nan")):
            with self.assertRaises(ValueError):
                with verified_gateway_user(None, call_timeout_seconds=invalid):
                    pass

    def test_verified_user_context_is_scoped_and_deadline_propagates(self):
        from knowledge_extensions.model_gateway import verified_gateway_user
        client = ModelGatewayClient(base_url="http://localhost", task_token="workload")
        requests = []
        def fake(request, timeout):
            requests.append((request, timeout))
            return _Response({"data": [{"index": 0, "embedding": [0.1]}]})
        user = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        with patch("knowledge_extensions.model_gateway.urlopen", side_effect=fake):
            with verified_gateway_user(user):
                client.embed(["one"], tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="embed-v1", input_type="query")
            client.embed(["two"], tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="embed-v1", input_type="passage")
        self.assertEqual(requests[0][0].get_header("X-ai-principal-id"), user)
        self.assertGreater(int(requests[0][0].get_header("X-ai-timeout-ms")), 0)
        self.assertIsNone(requests[1][0].get_header("X-ai-principal-id"))

    def test_provider_rate_denial_keeps_safe_origin_code(self):
        import io
        from urllib.error import HTTPError
        from knowledge_extensions.model_gateway import ModelGatewayError
        client = ModelGatewayClient(base_url="http://localhost", task_token="workload")
        for upstream, expected in (("provider_rate_limited", "provider_rate_limited"),
                                   ("provider_rate_or_concurrency_limited", "provider_rate_limited"),
                                   ("ai_rate_or_concurrency_limited", "ai_rate_limited"),
                                   ("private arbitrary upstream detail", "ai_rate_limited")):
            error = HTTPError("http://localhost", 429, "secret detail", {"Retry-After": "60"},
                              io.BytesIO(json.dumps({"error": upstream}).encode()))
            with patch("knowledge_extensions.model_gateway.urlopen", side_effect=error):
                with self.assertRaises(ModelGatewayError) as result:
                    client.embed(["one"], tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="embed-v1", input_type="query")
            self.assertEqual(result.exception.code, expected)
            self.assertEqual(result.exception.retry_after, 60)

    def test_gateway_rate_denial_is_sanitized_and_preserved(self):
        from urllib.error import HTTPError
        from knowledge_extensions.model_gateway import ModelGatewayError
        client = ModelGatewayClient(base_url="http://localhost", task_token="workload")
        with patch("knowledge_extensions.model_gateway.urlopen", side_effect=HTTPError("http://localhost", 429, "secret provider detail", {"Retry-After": "7"}, None)):
            with self.assertRaises(ModelGatewayError) as result:
                client.embed(["one"], tenant_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model="embed-v1", input_type="query")
        self.assertEqual(result.exception.status, 429)
        self.assertEqual(result.exception.retry_after, 7)
        self.assertNotIn("secret", str(result.exception))




class RedirectPolicyTests(unittest.TestCase):
    def test_provider_and_gateway_share_no_redirect_policy(self):
        from knowledge_extensions.http_transport import NoRedirect, urlopen
        from knowledge_extensions import model_gateway, vector_store
        from urllib.error import URLError
        self.assertIs(model_gateway.urlopen, urlopen)
        self.assertIs(vector_store.urlopen, urlopen)
        with self.assertRaises(URLError):
            NoRedirect().redirect_request(None,None,302,'redirect',{},'https://other.example')

class GatewayPolicyResponseTests(unittest.TestCase):
    def test_sanitized_policy_response_is_permanent_not_provider_outage(self):
        import io
        from urllib.error import HTTPError
        from knowledge_extensions.prompt_guardrails import PromptInjectionError
        client=ModelGatewayClient(base_url='http://127.0.0.1:18089',task_token='synthetic-token')
        error=HTTPError('http://localhost',422,'blocked',{},io.BytesIO(b'{"error":"prompt_injection_blocked"}'))
        with patch('knowledge_extensions.model_gateway.urlopen',side_effect=error):
            with self.assertRaises(PromptInjectionError):
                client.embed(['synthetic'],tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',model='embed-v1',input_type='passage')


if __name__ == "__main__":
    unittest.main()
