from contextlib import nullcontext
from dataclasses import dataclass
from hashlib import sha256
import json
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from knowledge_extensions.http_api import ApiPrincipal, create_server
from knowledge_extensions.model_gateway import ModelGatewayError

TENANT = "11111111-1111-4111-8111-111111111111"
USER = "22222222-2222-4222-8222-222222222222"
CONVERSATION = "33333333-3333-4333-8333-333333333333"
MESSAGE_USER = "44444444-4444-4444-8444-444444444444"
MESSAGE_ASSISTANT = "55555555-5555-4555-8555-555555555555"
TOKEN = "assistant-history-token"


@dataclass
class Answer:
    answer: str
    citations: tuple[dict, ...]
    retrieval: dict


class FakeService:
    def __init__(self):
        self.calls = []
        self._connect = lambda: nullcontext(object())

    def ask(self, **kwargs):
        self.calls.append(kwargs)
        return Answer("Keep the grain dry.", (), {"fts": 1})


class ConversationHttpApiTests(unittest.TestCase):
    def setUp(self):
        self.service = FakeService()
        self.bindings = {sha256(TOKEN.encode()).hexdigest(): ApiPrincipal(TENANT, USER, "viewer")}
        self.server = create_server(
            service=self.service,
            access_bindings=self.bindings,
            host="127.0.0.1", port=0,
        )
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def call(self, method, path, body=None):
        headers = {"Authorization": f"Bearer {TOKEN}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=3) as response:
                payload = response.read()
                return response.status, json.loads(payload) if payload else None
        except HTTPError as response:
            try:
                payload = response.read()
                return response.code, json.loads(payload) if payload else None
            finally:
                response.close()

    def test_complete_pdf_summary_scope_reaches_query_and_owned_conversation(self):
        scope = {"question": "Summarize each section.", "mode": "document_summary",
                 "document_id": MESSAGE_USER, "document_version": 2}
        status, _ = self.call("POST", "/v1/query", scope)
        self.assertEqual(status, 200)
        self.assertEqual(self.service.calls[-1]["document_id"], MESSAGE_USER)
        with patch("knowledge_extensions.conversation_store.conversation_exists", return_value=True), \
             patch("knowledge_extensions.conversation_store.append_turn", return_value={
                 "user_message_id": MESSAGE_USER, "assistant_message_id": MESSAGE_ASSISTANT}):
            status, _ = self.call("POST", f"/v1/assistant/conversations/{CONVERSATION}/messages", scope)
            self.assertEqual(status, 200)
        self.assertEqual(self.service.calls[-1]["mode"], "document_summary")
        self.assertEqual(self.service.calls[-1]["document_version"], 2)

    def test_invalid_summary_scope_never_calls_model(self):
        invalid = [
            {"mode": "document_summary"},
            {"mode": "document_summary", "document_id": MESSAGE_USER, "document_version": True},
            {"mode": "document_summary", "document_id": MESSAGE_USER, "document_version": 2147483648},
            {"mode": []}, {"document_id": MESSAGE_USER},
            {"mode": "document_summary", "document_id": "invalid", "document_version": 1},
        ]
        for scope in invalid:
            with self.subTest(scope=scope):
                self.assertEqual(self.call("POST", "/v1/query", {"question": "Summarize PDF."} | scope)[0], 400)
        self.assertEqual(self.service.calls, [])

    def test_summary_failure_is_explicit_and_does_not_save_turn(self):
        from knowledge_extensions.document_summary import DocumentSummaryError
        with patch("knowledge_extensions.conversation_store.conversation_exists", return_value=True), \
             patch.object(self.service, "ask", side_effect=DocumentSummaryError("document_summary_incomplete")), \
             patch("knowledge_extensions.conversation_store.append_turn") as append:
            status, body = self.call("POST", f"/v1/assistant/conversations/{CONVERSATION}/messages", {
                "question": "Summarize PDF.", "mode": "document_summary",
                "document_id": MESSAGE_USER, "document_version": 1})
            self.assertEqual((status, body), (422, {"error": "document_summary_incomplete"}))
            append.assert_not_called()

    def test_provider_throttle_keeps_safe_code_and_does_not_save_turn(self):
        error = ModelGatewayError("provider request failed", status=429, retry_after=60, code="provider_rate_limited")
        with patch("knowledge_extensions.conversation_store.conversation_exists", return_value=True), \
             patch.object(self.service, "ask", side_effect=error), \
             patch("knowledge_extensions.conversation_store.append_turn") as append:
            status, body = self.call("POST", f"/v1/assistant/conversations/{CONVERSATION}/messages", {"question": "Storage?"})
            self.assertEqual(status, 429)
            self.assertEqual(body, {"error": "provider_rate_limited"})
            append.assert_not_called()

    def test_valid_long_first_question_can_create_conversation(self):
        summary = {"conversation_id":CONVERSATION, "title":"Long question", "updated_at":"now", "last_message_at":"now"}
        with patch("knowledge_extensions.conversation_store.create_conversation", return_value=summary) as create:
            question = "How should grain be stored? " * 65
            status, body = self.call("POST", "/v1/assistant/conversations", {"title":question})
            self.assertEqual(status,201)
            self.assertEqual(create.call_args.kwargs["title"],question)

    def test_list_create_open_send_and_delete_are_owner_scoped(self):
        summary = {"conversation_id": CONVERSATION, "title": "Dry grain", "updated_at": "2026-10-02T12:00:00+00:00", "last_message_at": "2026-10-02T12:00:00+00:00"}
        message = {"message_id": MESSAGE_USER, "role": "user", "content": "How should grain be stored?", "created_at": "2026-10-02T12:00:00+00:00", "citations": []}
        detail = {**summary, "messages": [message]}
        with patch("knowledge_extensions.conversation_store.list_conversations", return_value=[summary]) as list_rows, \
             patch("knowledge_extensions.conversation_store.create_conversation", return_value=summary) as create_row, \
             patch("knowledge_extensions.conversation_store.get_conversation", return_value=detail) as get_row, \
             patch("knowledge_extensions.conversation_store.conversation_exists", return_value=True) as exists_row, \
             patch("knowledge_extensions.conversation_store.append_turn", return_value={"user_message_id": MESSAGE_USER, "assistant_message_id": MESSAGE_ASSISTANT}) as append_row, \
             patch("knowledge_extensions.conversation_store.soft_delete_conversation", return_value=True) as delete_row:
            status, body = self.call("GET", "/v1/assistant/conversations")
            self.assertEqual(status, 200)
            self.assertEqual(body["items"][0]["id"], CONVERSATION)
            self.assertEqual(list_rows.call_args.kwargs["tenant_id"], TENANT)
            self.assertEqual(list_rows.call_args.kwargs["principal_id"], USER)

            status, created = self.call("POST", "/v1/assistant/conversations", {})
            self.assertEqual(status, 201)
            self.assertEqual(created["id"], CONVERSATION)
            self.assertEqual(create_row.call_args.kwargs["tenant_id"], TENANT)
            self.assertEqual(create_row.call_args.kwargs["principal_id"], USER)

            status, titled = self.call("POST", "/v1/assistant/conversations", {"title": "How should grain be stored?"})
            self.assertEqual(status, 201)
            self.assertEqual(create_row.call_args.kwargs["title"], "How should grain be stored?")
            self.assertEqual(titled["title"], "Dry grain")
            self.assertEqual(self.call("POST", "/v1/assistant/conversations", {"title": " "})[0], 400)
            self.assertEqual(self.call("POST", "/v1/assistant/conversations", {"title": "Question", "tenant_id": TENANT})[0], 400)

            status, opened = self.call("GET", f"/v1/assistant/conversations/{CONVERSATION}")
            self.assertEqual(status, 200)
            self.assertEqual(opened["conversation"]["id"], CONVERSATION)
            self.assertEqual(opened["messages"][0]["id"], MESSAGE_USER)
            self.assertEqual(get_row.call_args.kwargs["principal_id"], USER)

            status, sent = self.call("POST", f"/v1/assistant/conversations/{CONVERSATION}/messages", {"question": "How should grain be stored?"})
            self.assertEqual(status, 200)
            self.assertEqual(sent["user_message"]["id"], MESSAGE_USER)
            self.assertEqual(sent["assistant_message"]["id"], MESSAGE_ASSISTANT)
            self.assertEqual(self.service.calls[-1]["tenant_id"], TENANT)
            self.assertEqual(self.service.calls[-1]["principal_id"], USER)
            self.assertEqual(append_row.call_args.kwargs["question"], "How should grain be stored?")
            self.assertEqual(append_row.call_args.kwargs["answer"], "Keep the grain dry.")
            self.assertEqual(exists_row.call_args.kwargs["principal_id"], USER)

            status, deleted = self.call("DELETE", f"/v1/assistant/conversations/{CONVERSATION}")
            self.assertEqual(status, 200)
            self.assertTrue(deleted["deleted"])
            self.assertEqual(delete_row.call_args.kwargs["tenant_id"], TENANT)
            self.assertEqual(delete_row.call_args.kwargs["principal_id"], USER)

    def test_conversation_rag_telemetry_is_bounded_private_and_tenant_scoped(self):
        # Operations endpoints require an operator, independently of chat ownership.
        citation = {"document_id": CONVERSATION, "chunk_id": MESSAGE_USER,
                    "document_version": 1, "page_start": 1, "page_end": 2,
                    "text": "secret source text"}
        answer = Answer("secret answer text", (citation,), {"fts": 2, "prompt": "secret prompt", "dense": "secret"})
        with patch("knowledge_extensions.conversation_store.conversation_exists", return_value=True), \
             patch("knowledge_extensions.conversation_store.append_turn", return_value={"user_message_id": MESSAGE_USER, "assistant_message_id": MESSAGE_ASSISTANT}), \
             patch.object(self.service, "ask", return_value=answer):
            status, _ = self.call("POST", f"/v1/assistant/conversations/{CONVERSATION}/messages", {"question": "private farm question"})
        self.assertEqual(status, 200)
        rows = list(self.server._ops_queries)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["tenant_id"], TENANT)
        self.assertEqual(rows[0]["status"], "ok")
        self.assertEqual(rows[0]["retrieval"], {"fts": 2})
        self.assertEqual(rows[0]["citations"], [])
        self.assertEqual(rows[0]["citation_count"], 1)
        serialized = json.dumps(rows)
        for secret in ("secret source text", "secret answer text", "secret prompt", "private farm question", CONVERSATION, MESSAGE_USER):
            self.assertNotIn(secret, serialized)
        self.assertEqual(self.server._ops_queries.maxlen, 5000)
        self.bindings[sha256(TOKEN.encode()).hexdigest()] = ApiPrincipal(TENANT, USER, "operator")
        self.assertEqual(self.call("GET", "/v1/ops/traces")[1]["items"][0]["retrieval"], {"fts": 2})
        self.bindings[sha256(TOKEN.encode()).hexdigest()] = ApiPrincipal("66666666-6666-4666-8666-666666666666", USER, "operator")
        self.assertEqual(self.call("GET", "/v1/ops/traces")[1]["items"], [])

    def test_failed_conversation_rag_records_failure_without_exception_text(self):
        with patch("knowledge_extensions.conversation_store.conversation_exists", return_value=True), \
             patch.object(self.service, "ask", side_effect=RuntimeError("secret provider failure")):
            status, _ = self.call("POST", f"/v1/assistant/conversations/{CONVERSATION}/messages", {"question": "private farm question"})
        self.assertEqual(status, 503)
        row = self.server._ops_queries[-1]
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["tenant_id"], TENANT)
        self.assertGreaterEqual(row["latency_ms"], 0)
        self.assertNotIn("secret provider failure", json.dumps(row))

    def test_unauthenticated_and_unowned_conversations_are_not_disclosed(self):
        request = Request(self.base + f"/v1/assistant/conversations/{CONVERSATION}", method="GET")
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=3)
        self.assertEqual(caught.exception.code, 401)
        caught.exception.close()
        with patch("knowledge_extensions.conversation_store.get_conversation", return_value=None):
            self.assertEqual(self.call("GET", f"/v1/assistant/conversations/{CONVERSATION}")[0], 404)
        self.assertEqual(self.call("POST", f"/v1/assistant/conversations/{CONVERSATION}/messages", {"question": "How should grain be stored?", "tenant_id": "attacker"})[0], 400)


if __name__ == "__main__":
    unittest.main()
