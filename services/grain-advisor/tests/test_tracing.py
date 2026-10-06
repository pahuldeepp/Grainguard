import http.client
import json
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

from opentelemetry.trace import SpanKind
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from advisor_security.http_api import create_server
from advisor_security.owner_http import bounded_get
from advisor_security.policy import Principal
from advisor_security.tracing import AdvisorTracing, set_default_tracing
from agent_workflow import WorkflowDependencies, build_workflow, start
from langgraph.checkpoint.memory import InMemorySaver


PARENT = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"


class SpanCaptureTests(unittest.TestCase):
    def setUp(self):
        self.exporter = InMemorySpanExporter()
        self.tracing = AdvisorTracing(exporter=self.exporter)
        self.original = __import__("advisor_security.tracing", fromlist=["default_tracing"]).default_tracing()
        set_default_tracing(self.tracing)

    def tearDown(self):
        set_default_tracing(self.original)
        self.tracing.shutdown()

    def spans(self):
        self.tracing.provider.force_flush(timeout_millis=3000)
        return self.exporter.get_finished_spans()

    def test_http_server_span_extracts_valid_parent_and_records_only_safe_attributes(self):
        class Verifier:
            def verify(self, *_args):
                raise AssertionError("readiness must not authenticate")

        server = create_server(connect=lambda: None, verifier=lambda _scope: Verifier(),
                               authorize_alert=lambda *_: False,
                               healthcheck=lambda: True, tracing=self.tracing)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            connection.request("GET", "/readyz", headers={
                "traceparent": PARENT,
                "tracestate": "vendor=private",
                "baggage": "tenant=must-not-propagate",
            })
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
            connection.close()
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

        spans = self.spans()
        self.assertEqual(len(spans), 1)
        span = spans[0]
        self.assertEqual(span.name, "Advisor.http.get_readiness")
        self.assertEqual(span.parent.span_id, int("0123456789abcdef", 16))
        self.assertEqual(span.attributes["http.response.status_code"], 200)
        self.assertEqual(span.attributes["greenguard.outcome"], "success")
        self.assertEqual(set(span.attributes), {"http.response.status_code", "greenguard.outcome"})

    def test_owner_client_span_propagates_child_traceparent_without_baggage_or_url(self):
        captured = []

        class Owner(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                captured.append((self.headers.get("traceparent"), self.headers.get("baggage")))
                self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")

        owner = ThreadingHTTPServer(("127.0.0.1", 0), Owner)
        thread = threading.Thread(target=owner.serve_forever, daemon=True); thread.start()
        try:
            parent_context = self.tracing.extract(PARENT)
            with self.tracing.span("Advisor.http.get_readiness", parent=parent_context, kind=SpanKind.SERVER):
                status, body = bounded_get(f"http://127.0.0.1:{owner.server_port}/private-path?token=never-record",
                                          "owner-secret", operation="Advisor.owner.membership")
            self.assertEqual((status, body), (200, b"{}"))
        finally:
            owner.shutdown(); owner.server_close(); thread.join(timeout=2)

        self.assertEqual(len(captured), 1)
        child_header, baggage = captured[0]
        self.assertIsNotNone(child_header)
        self.assertIsNone(baggage)
        self.assertEqual(child_header.split("-")[1], PARENT.split("-")[1])
        spans = {span.name: span for span in self.spans()}
        self.assertEqual(set(spans), {"Advisor.http.get_readiness", "Advisor.owner.membership"})
        self.assertEqual(spans["Advisor.owner.membership"].parent.span_id,
                         spans["Advisor.http.get_readiness"].context.span_id)
        client = spans["Advisor.owner.membership"]
        self.assertEqual(client.attributes["http.response.status_code"], 200)
        self.assertEqual(set(client.attributes), {"http.response.status_code", "greenguard.outcome"})

    def test_workflow_nodes_are_correlated_and_do_not_record_state(self):
        tenant, user, run_id, alert = (str(uuid4()) for _ in range(4))
        principal = Principal(tenant, user, "operator", "grain-advisor",
                              datetime.now(timezone.utc) + timedelta(minutes=5))
        proposal = {"proposal_id": str(uuid4()), "action_hash": "a" * 64,
                    "status": "pending", "version": 1,
                    "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
                    "action": {"action": "acknowledge_alert", "target": alert,
                               "params": {"note": "private prompt text"},
                               "preconditions": {"etag": '"1"'}}}
        dependencies = WorkflowDependencies(
            db=lambda: None,
            planner=lambda *_: {"tool": "propose_acknowledge_alert", "args": {"alert_id": alert}},
            mcp_call=lambda *_: proposal,
            token_provider=lambda *_: "Bearer never-record-token",
            execute_action=lambda *_: {"status": 200},
        )
        graph = build_workflow(dependencies, checkpointer=InMemorySaver(), tracing=self.tracing)
        with self.tracing.span("Advisor.http.get_proposals", parent=self.tracing.extract(PARENT)):
            result = start(graph, principal, run_id, "private question")
        self.assertIn("__interrupt__", result)
        spans = self.spans()
        node_spans = [span for span in spans if span.name.startswith("Advisor.workflow.")]
        self.assertEqual({span.name for span in node_spans},
                         {"Advisor.workflow.plan", "Advisor.workflow.owner_tool"})
        parent_ids = {span.context.trace_id for span in spans}
        self.assertEqual(len(parent_ids), 1)
        for span in spans:
            self.assertNotIn("private", repr(dict(span.attributes)))
            self.assertNotIn(tenant, repr(dict(span.attributes)))
            self.assertNotIn(user, repr(dict(span.attributes)))
            self.assertNotIn("never-record-token", repr(dict(span.attributes)))


if __name__ == "__main__":
    unittest.main()
