"""Bounded JSON-RPC MCP bridge to GreenGuard's owning APIs.

The BFF supplies a short-lived, BFF-signed per-owner delegation map. This
service verifies every token and its binding to the base MCP token, then only
forwards the one fixed audience/scope required by the selected tool. It never
holds a signing key or service credential for owner APIs.
"""
from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

import jwt
from jwt.algorithms import RSAAlgorithm


UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
ROLES = {"viewer", "operator", "admin"}
BASE_AUDIENCE = "greenguard-mcp"
BASE_ACTOR = "grain-advisor"  # Current BFF MCP token signer contract.
OWNER_CONTRACTS = {
    "knowledge": ("knowledge-service", "knowledge:read"),
    "read": ("read-api", "telemetry:read"),
    "alerts_read": ("workflow-alerts", "alerts:read"),
    "advisor_propose": ("grain-advisor", "advisor:propose"),
}
TOOL_NAMES = {
    "search_knowledge", "query_structured_knowledge", "get_alert",
    "get_risk", "query_device_facts", "propose_acknowledge_alert",
}


class GatewayError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def _closed_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _uuid(value):
    return isinstance(value, str) and bool(UUID_RE.fullmatch(value))


def _now():
    return int(time.time())


class DelegationVerifier:
    """RS256 verifier for the BFF JWKS and its exact delegated-token contract."""

    def __init__(self, issuer: str, jwks_url: str, *, fetch_jwks=None, now=_now):
        for raw in (issuer, jwks_url):
            parsed = urlsplit(raw)
            if (parsed.username or parsed.password or parsed.query or parsed.fragment
                    or parsed.scheme not in {"https", "http"} or not parsed.hostname):
                raise ValueError("unsafe delegated issuer/JWKS URL")
            if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
                raise ValueError("delegated HTTP is allowed only for loopback tests")
        self.issuer, self.jwks_url = issuer, jwks_url
        self.fetch_jwks, self.now = fetch_jwks, now
        self._keys = {}
        self._expires = 0
        self._last_success = 0
        self._last_unknown_kid_refresh = 0
        self._unknown_kid_refresh_interval = 5
        self._stale_grace_seconds = 30
        self._refresh_failures = 0
        self._next_refresh_allowed = 0
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._refresh_scheduled = False

    def _refresh(self, *, force=False, blocking=True):
        # Network I/O must never hold the cache lock. Serialize fetches with a
        # dedicated lock and atomically publish only a fully validated keyset.
        if not self._refresh_lock.acquire(blocking=blocking):
            return False
        try:
            current = self.now()
            with self._lock:
                if not force and self._keys and current < self._expires:
                    return True
                if current < self._next_refresh_allowed:
                    return False
            try:
                if self.fetch_jwks:
                    document = self.fetch_jwks()
                else:
                    class NoRedirect(HTTPRedirectHandler):
                        def redirect_request(self, *args, **kwargs):
                            return None

                    with build_opener(ProxyHandler({}), NoRedirect()).open(Request(self.jwks_url, headers={"Accept": "application/json"}), timeout=2) as response:
                        raw = response.read(16385)
                    if len(raw) > 16384:
                        raise ValueError("JWKS response too large")
                    document = json.loads(raw)
                if (not isinstance(document, dict) or set(document) != {"keys"}
                        or not isinstance(document["keys"], list) or not 1 <= len(document["keys"]) <= 8):
                    raise ValueError("invalid JWKS")
                keys = {}
                for jwk in document["keys"]:
                    if (not isinstance(jwk, dict) or jwk.get("kty") != "RSA" or jwk.get("alg") != "RS256"
                            or jwk.get("use") != "sig" or not isinstance(jwk.get("kid"), str)
                            or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", jwk["kid"])
                            or any(name in jwk for name in ("d", "p", "q", "dp", "dq", "qi", "oth", "k"))):
                        raise ValueError("invalid JWK")
                    key = RSAAlgorithm.from_jwk(json.dumps(jwk))
                    if not 2048 <= key.key_size <= 8192 or jwk["kid"] in keys:
                        raise ValueError("invalid JWK key")
                    keys[jwk["kid"]] = key
                current = self.now()
                with self._lock:
                    self._keys = keys
                    self._expires = current + 60
                    self._last_success = current
                    self._refresh_failures = 0
                    self._next_refresh_allowed = 0
                return True
            except Exception:
                # Keep last-known-good keys in memory during a bounded outage;
                # callers decide whether that cache is still within its grace.
                failed_at = self.now()
                with self._lock:
                    self._refresh_failures = min(self._refresh_failures + 1, 5)
                    self._next_refresh_allowed = failed_at + min(2 ** self._refresh_failures, 30)
                return False
        finally:
            self._refresh_lock.release()

    def _schedule_refresh(self):
        with self._lock:
            if self._refresh_scheduled:
                return
            self._refresh_scheduled = True

        def refresh_in_background():
            try:
                self._refresh(blocking=False)
            finally:
                with self._lock:
                    self._refresh_scheduled = False

        threading.Thread(target=refresh_in_background, name="delegation-jwks-refresh", daemon=True).start()

    def ready(self):
        with self._lock:
            current = self.now()
            refresh = current >= self._expires or not self._keys
        if refresh:
            self._refresh()
        with self._lock:
            current = self.now()
            return bool(self._keys) and current <= self._expires + self._stale_grace_seconds

    def verify(self, token: str, *, audience: str, scope: str, actor: str):
        if not isinstance(token, str) or not re.fullmatch(r"[^\s]{1,16384}", token):
            raise GatewayError(401, "invalid_token")
        try:
            header = jwt.get_unverified_header(token)
            if (set(header) != {"alg", "typ", "kid"} or header.get("alg") != "RS256"
                    or header.get("typ") != "at+jwt" or not isinstance(header.get("kid"), str)
                    or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", header["kid"])):
                raise ValueError("header")
            with self._lock:
                current = self.now()
                expired = current >= self._expires
                unknown = header["kid"] not in self._keys
                usable_stale = bool(self._keys) and current <= self._expires + self._stale_grace_seconds
                # A cold-start fetch (or expiry-triggered fetch) already refreshes
                # the set. Do not spend the unknown-kid throttle on that path.
                refresh_unknown = (unknown and bool(self._keys) and not expired
                                   and current - self._last_unknown_kid_refresh
                                   >= self._unknown_kid_refresh_interval)
                if refresh_unknown:
                    self._last_unknown_kid_refresh = current
            if expired and usable_stale and not unknown:
                # Keep serving a known last-good key during its explicit grace
                # period; a slow JWKS endpoint must not stall owner requests.
                self._schedule_refresh()
            elif expired or refresh_unknown:
                self._refresh(force=refresh_unknown)
            with self._lock:
                current = self.now()
                key = self._keys.get(header["kid"])
                usable = bool(self._keys) and current <= self._expires + self._stale_grace_seconds
            if not usable:
                raise GatewayError(503, "delegation_keys_unavailable")
            if key is None:
                raise ValueError("kid")
            claims = jwt.decode(token, key, algorithms=["RS256"], issuer=self.issuer,
                                audience=audience, leeway=5,
                                options={"require": ["iss", "aud", "sub", "exp", "iat", "nbf", "jti"]})
            expected = {"iss", "aud", "sub", "exp", "iat", "nbf", "jti", "tenant_id", "roles", "act", "scope", "token_use"}
            act = claims.get("act")
            if (set(claims) != expected or claims.get("aud") != audience or claims.get("scope") != scope
                    or claims.get("token_use") != "delegated" or act != {"sub": actor}
                    or not _uuid(claims.get("sub")) or not _uuid(claims.get("tenant_id"))
                    or not _uuid(claims.get("jti")) or any(type(claims.get(k)) is not int for k in ("iat", "exp", "nbf"))
                    or not 0 < claims["exp"] - claims["iat"] <= 300 or claims["nbf"] != claims["iat"]
                    or not isinstance(claims.get("roles"), list) or not claims["roles"]
                    or any(role not in ROLES for role in claims["roles"])):
                raise ValueError("claims")
            return claims
        except GatewayError:
            raise
        except Exception as exc:
            raise GatewayError(401, "invalid_token") from exc


class ControlPlaneMembership:
    """Refresh BFF delegated identity roles before any owner operation."""

    def __init__(self, url: str, token: str, requester, *, allow_mesh_http=False):
        parsed = urlsplit(url)
        local = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        mesh = (allow_mesh_http and parsed.scheme == "http"
                and parsed.hostname == "tenant-control-plane.greenguard.svc.cluster.local"
                and parsed.port == 3010)
        if parsed.scheme != "https" and not local and not mesh:
            raise ValueError("control-plane membership requires HTTPS or local test endpoint")
        if (parsed.username or parsed.password or parsed.path not in {"", "/"}
                or parsed.query or parsed.fragment or not isinstance(token, str)
                or not 1 <= len(token) <= 8192 or any(ch.isspace() for ch in token)):
            raise ValueError("invalid control-plane membership configuration")
        self.url, self.token, self.requester = url.rstrip("/"), token, requester

    def roles(self, claims):
        path = "/v1/internal/delegated-memberships?" + urlencode({"tenantId": claims["tenant_id"], "identityId": claims["sub"]})
        status, body, _ = self.requester(self.url + path, "GET", self.token, {}, None, max_bytes=8192)
        if status == 404:
            raise GatewayError(403, "membership_required")
        if status != 200 or not isinstance(body, dict):
            raise GatewayError(503, "membership_unavailable")
        if (set(body) != {"tenantId", "identityId", "roles", "version", "state"}
                or body.get("tenantId") != claims["tenant_id"] or body.get("identityId") != claims["sub"]
                or body.get("state") != "active" or not isinstance(body.get("roles"), list)
                or not body["roles"] or len(set(body["roles"])) != len(body["roles"])
                or any(role not in ROLES for role in body["roles"])
                or not isinstance(body.get("version"), str) or not re.fullmatch(r"[0-9]{1,20}", body["version"])):
            raise GatewayError(503, "membership_unavailable")
        return body["roles"]

    def ready(self):
        try:
            status, body, _ = self.requester(self.url + "/readyz", "GET", self.token, {}, None, max_bytes=1024)
            return status == 200 and isinstance(body, dict) and body.get("status") == "ready"
        except Exception:
            return False


class OwnerClients:
    """Fixed-route owner adapters; URLs are validated once, never tool input."""

    def __init__(self, *, knowledge_url, read_url, alerts_url, advisor_url, requester, allow_mesh_http=False):
        self.requester = requester
        self.origins = {
            "knowledge": _owner_origin(knowledge_url, "knowledge-service.greenguard.svc.cluster.local", 8080, allow_mesh_http),
            "read": _owner_origin(read_url, "read-api.greenguard.svc.cluster.local", 4001, allow_mesh_http),
            "alerts": _owner_origin(alerts_url, "workflow-alerts.greenguard.svc.cluster.local", 3004, allow_mesh_http),
            "advisor": _owner_origin(advisor_url, "grain-advisor.greenguard.svc.cluster.local", 8088, allow_mesh_http),
        }

    def request(self, owner, path, token, tenant_id, method="GET", body=None, *, headers=None):
        if owner not in self.origins or not path.startswith("/") or path.startswith("//"):
            raise GatewayError(500, "invalid_owner_route")
        request_headers = dict(headers or {})
        request_headers["Accept"] = "application/json"
        request_headers["Authorization"] = "Bearer " + token
        if owner in {"knowledge", "advisor"}:
            request_headers["X-Tenant-ID"] = tenant_id
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        status, result, response_headers = self.requester(
            self.origins[owner] + path, method, None, request_headers,
            json.dumps(body, separators=(",", ":")).encode() if body is not None else None,
            max_bytes=32768,
        )
        if status < 200 or status >= 300:
            code = "rate_limited" if status == 429 else "owner_request_failed"
            retry = response_headers.get("retry-after")
            try:
                retry = int(retry)
            except (TypeError, ValueError):
                retry = None
            detail = {"code": code, "status": status}
            if code == "rate_limited" and retry is not None and 1 <= retry <= 120:
                detail["retry_after_seconds"] = retry
            return None, detail, status
        if not isinstance(result, (dict, list)):
            raise GatewayError(503, "owner_response_invalid")
        return result, {"etag": response_headers.get("etag")}, status


def _owner_origin(raw, expected_host, expected_port, allow_mesh_http=False):
    parsed = urlsplit(raw)
    local = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    mesh = allow_mesh_http and parsed.scheme == "http" and parsed.hostname == expected_host and parsed.port == expected_port
    if (parsed.scheme != "https" and not local and not mesh) or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("unsafe owner service origin")
    return f"{parsed.scheme}://{parsed.netloc}"


def owner_request(url, method, token, headers, body, *, max_bytes):
    """Hard two-second total deadline via a killable subprocess, DNS included."""
    import base64
    import os
    import subprocess
    import sys

    request = {"url": url, "method": method, "token": token, "headers": headers,
               "body": base64.b64encode(body or b"").decode("ascii"), "max_bytes": max_bytes}
    deadline = time.monotonic() + 2
    worker_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "owner_worker.py")
    worker = subprocess.Popen([sys.executable, worker_path], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        output, _ = worker.communicate(json.dumps(request).encode(), timeout=max(0.01, deadline-time.monotonic()))
    except subprocess.TimeoutExpired as exc:
        worker.kill(); worker.communicate()
        raise GatewayError(503, "owner_timeout") from exc
    except BaseException:
        worker.kill(); worker.communicate()
        raise
    finally:
        worker.wait()
    if worker.returncode != 0 or time.monotonic() > deadline or len(output) > max_bytes + 2048:
        raise GatewayError(503, "owner_unavailable")
    try:
        result = json.loads(output)
    except Exception as exc:
        raise GatewayError(503, "owner_response_invalid") from exc
    if result.get("error"):
        raise GatewayError(503, "owner_unavailable")
    return result["status"], result.get("json"), result.get("headers", {})


def validate_arguments(tool, args):
    if not isinstance(args, dict): raise GatewayError(400, "invalid_arguments")
    allowed = {
        "search_knowledge": {"query", "k", "selected_document"},
        "query_structured_knowledge": {"question", "selected_document"},
        "get_alert": {"alert_id"}, "get_risk": {"device_id"},
        "query_device_facts": {"device_id", "operation", "from", "to", "bucket"},
        "propose_acknowledge_alert": {"alert_id", "etag", "note", "run_id"},
    }
    if tool not in TOOL_NAMES or set(args) - allowed[tool]: raise GatewayError(400, "invalid_arguments")
    if tool == "search_knowledge":
        if set(args) - {"query", "k", "selected_document"} or not isinstance(args.get("query"), str) or not 4 <= len(args["query"].strip()) <= 2000 or type(args.get("k")) is not int or not 1 <= args["k"] <= 8: raise GatewayError(400, "invalid_arguments")
    elif tool == "query_structured_knowledge":
        if not isinstance(args.get("question"), str) or not 4 <= len(args["question"].strip()) <= 2000: raise GatewayError(400, "invalid_arguments")
    elif tool in {"get_alert", "propose_acknowledge_alert"}:
        if not _uuid(args.get("alert_id")): raise GatewayError(400, "invalid_arguments")
        if tool == "propose_acknowledge_alert" and (set(args) != {"alert_id", "etag", "note", "run_id"} or not _uuid(args.get("run_id")) or not isinstance(args.get("note"), str) or not 1 <= len(args["note"]) <= 500 or not isinstance(args.get("etag"), str) or not re.fullmatch(r'"[0-9]{1,10}"', args["etag"])): raise GatewayError(400, "invalid_arguments")
        if tool == "get_alert" and set(args) != {"alert_id"}: raise GatewayError(400, "invalid_arguments")
    elif tool in {"get_risk", "query_device_facts"}:
        if not _uuid(args.get("device_id")): raise GatewayError(400, "invalid_arguments")
        if tool == "get_risk" and set(args) != {"device_id"}: raise GatewayError(400, "invalid_arguments")
        if tool == "query_device_facts":
            op = args.get("operation")
            if op in {"telemetry_latest", "device_alerts"} and set(args) != {"device_id", "operation"}: raise GatewayError(400, "invalid_arguments")
            if op in {"risk_history", "telemetry_rollups"}:
                if not isinstance(args.get("from"), str) or not isinstance(args.get("to"), str): raise GatewayError(400, "invalid_arguments")
                try: start, end = datetime.fromisoformat(args["from"].replace("Z", "+00:00")), datetime.fromisoformat(args["to"].replace("Z", "+00:00"))
                except ValueError as exc: raise GatewayError(400, "invalid_arguments") from exc
                if start.tzinfo is None or end.tzinfo is None or end <= start or end-start > timedelta(days=31): raise GatewayError(400, "invalid_arguments")
                expected = {"device_id", "operation", "from", "to"} | ({"bucket"} if op == "telemetry_rollups" else set())
                if set(args) != expected or (op == "telemetry_rollups" and args.get("bucket") not in {"hour", "day"}): raise GatewayError(400, "invalid_arguments")
            elif op not in {"telemetry_latest", "device_alerts"}: raise GatewayError(400, "invalid_arguments")
    selected = args.get("selected_document")
    if selected is not None:
        if tool not in {"search_knowledge", "query_structured_knowledge"} or not isinstance(selected, dict) or set(selected) != {"document_id", "document_version"} or not _uuid(selected.get("document_id")) or type(selected.get("document_version")) is not int or not 1 <= selected["document_version"] <= 2147483647: raise GatewayError(400, "invalid_arguments")


def _content(value):
    return {"content": [{"type": "text", "text": json.dumps(value, separators=(",", ":"), ensure_ascii=False)}], "isError": False}


def _selected_owners(tool, args, base_scope):
    if base_scope == "tools:propose" and tool != "propose_acknowledge_alert": raise GatewayError(403, "insufficient_scope")
    if tool == "propose_acknowledge_alert":
        if base_scope != "tools:propose": raise GatewayError(403, "insufficient_scope")
        return {"advisor_propose": OWNER_CONTRACTS["advisor_propose"]}
    if base_scope != "tools:read": raise GatewayError(403, "insufficient_scope")
    if tool in {"search_knowledge", "query_structured_knowledge"}: return {"knowledge": OWNER_CONTRACTS["knowledge"]}
    if tool == "get_alert" or (tool == "query_device_facts" and args["operation"] == "device_alerts"): return {"alerts_read": OWNER_CONTRACTS["alerts_read"]}
    return {"read": OWNER_CONTRACTS["read"]}


def _selected_document(args):
    value = args.get("selected_document")
    if not value: return {}
    return {"document_id": value["document_id"], "document_version": value["document_version"]}


class ToolDispatcher:
    def __init__(self, owners: OwnerClients): self.owners = owners

    def call(self, tool, args, principal, tokens):
        tenant = principal["tenant_id"]
        if tool in {"search_knowledge", "query_structured_knowledge"}:
            question = args.get("query") if tool == "search_knowledge" else args["question"]
            body = {"question": question, "candidate_k": max(20, args.get("k", 5) * 4), "context_k": args.get("k", 5), "mode": "structured" if tool == "query_structured_knowledge" else "question", **_selected_document(args)}
            result, metadata, status = self.owners.request("knowledge", "/v1/query", tokens["knowledge"]["token"], tenant, "POST", body)
            if result is None: return {"content": [{"type": "text", "text": json.dumps(metadata)}], "isError": True}
            return _content(result)
        if tool == "get_alert":
            result, metadata, _ = self.owners.request("alerts", "/v1/alerts/" + args["alert_id"], tokens["alerts_read"]["token"], tenant)
            if result is None: return {"content": [{"type": "text", "text": json.dumps(metadata)}], "isError": True}
            return _content({"alert": result, "etag": metadata.get("etag")})
        if tool == "get_risk":
            now = datetime.now(timezone.utc); start = now-timedelta(days=1)
            args = {"device_id": args["device_id"], "operation": "risk_history", "from": start.isoformat(), "to": now.isoformat()}
        if tool == "query_device_facts":
            operation = args["operation"]
            if operation == "device_alerts":
                path = "/v1/alerts?" + urlencode({"deviceId": args["device_id"], "limit": "20"})
                owner = "alerts"; name = "alerts_read"
            elif operation == "telemetry_latest":
                path = f"/api/v1/read/devices/{args['device_id']}/latest"; owner = "read"; name = "read"
            elif operation == "risk_history":
                path = f"/api/v1/read/devices/{args['device_id']}/risk?" + urlencode({"from": args["from"], "to": args["to"], "limit": "20"}); owner = "read"; name = "read"
            else:
                path = f"/api/v1/read/devices/{args['device_id']}/rollups?" + urlencode({"from": args["from"], "to": args["to"], "bucket": args["bucket"], "limit": "20"}); owner = "read"; name = "read"
            result, metadata, _ = self.owners.request(owner, path, tokens[name]["token"], tenant)
            return _content(result) if result is not None else {"content": [{"type": "text", "text": json.dumps(metadata)}], "isError": True}
        if tool == "get_risk":
            result, metadata, _ = self.owners.request("read", f"/api/v1/read/devices/{args['device_id']}/risk?" + urlencode({"from": args["from"], "to": args["to"], "limit": "20"}), tokens["read"]["token"], tenant)
            return _content(result) if result is not None else {"content": [{"type": "text", "text": json.dumps(metadata)}], "isError": True}
        if tool == "propose_acknowledge_alert":
            body = {key: args[key] for key in ("run_id", "alert_id", "note", "etag")}
            result, metadata, _ = self.owners.request("advisor", "/v1/advisor/proposals", tokens["advisor_propose"]["token"], tenant, "POST", body, headers={"Idempotency-Key": args["run_id"]})
            return _content({"approval_required": True, "proposal": result}) if result is not None else {"content": [{"type": "text", "text": json.dumps(metadata)}], "isError": True}
        raise GatewayError(400, "unknown_tool")


def create_server(*, verifier: DelegationVerifier, membership, dispatcher: ToolDispatcher, readiness=None,
                  stopping=None, request_deadline_seconds=15, host="127.0.0.1", port=0):
    import socket

    stopping = stopping or threading.Event()

    class Handler(BaseHTTPRequestHandler):
        timeout = request_deadline_seconds
        server_version = "GreenGuardMCP/1"
        def log_message(self, *_): return
        def setup(self):
            super().setup()
            self._request_watchdog = threading.Timer(request_deadline_seconds, self._interrupt_slow_request)
            self._request_watchdog.daemon = True
            self._request_watchdog.start()
        def _interrupt_slow_request(self):
            try: self.connection.shutdown(socket.SHUT_RDWR)
            except OSError: pass
        def finish(self):
            timer = getattr(self, "_request_watchdog", None)
            if timer is not None: timer.cancel()
            super().finish()
        def reply(self, status, body):
            raw = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status); self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store"); self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
        def do_GET(self):
            path = self.path
            if path == "/healthz":
                self.reply(200, {"status": "ok"})
            elif path == "/readyz":
                try: ready = not stopping.is_set() and bool(readiness()) if readiness is not None else False
                except Exception: ready = False
                self.reply(200 if ready else 503, {"status": "ready" if ready else "unavailable"})
            elif stopping.is_set():
                self.reply(503, {"error": "shutting_down"})
            else:
                self.reply(404, {"error": "not_found"})
        def do_POST(self):
            if stopping.is_set(): self.reply(503, {"error": "shutting_down"}); return
            if urlsplit(self.path).path != "/mcp" or self.path != "/mcp": self.reply(404, {"error": "not_found"}); return
            try:
                if len(self.headers.get_all("Authorization", [])) != 1: raise GatewayError(401, "invalid_headers")
                if self.headers.get_content_type() != "application/json": raise GatewayError(400, "invalid_content_type")
                raw = self._body()
                request = json.loads(raw, object_pairs_hook=_closed_object, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid number")))
                if not isinstance(request, dict) or set(request) - {"jsonrpc", "id", "method", "params"} or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
                    raise GatewayError(400, "invalid_json_rpc")
                request_id = request.get("id")
                if "id" in request and (isinstance(request_id, bool) or not isinstance(request_id, (str, int)) or len(str(request_id)) > 128): raise GatewayError(400, "invalid_json_rpc")
                if request["method"] != "notifications/initialized" and "id" not in request: raise GatewayError(400, "invalid_json_rpc")
                if request["method"] == "notifications/initialized" and "id" in request: raise GatewayError(400, "invalid_json_rpc")
                base_token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                method_params = request.get("params")
                requested_name = method_params.get("name") if isinstance(method_params, dict) else None
                requested_scope = "tools:propose" if request["method"] == "tools/call" and requested_name == "propose_acknowledge_alert" else "tools:read"
                base = verifier.verify(base_token, audience=BASE_AUDIENCE, scope=requested_scope, actor=BASE_ACTOR)
                try:
                    roles = set(membership.roles(base))
                except TypeError: raise GatewayError(503, "membership_unavailable")
                effective = set(base["roles"]) & roles
                if not effective: raise GatewayError(403, "membership_required")
                if request["method"] == "initialize":
                    params = request.get("params", {})
                    version = params.get("protocolVersion") if isinstance(params, dict) else None
                    if version not in {"2025-03-26", "2025-06-18"}: raise GatewayError(400, "unsupported_protocol_version")
                    self.reply(200, {"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "greenguard-mcp-gateway", "version": "1.0.0"}}}); return
                if request["method"] == "notifications/initialized":
                    if set(request) - {"jsonrpc", "method", "params"}: raise GatewayError(400, "invalid_notification")
                    self.send_response(202); self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", "0"); self.end_headers(); return
                if request["method"] == "tools/list":
                    self.reply(200, {"jsonrpc": "2.0", "id": request_id, "result": {"tools": tool_definitions()}}); return
                if request["method"] != "tools/call": self.reply(200, {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}}); return
                params = method_params
                if not isinstance(params, dict) or set(params) != {"name", "arguments"} or params.get("name") not in TOOL_NAMES: raise GatewayError(400, "invalid_tool_call")
                name, args = params["name"], params["arguments"]
                validate_arguments(name, args)
                if name == "propose_acknowledge_alert" and not effective.intersection({"operator", "admin"}): raise GatewayError(403, "insufficient_role")
                base_scope = requested_scope
                if base_scope != ("tools:propose" if name == "propose_acknowledge_alert" else "tools:read"):
                    raise GatewayError(403, "insufficient_scope")
                if base_scope == "tools:propose" and not effective.intersection({"operator", "admin"}): raise GatewayError(403, "insufficient_role")
                selected = _selected_owners(name, args, base_scope)
                if len(self.headers.get_all("X-GG-Owner-Delegations", [])) != 1: raise GatewayError(401, "owner_delegation_required")
                raw_mapping = self.headers.get("X-GG-Owner-Delegations", "")
                if len(raw_mapping) > 32768: raise GatewayError(401, "owner_delegation_required")
                mapping = json.loads(raw_mapping, object_pairs_hook=_closed_object)
                if not isinstance(mapping, dict) or set(mapping) != set(selected): raise GatewayError(401, "owner_delegation_required")
                verified = {}
                for owner, (audience, scope) in selected.items():
                    token = mapping[owner]
                    claims = verifier.verify(token, audience=audience, scope=scope, actor="greenguard-mcp")
                    if (claims["iss"] != base["iss"] or claims["tenant_id"] != base["tenant_id"] or claims["sub"] != base["sub"]
                            or set(claims["roles"]) != set(base["roles"]) or claims["exp"] > base["exp"]):
                        raise GatewayError(403, "delegation_binding_mismatch")
                    verified[owner] = {"token": token, "claims": claims}
                result = dispatcher.call(name, args, base, verified)
                self.reply(200, {"jsonrpc": "2.0", "id": request_id, "result": result})
            except GatewayError as exc:
                self.reply(401 if exc.status == 401 else 200, {"jsonrpc": "2.0", "id": locals().get("request_id"), "error": {"code": -32000 if exc.status >= 500 else -32602, "message": exc.code}})
            except (ValueError, TypeError, KeyError, UnicodeError):
                self.reply(200, {"jsonrpc": "2.0", "id": locals().get("request_id"), "error": {"code": -32700, "message": "Invalid request"}})
            except Exception:
                self.reply(200, {"jsonrpc": "2.0", "id": locals().get("request_id"), "error": {"code": -32000, "message": "Tool unavailable"}})
        def _body(self):
            if self.headers.get_all("Transfer-Encoding", []): raise GatewayError(400, "invalid_body")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not lengths[0].isdigit(): raise GatewayError(400, "invalid_body")
            size = int(lengths[0])
            if size > 65536: raise GatewayError(413, "request_too_large")
            deadline = time.monotonic() + 3
            body = bytearray()
            while len(body) < size:
                self.connection.settimeout(max(0.01, deadline-time.monotonic()))
                part = self.rfile.read1(min(8192, size-len(body)))
                if not part: raise GatewayError(400, "invalid_body")
                body.extend(part)
            return bytes(body)
    class Server(ThreadingHTTPServer):
        daemon_threads = False
        def __init__(self, *args): self.slots = threading.BoundedSemaphore(32); super().__init__(*args)
        def process_request(self, request, address):
            if not self.slots.acquire(blocking=False): self.shutdown_request(request); return
            try: super().process_request(request, address)
            except Exception: self.slots.release(); raise
        def process_request_thread(self, request, address):
            try: super().process_request_thread(request, address)
            finally: self.slots.release()
    return Server((host, port), Handler)


def tool_definitions():
    selected_document = {"type": "object", "additionalProperties": False,
                         "required": ["document_id", "document_version"],
                         "properties": {"document_id": {"type": "string", "format": "uuid"},
                                        "document_version": {"type": "integer", "minimum": 1, "maximum": 2147483647}}}
    return [
        {"name": "search_knowledge", "description": "Search tenant-authorized GreenGuard knowledge documents.", "inputSchema": {"type": "object", "additionalProperties": False, "required": ["query", "k"], "properties": {"query": {"type": "string", "minLength": 4, "maxLength": 2000}, "k": {"type": "integer", "minimum": 1, "maximum": 8}, "selected_document": selected_document}}},
        {"name": "query_structured_knowledge", "description": "Ask the tenant-authorized structured knowledge service.", "inputSchema": {"type": "object", "additionalProperties": False, "required": ["question"], "properties": {"question": {"type": "string", "minLength": 4, "maxLength": 2000}, "selected_document": selected_document}}},
        {"name": "get_alert", "description": "Read one tenant-owned alert and its current ETag.", "inputSchema": {"type": "object", "additionalProperties": False, "required": ["alert_id"], "properties": {"alert_id": {"type": "string", "format": "uuid"}}}},
        {"name": "get_risk", "description": "Read a bounded 24-hour risk assessment history. Assessments are unverified and not actionable.", "inputSchema": {"type": "object", "additionalProperties": False, "required": ["device_id"], "properties": {"device_id": {"type": "string", "format": "uuid"}}}},
        {"name": "query_device_facts", "description": "Read bounded tenant-owned device telemetry, risk history, rollups, or associated alerts.", "inputSchema": {"type": "object", "additionalProperties": False, "required": ["device_id", "operation"], "properties": {"device_id": {"type": "string", "format": "uuid"}, "operation": {"type": "string", "enum": ["telemetry_latest", "device_alerts", "risk_history", "telemetry_rollups"]}, "from": {"type": "string", "format": "date-time"}, "to": {"type": "string", "format": "date-time"}, "bucket": {"type": "string", "enum": ["hour", "day"]}}}},
        {"name": "propose_acknowledge_alert", "description": "Create a human-approval proposal to acknowledge an alert; this tool does not acknowledge it.", "inputSchema": {"type": "object", "additionalProperties": False, "required": ["alert_id", "etag", "note", "run_id"], "properties": {"alert_id": {"type": "string", "format": "uuid"}, "etag": {"type": "string", "pattern": r'^"[0-9]{1,10}"$'}, "note": {"type": "string", "minLength": 1, "maxLength": 500}, "run_id": {"type": "string", "format": "uuid"}}}},
    ]


def main():
    import os
    import signal

    verifier = DelegationVerifier(os.environ["MCP_DELEGATED_ISSUER"], os.environ["MCP_DELEGATED_JWKS_URL"])
    requester = owner_request
    mesh_http = os.environ.get("MCP_MESH_INTERNAL_HTTP") == "true"
    if os.environ.get("MCP_MESH_INTERNAL_HTTP", "false") not in {"true", "false"}:
        raise SystemExit("MCP_MESH_INTERNAL_HTTP must be true or false")
    membership = ControlPlaneMembership(os.environ["CONTROL_PLANE_URL"], os.environ["CONTROL_LOOKUP_TOKEN"], requester, allow_mesh_http=mesh_http)
    owners = OwnerClients(
        knowledge_url=os.environ["MCP_KNOWLEDGE_URL"],
        read_url=os.environ["MCP_READ_API_URL"],
        alerts_url=os.environ["MCP_ALERTS_URL"],
        advisor_url=os.environ["MCP_ADVISOR_URL"],
        requester=requester,
        allow_mesh_http=mesh_http,
    )
    stopping = threading.Event()
    drain_seconds = float(os.environ.get("MCP_SHUTDOWN_DRAIN_SECONDS", "5"))
    if not 0 <= drain_seconds < 30:
        raise SystemExit("MCP_SHUTDOWN_DRAIN_SECONDS must be >=0 and <30 seconds")
    server = create_server(verifier=verifier, membership=membership, dispatcher=ToolDispatcher(owners),
                           readiness=lambda: verifier.ready() and membership.ready(), stopping=stopping,
                           host=os.environ.get("MCP_HOST", "0.0.0.0"), port=int(os.environ.get("MCP_PORT", "8090")))
    def stop(*_):
        if not stopping.is_set():
            stopping.set()
            def drain_then_shutdown():
                time.sleep(drain_seconds)
                server.shutdown()
            threading.Thread(target=drain_then_shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    try: server.serve_forever(poll_interval=0.2)
    finally: server.server_close()


if __name__ == "__main__":
    main()
