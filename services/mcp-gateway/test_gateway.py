import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from gateway import (
    BASE_AUDIENCE,
    BASE_ACTOR,
    DelegationVerifier,
    GatewayError,
    OwnerClients,
    ToolDispatcher,
    create_server,
    owner_request,
    tool_definitions,
    validate_arguments,
)
from owner_worker import _reject_json_constant


TENANT = "11111111-1111-4111-8111-111111111111"
USER = "22222222-2222-4222-8222-222222222222"
DEVICE = "33333333-3333-4333-8333-333333333333"
ALERT = "44444444-4444-4444-8444-444444444444"
RUN = "55555555-5555-4555-8555-555555555555"
ISSUER = "https://delegation.example.test"
KID = "test-key"


class FakeMembership:
    def __init__(self, roles=("viewer", "operator")):
        self.current_roles = list(roles)
        self.calls = 0

    def roles(self, claims):
        self.calls += 1
        return self.current_roles


class FakeOwners:
    """Injected owner adapters record real dispatch contracts without fake data."""

    def __init__(self):
        self.calls = []

    def request(self, owner, path, token, tenant, method="GET", body=None, *, headers=None):
        self.calls.append((owner, path, token, tenant, method, body, headers or {}))
        # The gateway should pass through only the owner's actual response.
        return {"owner": owner, "path": path}, {"etag": '"17"'}, 200


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.public = cls.private.public_key()
        cls.jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(cls.public))
        cls.jwk.update(kid=KID, alg="RS256", use="sig")

    def setUp(self):
        self.now = int(time.time())
        self.verifier = DelegationVerifier(
            ISSUER,
            "https://delegation.example.test/.well-known/jwks.json",
            fetch_jwks=lambda: {"keys": [self.jwk]},
        )
        self.membership = FakeMembership()
        self.owners = FakeOwners()
        self.dispatcher = ToolDispatcher(self.owners)
        self.is_ready = True
        self.server = create_server(
            verifier=self.verifier,
            membership=self.membership,
            dispatcher=self.dispatcher,
            host="127.0.0.1",
            port=0,
            readiness=lambda: self.is_ready,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/mcp"

    def test_owner_worker_rejects_nonstandard_json_constants(self):
        for value in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                json.loads('{"value":' + value + '}', parse_constant=_reject_json_constant)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def token(self, audience, scope, actor, *, tenant=TENANT, sub=USER, roles=None,
              exp=None, issuer=ISSUER):
        issued = self.now
        claims = {
            "iss": issuer,
            "aud": audience,
            "sub": sub,
            "exp": exp or issued + 120,
            "iat": issued,
            "nbf": issued,
            "jti": str(uuid4()),
            "tenant_id": tenant,
            "roles": roles or ["viewer", "operator"],
            "act": {"sub": actor},
            "scope": scope,
            "token_use": "delegated",
        }
        return jwt.encode(claims, self.private, algorithm="RS256", headers={"typ": "at+jwt", "kid": KID})

    def post(self, tool, args, *, base_scope="tools:read", base_token=None, owner_tokens=None):
        base = base_token or self.token(BASE_AUDIENCE, base_scope, BASE_ACTOR)
        owner_tokens = owner_tokens or {}
        payload = {"jsonrpc": "2.0", "id": "call-1", "method": "tools/call",
                   "params": {"name": tool, "arguments": args}}
        request = Request(self.url, data=json.dumps(payload).encode(), method="POST", headers={
            "Authorization": "Bearer " + base,
            "Content-Type": "application/json",
            "X-GG-Owner-Delegations": json.dumps(owner_tokens),
        })
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as exc:
            response = exc
        return response.code, json.loads(response.read())

    def owner_token(self, name, *, tenant=TENANT, sub=USER, roles=None, exp=None):
        mapping = {
            "knowledge": ("knowledge-service", "knowledge:read"),
            "read": ("read-api", "telemetry:read"),
            "alerts_read": ("workflow-alerts", "alerts:read"),
            "advisor_propose": ("grain-advisor", "advisor:propose"),
        }
        audience, scope = mapping[name]
        return self.token(audience, scope, "greenguard-mcp", tenant=tenant, sub=sub, roles=roles, exp=exp)

    def call_with(self, tool, args, owner, *, base_scope="tools:read", **kwargs):
        return self.post(tool, args, base_scope=base_scope,
                         owner_tokens={owner: self.owner_token(owner, **kwargs)})

    def test_unknown_kid_refresh_is_rate_limited_but_expired_cache_refreshes(self):
        clock = [100]
        calls = []
        verifier = DelegationVerifier(ISSUER, "https://delegation.example.test/jwks",
            fetch_jwks=lambda: (calls.append(clock[0]) or {"keys": [self.jwk]}), now=lambda: clock[0])
        verifier.verify(self.token(BASE_AUDIENCE, "tools:read", BASE_ACTOR), audience=BASE_AUDIENCE, scope="tools:read", actor=BASE_ACTOR)
        self.assertEqual(1, len(calls))
        unknown = jwt.encode({"iss": ISSUER, "aud": BASE_AUDIENCE, "sub": USER, "exp": 200,
            "iat": 100, "nbf": 100, "jti": str(uuid4()), "tenant_id": TENANT,
            "roles": ["viewer"], "act": {"sub": BASE_ACTOR}, "scope": "tools:read",
            "token_use": "delegated"}, self.private, algorithm="RS256",
            headers={"typ": "at+jwt", "kid": "rotated-key"})
        for _ in range(8):
            with self.assertRaises(GatewayError):
                verifier.verify(unknown, audience=BASE_AUDIENCE, scope="tools:read", actor=BASE_ACTOR)
        self.assertEqual(2, len(calls))
        clock[0] += 5
        with self.assertRaises(GatewayError):
            verifier.verify(unknown, audience=BASE_AUDIENCE, scope="tools:read", actor=BASE_ACTOR)
        self.assertEqual(3, len(calls))
        clock[0] = verifier._expires
        verifier.verify(self.token(BASE_AUDIENCE, "tools:read", BASE_ACTOR), audience=BASE_AUDIENCE, scope="tools:read", actor=BASE_ACTOR)
        self.assertEqual(4, len(calls))

    def test_known_keys_survive_failed_refresh_only_within_bounded_grace(self):
        clock = [100]
        healthy = [True]

        def fetch():
            if not healthy[0]:
                raise OSError("JWKS endpoint unavailable")
            return {"keys": [self.jwk]}

        verifier = DelegationVerifier(ISSUER, "https://delegation.example.test/jwks",
                                      fetch_jwks=fetch, now=lambda: clock[0])
        self.assertTrue(verifier.ready())
        healthy[0] = False
        clock[0] = verifier._expires
        self.assertTrue(verifier.ready())
        clock[0] = verifier._expires + verifier._stale_grace_seconds
        self.assertTrue(verifier.ready())
        clock[0] += 1
        self.assertFalse(verifier.ready())

    def test_jwks_fetch_does_not_hold_key_cache_lock(self):
        entered = threading.Event()
        release = threading.Event()

        def fetch():
            entered.set()
            self.assertTrue(release.wait(timeout=2))
            return {"keys": [self.jwk]}

        verifier = DelegationVerifier(ISSUER, "https://delegation.example.test/jwks",
                                      fetch_jwks=fetch, now=lambda: 100)
        worker = threading.Thread(target=verifier._refresh)
        worker.start()
        self.assertTrue(entered.wait(timeout=2))
        acquired = verifier._lock.acquire(timeout=0.2)
        if acquired:
            verifier._lock.release()
        release.set()
        worker.join(timeout=2)
        self.assertTrue(acquired)
        self.assertFalse(worker.is_alive())

    def test_known_token_does_not_wait_for_refresh_during_last_good_grace(self):
        entered = threading.Event()
        release = threading.Event()
        slow = [False]

        def fetch():
            if slow[0]:
                entered.set()
                self.assertTrue(release.wait(timeout=2))
            return {"keys": [self.jwk]}

        verifier = DelegationVerifier(ISSUER, "https://delegation.example.test/jwks", fetch_jwks=fetch)
        token = self.token(BASE_AUDIENCE, "tools:read", BASE_ACTOR)
        verifier.verify(token, audience=BASE_AUDIENCE, scope="tools:read", actor=BASE_ACTOR)
        verifier._expires = int(time.time()) - 1
        verifier._stale_grace_seconds = 30
        slow[0] = True
        slow[0] = True

        refresh = threading.Thread(target=lambda: verifier._refresh(force=True))
        refresh.start()
        self.assertTrue(entered.wait(timeout=2))
        started = time.monotonic()
        verifier.verify(token, audience=BASE_AUDIENCE, scope="tools:read", actor=BASE_ACTOR)
        self.assertLess(time.monotonic() - started, 0.2)
        release.set()
        refresh.join(timeout=2)
        self.assertFalse(refresh.is_alive())

    def test_expired_jwks_refresh_is_single_flight_and_failures_back_off(self):
        clock = [100]
        calls = []
        entered = threading.Event()
        release = threading.Event()
        healthy = [True]

        def fetch():
            calls.append(clock[0])
            entered.set()
            if healthy[0]:
                release.wait(timeout=2)
                return {"keys": [self.jwk]}
            raise OSError("offline")

        verifier = DelegationVerifier(ISSUER, "https://delegation.example.test/jwks",
                                      fetch_jwks=fetch, now=lambda: clock[0])
        first = threading.Thread(target=verifier._refresh)
        first.start()
        self.assertTrue(entered.wait(timeout=2))
        second = threading.Thread(target=verifier._refresh)
        second.start()
        release.set()
        first.join(timeout=2); second.join(timeout=2)
        self.assertEqual(1, len(calls))
        self.assertFalse(first.is_alive() or second.is_alive())

        clock[0] = verifier._expires
        healthy[0] = False
        self.assertTrue(verifier.ready())
        self.assertEqual(2, len(calls))
        self.assertTrue(verifier.ready())
        self.assertEqual(2, len(calls))
        clock[0] = verifier._next_refresh_allowed
        healthy[0] = True
        self.assertTrue(verifier.ready())
        self.assertEqual(3, len(calls))

    def test_all_read_tools_call_only_their_real_owner_route(self):
        cases = [
            ("search_knowledge", {"query": "grain moisture", "k": 3}, "knowledge", "POST", "/v1/query"),
            ("query_structured_knowledge", {"question": "What is moisture risk?"}, "knowledge", "POST", "/v1/query"),
            ("get_alert", {"alert_id": ALERT}, "alerts_read", "GET", f"/v1/alerts/{ALERT}"),
            ("get_risk", {"device_id": DEVICE}, "read", "GET", "/api/v1/read/devices/" + DEVICE + "/risk?"),
            ("query_device_facts", {"device_id": DEVICE, "operation": "telemetry_latest"}, "read", "GET", f"/api/v1/read/devices/{DEVICE}/latest"),
            ("query_device_facts", {"device_id": DEVICE, "operation": "device_alerts"}, "alerts_read", "GET", "/v1/alerts?"),
            ("query_device_facts", {"device_id": DEVICE, "operation": "risk_history", "from": "2026-10-01T00:00:00Z", "to": "2026-10-02T00:00:00Z"}, "read", "GET", "/api/v1/read/devices/" + DEVICE + "/risk?"),
            ("query_device_facts", {"device_id": DEVICE, "operation": "telemetry_rollups", "from": "2026-10-01T00:00:00Z", "to": "2026-10-02T00:00:00Z", "bucket": "hour"}, "read", "GET", "/api/v1/read/devices/" + DEVICE + "/rollups?"),
        ]
        for tool, args, owner, method, path_prefix in cases:
            with self.subTest(tool=tool, args=args):
                self.owners.calls.clear()
                status, response = self.call_with(tool, args, owner)
                self.assertEqual(status, 200)
                self.assertEqual(response["id"], "call-1")
                self.assertEqual(len(self.owners.calls), 1)
                actual_owner, actual_path, token, tenant, actual_method, _, _ = self.owners.calls[0]
                self.assertEqual(actual_owner, "alerts" if owner == "alerts_read" else owner)
                self.assertTrue(actual_path.startswith(path_prefix))
                self.assertEqual(actual_method, method)
                self.assertEqual(tenant, TENANT)
                self.assertTrue(token)

    def test_proposal_uses_advisor_only_and_never_ack_endpoint(self):
        status, response = self.call_with(
            "propose_acknowledge_alert",
            {"alert_id": ALERT, "etag": '"17"', "note": "Please review", "run_id": RUN},
            "advisor_propose", base_scope="tools:propose",
        )
        self.assertEqual(status, 200)
        result = json.loads(response["result"]["content"][0]["text"])
        self.assertTrue(result["approval_required"])
        owner, path, _, tenant, method, body, headers = self.owners.calls[0]
        self.assertEqual((owner, path, tenant, method), ("advisor", "/v1/advisor/proposals", TENANT, "POST"))
        self.assertEqual(body["etag"], '"17"')
        self.assertEqual(headers["Idempotency-Key"], RUN)
        self.assertNotIn("ack", path)

    def test_missing_wrong_or_cross_tenant_owner_delegation_denies_before_owner(self):
        args = {"query": "grain moisture", "k": 3}
        status, _ = self.post("search_knowledge", args)
        self.assertEqual(status, 401)
        self.assertEqual(self.owners.calls, [])
        for kwargs in ({"tenant": "66666666-6666-4666-8666-666666666666"}, {"sub": "66666666-6666-4666-8666-666666666666"}, {"roles": ["viewer"]}, {"exp": self.now + 121}):
            with self.subTest(kwargs=kwargs):
                status, _ = self.call_with("search_knowledge", args, "knowledge", **kwargs)
                self.assertEqual(status, 200)
                self.assertEqual(_["error"]["message"], "delegation_binding_mismatch")
        self.assertEqual(self.owners.calls, [])

    def test_expired_wrong_audience_and_wrong_actor_tokens_are_rejected(self):
        args = {"query": "grain moisture", "k": 3}
        for token in (
            self.token(BASE_AUDIENCE, "tools:read", BASE_ACTOR, exp=self.now - 30),
            self.token("another-service", "tools:read", BASE_ACTOR),
            self.token(BASE_AUDIENCE, "tools:read", "another-actor"),
        ):
            with self.subTest(token=token[:12]):
                status, _ = self.post("search_knowledge", args, base_token=token)
                self.assertEqual(status, 401)
        self.assertEqual(self.owners.calls, [])

    def test_current_membership_is_required_and_roles_are_intersected(self):
        self.membership.current_roles = []
        status, body = self.call_with("search_knowledge", {"query": "grain moisture", "k": 3}, "knowledge")
        self.assertEqual(status, 200)
        self.assertEqual(body["error"]["message"], "membership_required")
        self.assertEqual(self.owners.calls, [])

    def test_operator_proposal_requires_live_operator_and_propose_scope(self):
        args = {"alert_id": ALERT, "etag": '"17"', "note": "Please review", "run_id": RUN}
        self.membership.current_roles = ["viewer"]
        status, body = self.call_with("propose_acknowledge_alert", args, "advisor_propose", base_scope="tools:propose")
        self.assertEqual(status, 200)
        self.assertEqual(body["error"]["message"], "insufficient_role")
        self.assertEqual(self.owners.calls, [])

    def test_duplicate_json_keys_and_invalid_arguments_are_rejected(self):
        with self.assertRaises(GatewayError):
            validate_arguments("get_risk", {"device_id": DEVICE, "tenant_id": TENANT})
        self.assertEqual(len(tool_definitions()), 6)
        self.assertNotIn("acknowledge_alert", {item["name"] for item in tool_definitions()})
        proposal = next(item for item in tool_definitions() if item["name"] == "propose_acknowledge_alert")
        self.assertEqual(proposal["inputSchema"]["properties"]["etag"]["pattern"], r'^"[0-9]{1,10}"$')

    def test_initialize_tools_list_and_initialized_notification(self):
        base = self.token(BASE_AUDIENCE, "tools:read", BASE_ACTOR)

        def send(payload):
            request = Request(self.url, data=json.dumps(payload).encode(), method="POST", headers={
                "Authorization": "Bearer " + base,
                "Content-Type": "application/json",
            })
            try:
                response = urlopen(request, timeout=3)
            except HTTPError as exc:
                response = exc
            return response.code, response.read()

        status, raw = send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                            "params": {"protocolVersion": "2025-03-26"}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["result"]["protocolVersion"], "2025-03-26")
        status, raw = send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(raw)["result"]["tools"]), 6)
        status, raw = send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(status, 202)
        self.assertEqual(raw, b"")

    def test_readiness_reports_dependency_failure_without_affecting_liveness(self):
        self.is_ready = False
        live = urlopen(f"http://127.0.0.1:{self.server.server_port}/healthz", timeout=2)
        try:
            ready = urlopen(f"http://127.0.0.1:{self.server.server_port}/readyz", timeout=2)
        except HTTPError as exc:
            ready = exc
        self.assertEqual(live.status, 200)
        self.assertEqual(ready.status, 503)
        self.is_ready = True
        self.assertEqual(urlopen(f"http://127.0.0.1:{self.server.server_port}/readyz", timeout=2).status, 200)

    def test_readiness_fails_immediately_during_shutdown(self):
        stopping = threading.Event()
        server = create_server(verifier=self.verifier, membership=self.membership,
                               dispatcher=self.dispatcher, readiness=lambda: True,
                               stopping=stopping, host="127.0.0.1", port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            stopping.set()
            with self.assertRaises(HTTPError) as caught:
                urlopen(f"http://127.0.0.1:{server.server_port}/readyz", timeout=2)
            self.assertEqual(503, caught.exception.code)
            request = Request(f"http://127.0.0.1:{server.server_port}/mcp", data=b"{}",
                              method="POST", headers={"Content-Type": "application/json"})
            with self.assertRaises(HTTPError) as caught:
                urlopen(request, timeout=2)
            self.assertEqual(503, caught.exception.code)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_total_request_deadline_interrupts_slow_headers(self):
        server = create_server(verifier=self.verifier, membership=self.membership,
                               dispatcher=self.dispatcher, readiness=lambda: True,
                               request_deadline_seconds=0.15,
                               host="127.0.0.1", port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with socket.create_connection(("127.0.0.1", server.server_port), timeout=2) as client:
                client.settimeout(2)
                client.sendall(b"POST /mcp HTTP/1.1\r\nHost: localhost\r\n")
                self.assertEqual(client.recv(1), b"")
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_control_plane_membership_contract_is_fail_closed(self):
        from gateway import ControlPlaneMembership

        seen = []

        def request(url, method, token, headers, body, *, max_bytes):
            seen.append((url, method, token, max_bytes))
            return 200, {"tenantId": TENANT, "identityId": USER, "roles": ["operator"], "version": "12", "state": "active"}, {}

        membership = ControlPlaneMembership("http://127.0.0.1:3010", "internal-token", request)
        self.assertEqual(membership.roles({"tenant_id": TENANT, "sub": USER}), ["operator"])
        self.assertIn("tenantId=" + TENANT, seen[0][0])
        self.assertEqual(seen[0][2], "internal-token")

        def malformed(*_args, **_kwargs):
            return 200, {"tenantId": TENANT, "identityId": USER, "roles": ["operator"], "state": "active"}, {}

        with self.assertRaises(GatewayError):
            ControlPlaneMembership("http://127.0.0.1", "internal-token", malformed).roles({"tenant_id": TENANT, "sub": USER})

    def test_owner_transport_performs_real_bounded_http_round_trip(self):
        observed = {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                observed["path"] = self.path
                observed["authorization"] = self.headers.get("Authorization")
                observed["body"] = self.rfile.read(int(self.headers["Content-Length"]))
                raw = '{"owner":"café"}'.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            status, body, _headers = owner_request(
                f"http://127.0.0.1:{server.server_port}/v1/query",
                "POST",
                None,
                {"Authorization": "Bearer scoped-owner-token", "Content-Type": "application/json"},
                b'{"question":"grain moisture"}',
                max_bytes=1024,
            )
            self.assertEqual(status, 200)
            self.assertEqual(body, {"owner": "café"})
            self.assertEqual(observed["path"], "/v1/query")
            self.assertEqual(observed["authorization"], "Bearer scoped-owner-token")
            self.assertEqual(observed["body"], b'{"question":"grain moisture"}')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_owner_origin_is_fixed_to_known_service_or_https(self):
        with self.assertRaises(ValueError):
            OwnerClients(knowledge_url="http://attacker.test", read_url="http://read-api.greenguard.svc.cluster.local:4001",
                         alerts_url="http://workflow-alerts.greenguard.svc.cluster.local:3004",
                         advisor_url="http://grain-advisor.greenguard.svc.cluster.local:8088", requester=lambda *a, **k: None)


if __name__ == "__main__":
    unittest.main()
