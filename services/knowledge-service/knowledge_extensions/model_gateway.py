"""Client ports for the internal model-gateway contract (no direct vendor egress)."""

from __future__ import annotations

import json
import math
import time
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import UUID
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request
from .http_transport import urlopen
from .trace_context import outbound_trace_headers
from .prompt_guardrails import PromptInjectionError


_deadline: ContextVar[float | None] = ContextVar("gateway_deadline", default=None)
_verified_user: ContextVar[str | None] = ContextVar("gateway_verified_user", default=None)
_call_timeout: ContextVar[float | None] = ContextVar("gateway_call_timeout", default=None)

@contextmanager
def verified_gateway_user(principal_id: str | None, *, deadline_seconds: float = 20, call_timeout_seconds: float | None = None):
    """Called only after knowledge authentication/membership verification."""
    if principal_id is not None and str(UUID(principal_id)) != principal_id:
        raise ValueError("invalid verified gateway principal")
    if (type(deadline_seconds) not in {int, float} or not math.isfinite(deadline_seconds)
            or not 0 < deadline_seconds <= 300):
        raise ValueError("invalid gateway request deadline")
    if call_timeout_seconds is not None and (type(call_timeout_seconds) not in {int, float} or not math.isfinite(call_timeout_seconds) or not 0 < call_timeout_seconds <= 120):
        raise ValueError("invalid gateway call timeout")
    call_token = _call_timeout.set(call_timeout_seconds)
    token = _verified_user.set(principal_id)
    deadline = time.monotonic() + deadline_seconds
    inherited_deadline = _deadline.get()
    if inherited_deadline is not None:
        deadline = min(deadline, inherited_deadline)
    deadline_token = _deadline.set(deadline)
    try:
        yield
    finally:
        _call_timeout.reset(call_token)
        _verified_user.reset(token)
        _deadline.reset(deadline_token)



class ModelGatewayError(RuntimeError):
    """Internal model-gateway call failed or violated its response contract."""

    def __init__(self, message: str, *, status: int = 503, retry_after: int = 1, code: str = "ai_gateway_unavailable"):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after
        self.code = code if code in {"ai_gateway_unavailable", "provider_rate_limited", "ai_rate_limited"} else "ai_gateway_unavailable"


class ModelGatewayClient:
    """Embeddings, reranking, and answer generation over an internal HTTP API.

    The sibling Go model gateway implements native Voyage and Anthropic calls.
    Provider credentials remain isolated from the knowledge service.
    """

    def __init__(self, *, base_url: str, task_token: str | Callable[[str], str], timeout_seconds: float = 20.0, allow_mesh_http: bool = False):
        parsed = urlsplit(base_url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("model gateway URL is invalid")
        mesh = (allow_mesh_http is True and parsed.scheme == "http"
                and parsed.netloc == "model-gateway.greenguard.svc.cluster.local:8080"
                and parsed.path in {"", "/"})
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"} and not mesh:
            raise ValueError("model gateway requires HTTPS or the explicit mesh service origin")
        if (not callable(task_token) and (not task_token or len(task_token) > 4096)) or timeout_seconds <= 0:
            raise ValueError("model gateway credentials or timeout are invalid")
        self._base_url = base_url.rstrip("/")
        self._task_token = task_token
        self._timeout = timeout_seconds

    def _post(self, path: str, body: dict[str, Any], *, tenant_id: str) -> dict[str, Any]:
        token = self._task_token(tenant_id) if callable(self._task_token) else self._task_token
        if not token or len(token) > 4096:
            raise ModelGatewayError("no model-gateway task token for tenant")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", **outbound_trace_headers()}
        if principal := _verified_user.get():
            headers["X-AI-Principal-ID"] = principal
        timeout = _call_timeout.get() or self._timeout
        if deadline := _deadline.get():
            timeout = min(timeout, deadline - time.monotonic())
            if timeout <= 0:
                raise ModelGatewayError("model gateway deadline exceeded")
            headers["X-AI-Timeout-Ms"] = str(max(1, min(120000, int(timeout * 1000))))
        request = Request(
            f"{self._base_url}{path}", data=json.dumps(body, separators=(",", ":")).encode(),
            headers=headers, method="POST",
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read(4_000_001))
        except HTTPError as exc:
            try:
                retry = max(1, min(3600, int(exc.headers.get("Retry-After", "1"))))
            except (ValueError, TypeError):
                retry = 1
            policy_rejected = False
            failure_code = "ai_gateway_unavailable"
            if exc.code in {422, 429}:
                try:
                    detail = json.loads(exc.read(4096))
                    policy_rejected = isinstance(detail, dict) and detail.get('error') == 'prompt_injection_blocked'
                    if exc.code == 429 and isinstance(detail, dict):
                        upstream = detail.get('error')
                        failure_code = "provider_rate_limited" if upstream in {
                            "provider_rate_limited", "provider_rate_or_concurrency_limited"
                        } else "ai_rate_limited"
                except (ValueError, OSError):
                    pass
            exc.close()
            if policy_rejected:
                raise PromptInjectionError(('gateway_policy',)) from exc
            raise ModelGatewayError("model gateway request failed", status=429 if exc.code == 429 else 503, retry_after=retry, code=failure_code) from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise ModelGatewayError("model gateway request failed") from exc
        if not isinstance(payload, dict):
            raise ModelGatewayError("model gateway returned an invalid response")
        return payload

    def embed(self, texts: list[str], *, tenant_id: str, model: str, input_type: str) -> list[list[float]]:
        if (input_type not in {"query", "passage"} or not texts or len(texts) > 256
                or any(not isinstance(text, str) or not text or len(text) > 12000 for text in texts)):
            raise ValueError("embedding input is invalid")
        payload = self._post("/v1/embeddings", {
            "tenant_id": tenant_id, "model": model, "input": texts, "input_type": input_type,
        }, tenant_id=tenant_id)
        data = payload.get("data")
        if not isinstance(data, list) or len(data) != len(texts):
            raise ModelGatewayError("embedding response count does not match input")
        vectors: list[list[float]] = []
        for index, row in enumerate(data):
            if not isinstance(row, dict) or row.get("index") != index or not isinstance(row.get("embedding"), list):
                raise ModelGatewayError("embedding response ordering is invalid")
            vector = row["embedding"]
            if not vector or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in vector):
                raise ModelGatewayError("embedding response contains invalid values")
            vectors.append([float(value) for value in vector])
        if len({len(vector) for vector in vectors}) != 1:
            raise ModelGatewayError("embedding dimensions do not match")
        return vectors

    def rerank(self, query: str, documents: list[str], *, tenant_id: str, model: str, top_n: int) -> list[int]:
        if not query or not documents or len(documents) > 50 or not 1 <= top_n <= len(documents):
            raise ValueError("rerank request is invalid")
        payload = self._post("/v1/rerank", {
            "tenant_id": tenant_id, "model": model, "query": query, "documents": documents, "top_n": top_n,
        }, tenant_id=tenant_id)
        results = payload.get("results")
        if not isinstance(results, list) or len(results) != top_n:
            raise ModelGatewayError("rerank response count is invalid")
        indices = [item.get("index") for item in results if isinstance(item, dict)]
        if len(indices) != top_n or any(type(index) is not int or not 0 <= index < len(documents) for index in indices) or len(set(indices)) != len(indices):
            raise ModelGatewayError("rerank response indices are invalid")
        return indices

    def answer(self, question: str, context: list[dict[str, Any]], *, tenant_id: str, model: str) -> dict[str, Any]:
        if not question or not context or len(context) > 8:
            raise ValueError("answer request is invalid")
        payload = self._post("/v1/answers", {
            "tenant_id": tenant_id, "model": model, "question": question, "context": context,
            "citation_contract": "Return JSON with answer and cited_chunk_ids; cite only supplied chunk_id values.",
        }, tenant_id=tenant_id)
        answer = payload.get("answer")
        citations = payload.get("cited_chunk_ids")
        if not isinstance(answer, str) or not answer.strip() or len(answer) > 12000 or not isinstance(citations, list):
            raise ModelGatewayError("answer response does not match the citation contract")
        return {"answer": answer.strip(), "cited_chunk_ids": citations}

    def plan(self, question: str, *, tenant_id: str, model: str) -> dict[str, Any]:
        from .text_sql import plan_question, validate_plan
        plan_question(question)
        if _verified_user.get() is None:
            raise PermissionError("structured planning requires a verified principal")
        payload = self._post("/v1/structured/plan", {
            "tenant_id": tenant_id, "model": model, "question": question,
        }, tenant_id=tenant_id)
        try:
            plan = validate_plan(payload)
        except ValueError as exc:
            raise ModelGatewayError("invalid structured planner response") from exc
        return {"operation": plan.operation, "status": plan.status}
