"""Small authenticated HTTP boundary for tenant-scoped document ingest and RAG."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import hmac
import io
import json
import re
import socket
import threading
import time
from datetime import datetime, timezone
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import urlsplit, unquote, quote
from uuid import UUID

from .service import KnowledgeRagService, SuggestionIdempotencyConflict
from .trace_context import incoming_trace_context
from .model_gateway import ModelGatewayError
from .document_summary import DocumentSummaryError
from .prompt_guardrails import PromptInjectionError, require_safe_text

MAX_PDF_BYTES = 25 * 1024 * 1024
MAX_JSON_BYTES = 64 * 1024
_SOURCE_PATH = re.compile(r"^/v1/documents/([0-9a-f-]{36})/versions/([1-9][0-9]*)/(source|source-info)$")
_SUMMARY_JOB_PATH = re.compile(r"^/v1/assistant/summary-jobs/([0-9a-f-]{36})$")
_DOC_PATH = re.compile(r"^/v1/documents/([0-9a-f-]{36})$")
_STATUS_PATH = re.compile(r"^/v1/documents/([0-9a-f-]{36})/versions/([1-9][0-9]*)$")
_OPS_PATH = re.compile(r"^/v1/ops/(overview|retrieval|documents|evaluations|cache|traces)$")
_SUGGESTION_USED_PATH = re.compile(r"^/v1/assistant/suggestions/([a-z][a-z0-9_]{0,63})/used$")
_SUGGESTION_IDS = frozenset({"grain_moisture", "storage_checks", "mold_risk", "grain_drying", "document_summary"})
_CONVERSATION_PATH = re.compile(r"^/v1/assistant/conversations/([0-9a-f-]{36})$")
_CONVERSATION_MESSAGES_PATH = re.compile(r"^/v1/assistant/conversations/([0-9a-f-]{36})/messages$")


@dataclass(frozen=True, slots=True)
class ApiPrincipal:
    tenant_id: str
    principal_id: str
    role: str
    read_only: bool = False


class ApiError(ValueError):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status


def load_access_bindings(path: str) -> dict[str, ApiPrincipal]:
    """Read loopback fixture token digests; never used by the production entry point."""
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    if not isinstance(raw, dict) or not raw:
        raise ValueError("knowledge API access file must be a non-empty JSON object")
    result: dict[str, ApiPrincipal] = {}
    for digest, claims in raw.items():
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) or not isinstance(claims, dict):
            raise ValueError("knowledge API access binding is invalid")
        tenant, principal, role = claims.get("tenant_id"), claims.get("principal_id"), claims.get("role")
        if not _canonical_uuid(tenant) or not _canonical_uuid(principal) or role not in {"viewer", "operator", "admin"}:
            raise ValueError("knowledge API access identity is invalid")
        result[digest] = ApiPrincipal(tenant, principal, role)
    return result


def _canonical_uuid(value: Any) -> bool:
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def create_server(
    *, service: KnowledgeRagService, access_bindings: dict[str, ApiPrincipal] | None = None,
    authenticator: Callable[[str, str], ApiPrincipal] | None = None,
    host: str = "127.0.0.1", port: int = 8080,
) -> ThreadingHTTPServer:
    if authenticator is None and (not access_bindings or host not in {"127.0.0.1", "::1"}):
        raise ValueError("static bearer fixtures are limited to explicit loopback servers")
    if authenticator is not None and access_bindings is not None:
        raise ValueError("configure exactly one authentication mechanism")

    class Handler(BaseHTTPRequestHandler):
        server_version = "GreenGuardKnowledge/1"

        def log_message(self, fmt: str, *args: Any) -> None:
            # Request paths and bodies may contain sensitive document metadata.
            return

        def _json(self, status: int, value: Any, retry_after: int | None = None) -> None:
            body = json.dumps(value, separators=(",", ":"), default=lambda item: item.isoformat() if isinstance(item, datetime) else str(item)).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if retry_after is not None:
                self.send_header("Retry-After", str(retry_after))
            if status == 401:
                self.send_header("WWW-Authenticate", 'Bearer realm="greenguard-knowledge"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _principal(self) -> ApiPrincipal:
            if len(self.headers.get_all("Authorization", [])) != 1:
                raise ApiError(401, "unauthorized")
            header = self.headers.get("Authorization", "")
            if authenticator is not None:
                if len(self.headers.get_all("X-Tenant-ID", [])) != 1:
                    raise ApiError(400, "invalid_tenant_selector")
                return authenticator(header, self.headers.get("X-Tenant-ID", ""))
            match = re.fullmatch(r"(?i:Bearer) ([^\s]+)", header)
            if not match:
                raise ApiError(401, "unauthorized")
            digest = sha256(match.group(1).encode()).hexdigest()
            for expected, principal in (access_bindings or {}).items():
                if hmac.compare_digest(expected, digest):
                    return principal
            raise ApiError(401, "unauthorized")

        def _body(self, limit: int) -> bytes:
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError as exc:
                raise ApiError(400, "invalid_content_length") from exc
            if length < 0 or length > limit:
                raise ApiError(413, "request_too_large")
            deadline=time.monotonic()+30
            body=io.BytesIO()
            while body.tell()<length:
                remaining=deadline-time.monotonic()
                if remaining<=0:
                    raise ApiError(408,"request_timeout")
                self.connection.settimeout(remaining)
                try:
                    block=self.rfile.read1(min(65536,length-body.tell()))
                except (TimeoutError,socket.timeout) as exc:
                    raise ApiError(408,"request_timeout") from exc
                if not block:
                    raise ApiError(400,"incomplete_body")
                body.write(block)
            return body.getvalue()

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/healthz":
                self._json(200, {"status": "ok"}); return
            if path == "/readyz":
                if self.server.draining:
                    self._json(503, {"status": "draining"}); return
                try:
                    with service._connect() as connection:
                        connection.execute("SELECT 1").fetchone()
                    owner_readiness = getattr(authenticator, "check_readiness", None)
                    if callable(owner_readiness):
                        owner_readiness()
                    self._json(200, {"status": "ready"})
                except Exception:
                    self._json(503, {"status": "not_ready"})
                return
            if self.server.draining:
                self._json(503, {"error": "draining"}); return
            try:
                principal = self._principal()
                ops_match = _OPS_PATH.fullmatch(path)
                if ops_match:
                    if principal.role not in {"operator", "admin"}:
                        raise ApiError(403, "forbidden")
                    self._ops(principal, ops_match.group(1))
                    return
                job_match = _SUMMARY_JOB_PATH.fullmatch(path)
                if job_match:
                    from .summary_jobs import get_summary_job
                    with service._connect() as connection:
                        result = get_summary_job(connection, tenant_id=principal.tenant_id, principal_id=principal.principal_id, principal_role=principal.role, job_id=job_match.group(1), require_membership=bool(authenticator is not None and getattr(authenticator, "uses_database_membership", True)))
                    self._json(200, result)
                    return
                if path == "/v1/documents":
                    from .document_access import list_documents
                    with service._connect() as connection:
                        documents = list_documents(connection, tenant_id=principal.tenant_id, principal_id=principal.principal_id, principal_role=principal.role)
                    self._json(200, {"documents": documents})
                    return
                if path == "/v1/assistant/conversations":
                    self._conversations_list(principal)
                    return
                conversation_match = _CONVERSATION_PATH.fullmatch(path)
                if conversation_match:
                    self._conversation_get(principal, conversation_match.group(1))
                    return
                source_match = _SOURCE_PATH.fullmatch(path)
                if source_match:
                    self._source_pdf(principal, source_match.group(1), int(source_match.group(2)), source_match.group(3) == "source-info")
                    return
                match = _STATUS_PATH.fullmatch(path)
                if not match or not _canonical_uuid(match.group(1)):
                    self._json(404, {"error": "not_found"}); return
                status = service.document_status(tenant_id=principal.tenant_id,
                                                 document_id=match.group(1),
                                                 document_version=int(match.group(2)),
                                                 principal_id=principal.principal_id, principal_role=principal.role)
                if status is None:
                    self._json(404, {"error": "not_found"})
                else:
                    self._json(200, status)
            except (ApiError, DocumentSummaryError) as exc:
                self._json(exc.status, {"error": str(exc)})
            except (ValueError, UnicodeError):
                self._json(400, {"error": "invalid_request"})
            except Exception:
                self._json(503, {"error": "knowledge_service_unavailable"})

        @incoming_trace_context
        def do_POST(self) -> None:
            if self.server.draining:
                self._json(503,{"error":"draining"})
                return
            try:
                principal = self._principal()
                path = urlsplit(self.path).path
                if principal.read_only and path not in {"/v1/query", "/v1/structured/authorize"}:
                    raise ApiError(403, "forbidden")
                if path == "/v1/assistant/summary-jobs":
                    from .summary_jobs import create_summary_job
                    data = json.loads(self._body(MAX_JSON_BYTES).decode("utf-8"))
                    if not isinstance(data, dict) or set(data) != {"document_id", "document_version", "question", "idempotency_key"}:
                        raise ApiError(400, "invalid_request")
                    with service._connect() as connection:
                        result = create_summary_job(connection, tenant_id=principal.tenant_id, principal_id=principal.principal_id, principal_role=principal.role, answer_model=service._answer_model, require_membership=bool(authenticator is not None and getattr(authenticator, "uses_database_membership", True)), **data)
                    self._json(202, result)
                    return
                if path == "/v1/structured/authorize":
                    self._structured_authorize(principal)
                    return
                if path == "/v1/query":
                    self._query(principal)
                    return
                suggestion_match = _SUGGESTION_USED_PATH.fullmatch(path)
                if suggestion_match:
                    self._suggestion_used(principal, suggestion_match.group(1))
                    return
                if path == "/v1/assistant/conversations":
                    self._conversation_create(principal)
                    return
                conversation_message_match = _CONVERSATION_MESSAGES_PATH.fullmatch(path)
                if conversation_message_match:
                    self._conversation_message(principal, conversation_message_match.group(1))
                    return
                match = _DOC_PATH.fullmatch(path)
                if match:
                    self._ingest(principal, match.group(1))
                    return
                self._json(404, {"error": "not_found"})
            except ApiError as exc:
                self._json(exc.status, {"error": str(exc)})
            except DocumentSummaryError as exc:
                self._json(exc.status, {"error": exc.code})
            except PromptInjectionError:
                self._json(422, {"error": "prompt_injection_blocked"})
            except ModelGatewayError as exc:
                print("knowledge_gateway_failed status=" + str(exc.status), flush=True)
                code = "provider_rate_limited" if getattr(exc, "code", None) == "provider_rate_limited" else "ai_gateway_unavailable"
                self._json(exc.status, {"error": code}, exc.retry_after)
            except PermissionError:
                self._json(403, {"error": "forbidden"})
            except SuggestionIdempotencyConflict:
                self._json(409, {"error": "idempotency_conflict"})
            except (ValueError, json.JSONDecodeError):
                self._json(400, {"error": "invalid_request"})
            except Exception as exc:
                print("knowledge_request_failed type=" + type(exc).__name__, flush=True)
                self._json(503, {"error": "knowledge_service_unavailable"})

        def do_DELETE(self) -> None:
            if self.server.draining:
                self._json(503, {"error": "draining"}); return
            try:
                principal = self._principal()
                if principal.read_only:
                    raise ApiError(403, "forbidden")
                job_match = _SUMMARY_JOB_PATH.fullmatch(urlsplit(self.path).path)
                if job_match:
                    from .summary_jobs import get_summary_job
                    with service._connect() as connection:
                        result = get_summary_job(connection, tenant_id=principal.tenant_id, principal_id=principal.principal_id, principal_role=principal.role, job_id=job_match.group(1), cancel=True, require_membership=bool(authenticator is not None and getattr(authenticator, "uses_database_membership", True)))
                    self._json(200, result)
                    return
                document_match = _DOC_PATH.fullmatch(urlsplit(self.path).path)
                if document_match:
                    from .document_access import delete_document
                    with service._connect() as connection:
                        result = delete_document(connection, tenant_id=principal.tenant_id, principal_id=principal.principal_id, principal_role=principal.role, document_id=document_match.group(1), require_membership=bool(authenticator is not None and getattr(authenticator, "uses_database_membership", True)))
                    self._json(200, result)
                    return
                match = _CONVERSATION_PATH.fullmatch(urlsplit(self.path).path)
                if not match or not _canonical_uuid(match.group(1)) or not _canonical_uuid(principal.principal_id):
                    self._json(404, {"error": "not_found"}); return
                from .conversation_store import soft_delete_conversation
                with service._connect() as connection:
                    deleted = soft_delete_conversation(connection, tenant_id=principal.tenant_id,
                                                       principal_id=principal.principal_id,
                                                       conversation_id=match.group(1))
                if not deleted:
                    self._json(404, {"error": "not_found"}); return
                self._json(200, {"deleted": True})
            except (ApiError, DocumentSummaryError) as exc:
                self._json(exc.status, {"error": str(exc)})
            except (ValueError, UnicodeError):
                self._json(400, {"error": "invalid_request"})
            except Exception:
                self._json(503, {"error": "knowledge_service_unavailable"})

        def _source_pdf(self, principal, document_id, version, metadata_only):
            if metadata_only:
                return self._serve_source_pdf(principal, document_id, version, True)
            if not self.server._download_slots.acquire(blocking=False):
                raise ApiError(503, "source_capacity_exhausted")
            try:
                return self._serve_source_pdf(principal, document_id, version, False)
            finally:
                self.server._download_slots.release()

        def _serve_source_pdf(self, principal, document_id, version, metadata_only):
            from .document_access import load_pdf_source
            def load(current):
                with service._connect() as connection:
                    return load_pdf_source(connection, tenant_id=current.tenant_id, principal_id=current.principal_id,
                        principal_role=current.role, document_id=document_id, document_version=version,
                        require_membership=bool(authenticator is not None and getattr(authenticator, "uses_database_membership", True)))
            info = load(principal)
            if metadata_only:
                self._json(200, {"filename": info["filename"], "document_id": document_id, "document_version": version})
                return
            if service._object_store is None:
                raise ApiError(503, "source_unavailable")
            data = service._object_store.get_pdf(info["key"])
            if not data.startswith(b"%PDF-") or sha256(data).hexdigest() != info["sha256"]:
                raise ApiError(503, "source_unavailable")
            current = self._principal()
            if (current.tenant_id, current.principal_id) != (principal.tenant_id, principal.principal_id) or load(current) != info:
                raise ApiError(404, "not_found")
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", "inline; filename*=UTF-8''" + quote(info["filename"], safe=""))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def _ingest(self, principal: ApiPrincipal, document_id: str) -> None:
            if principal.role not in {"operator", "admin"}:
                raise ApiError(403, "forbidden")
            from .outline import _valid_uuid
            if not _canonical_uuid(document_id) or not _valid_uuid(document_id):
                raise ApiError(400, "invalid_document_id")
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/pdf":
                raise ApiError(415, "pdf_required")
            try:
                version = int(self.headers.get("X-Document-Version", ""))
            except ValueError as exc:
                raise ApiError(400, "invalid_document_version") from exc
            if version < 1:
                raise ApiError(400, "invalid_document_version")
            if not self.server._upload_slots.acquire(blocking=False):
                raise ApiError(503, "upload_capacity_exhausted")
            try:
                pdf = self._body(MAX_PDF_BYTES)
                if not pdf.startswith(b"%PDF-"):
                    raise ApiError(415, "pdf_required")
                def reauthorize():
                    current = self._principal()
                    if (current.tenant_id, current.principal_id) != (principal.tenant_id, principal.principal_id):
                        raise ApiError(403, "identity_changed")
                    if current.role not in {"operator", "admin"}:
                        raise ApiError(403, "membership_required")
                    return current.role
                result = service.ingest_pdf(
                    tenant_id=principal.tenant_id, document_id=document_id,
                    document_version=version, pdf_bytes=pdf, min_role="viewer",
                    source_file_name=unquote(self.headers["X-PDF-Filename"], errors="strict") if "X-PDF-Filename" in self.headers else None,
                    principal_id=principal.principal_id, principal_role=principal.role,
                    reauthorize=reauthorize,
                )
                self._json(202, {
                    "document_id": result.document_id,
                    "document_version": result.document_version,
                    "status": "queued",
                    "idempotent": result.idempotent,
                    "event_id": result.event_id,
                })
            finally:
                self.server._upload_slots.release()

        def _query(self, principal: ApiPrincipal) -> None:
            raw = self._body(MAX_JSON_BYTES)
            try:
                request = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ApiError(400, "invalid_json") from exc
            if not isinstance(request, dict) or set(request) - {"question", "candidate_k", "context_k", "mode", "document_id", "document_version"}:
                raise ApiError(400, "invalid_request")
            question = request.get("question")
            if not isinstance(question, str) or not 4 <= len(question.strip()) <= 2000:
                raise ApiError(400, "invalid_question")
            require_safe_text(question)
            summary_scope = self._summary_scope(request)
            candidate_k = request.get("candidate_k", 20)
            context_k = request.get("context_k", min(5, candidate_k) if type(candidate_k) is int else 5)
            def reauthorize():
                current = self._principal()
                if (current.tenant_id, current.principal_id) != (principal.tenant_id, principal.principal_id):
                    raise ApiError(403, "identity_changed")
                return current.role
            answer = self._ask_with_ops(
                principal, question=question, candidate_k=candidate_k,
                context_k=context_k, reauthorize=reauthorize, **summary_scope,
            )
            self._json(200, {"answer": answer.answer, "citations": answer.citations,
                             "retrieval": answer.retrieval,
                             **({"structured_evidence":answer.structured_evidence} if getattr(answer,"structured_evidence",None) is not None else {})})

        def _structured_authorize(self, principal):
            from .text_sql import authorize_evidence
            request = json.loads(self._body(MAX_JSON_BYTES))
            if type(request) is not dict or set(request) - {"evidence", "document_id", "document_version"} or "evidence" not in request:
                raise ApiError(400, "invalid_request")
            scope = self._summary_scope({"mode":"structured", **{key:request[key] for key in ("document_id", "document_version") if key in request}})
            scope.pop("mode", None)
            def reauthorize():
                current = self._principal()
                if (current.tenant_id,current.principal_id) != (principal.tenant_id,principal.principal_id):
                    raise ApiError(403, "identity_changed")
                return current.role
            with service._connect() as connection:
                result = authorize_evidence(connection, evidence=request["evidence"], tenant_id=principal.tenant_id,
                    principal_id=principal.principal_id, principal_role=principal.role, reauthorize=reauthorize,
                    require_database_membership=bool(authenticator is not None and getattr(authenticator, "uses_database_membership", True)), **scope)
            self._json(200, result)

        def _summary_scope(self, request: dict) -> dict:
            mode = request.get("mode", "question")
            if not isinstance(mode, str) or mode not in {"question", "document_summary", "structured"}:
                raise ApiError(400, "invalid_request")
            if mode in {"question", "structured"} and "document_id" not in request and "document_version" not in request:
                return {"mode": mode} if mode == "structured" else {}
            if (not _canonical_uuid(request.get("document_id"))
                    or type(request.get("document_version")) is not int
                    or not 1 <= request["document_version"] <= 2147483647):
                raise ApiError(400, "invalid_request")
            return {"mode": mode, "document_id": request["document_id"],
                    "document_version": request["document_version"]}

        def _ask_with_ops(self, principal: ApiPrincipal, **kwargs):
            """Record bounded metadata for every RAG entry point; never record text."""
            started = time.monotonic()
            summary = {
                "tenant_id": principal.tenant_id,
                "request_id": str(UUID(bytes=__import__('os').urandom(16), version=4)),
                "at": time.time(), "status": "failed", "retrieval": {}, "citations": [], "citation_count": 0,
            }
            try:
                database_membership = bool(authenticator is not None and getattr(authenticator, "uses_database_membership", True))
                answer = service.ask(
                    tenant_id=principal.tenant_id, principal_id=principal.principal_id,
                    principal_role=principal.role,
                    require_membership=database_membership,
                    require_database_membership=database_membership, **kwargs,
                )
                summary.update({
                    "status": "ok",
                    "retrieval": {key: value for key, value in answer.retrieval.items()
                                  if key in {"dense", "fts", "pageindex", "knowledge_graph", "fused",
                                             "hydrated", "reranked", "guardrail_blocked_context",
                                             "summary_chunks", "summary_batches", "summary_pages"}
                                  and type(value) is int and value >= 0},
                    # Operators can inspect aggregate behavior without learning
                    # document identifiers granted to another principal's ACL.
                    "citation_count": len(answer.citations),
                    "empty": not answer.citations,
                })
                return answer
            finally:
                summary["latency_ms"] = round((time.monotonic() - started) * 1000)
                self.server._ops_queries.append(summary)

        def _suggestion_used(self, principal: ApiPrincipal, suggestion_id: str) -> None:
            if suggestion_id not in _SUGGESTION_IDS:
                raise ApiError(404, "not_found")
            # The authenticated membership lookup performed by _principal is the
            # identity/tenant check. Viewers are sufficient to use suggestions.
            key = self.headers.get("Idempotency-Key", "")
            if not _canonical_uuid(key):
                raise ApiError(400, "invalid_idempotency_key")
            result = service.record_suggestion_usage(
                tenant_id=principal.tenant_id,
                suggestion_id=suggestion_id,
                idempotency_key=key,
            )
            self._json(200, result)

        def _conversations_list(self, principal: ApiPrincipal) -> None:
            if not _canonical_uuid(principal.principal_id):
                raise ApiError(403, "forbidden")
            from .conversation_store import list_conversations
            with service._connect() as connection:
                rows = list_conversations(connection, tenant_id=principal.tenant_id,
                                          principal_id=principal.principal_id)
            self._json(200, {"items": [{
                "id": row["conversation_id"], "title": row["title"],
                "updated_at": row["updated_at"], "last_message_at": row["last_message_at"],
            } for row in rows]})

        def _conversation_create(self, principal: ApiPrincipal) -> None:
            if not _canonical_uuid(principal.principal_id):
                raise ApiError(403, "forbidden")
            try:
                request = json.loads(self._body(8192))
            except json.JSONDecodeError as exc:
                raise ApiError(400, "invalid_json") from exc
            if not isinstance(request, dict) or set(request) - {"title"}:
                raise ApiError(400, "invalid_request")
            title = request.get("title", "New chat")
            if not isinstance(title, str) or not title.strip() or len(title) > 2_000:
                raise ApiError(400, "invalid_title")
            from .conversation_store import create_conversation
            with service._connect() as connection:
                row = create_conversation(connection, tenant_id=principal.tenant_id,
                                          principal_id=principal.principal_id, title=title)
            self._json(201, {
                "id": row["conversation_id"], "title": row["title"],
                "updated_at": row["updated_at"], "last_message_at": row["last_message_at"],
            })

        def _conversation_get(self, principal: ApiPrincipal, conversation_id: str) -> None:
            if not _canonical_uuid(conversation_id) or not _canonical_uuid(principal.principal_id):
                self._json(404, {"error": "not_found"}); return
            from .conversation_store import get_conversation
            with service._connect() as connection:
                row = get_conversation(connection, tenant_id=principal.tenant_id,
                                       principal_id=principal.principal_id,
                                       conversation_id=conversation_id)
            if row is None:
                self._json(404, {"error": "not_found"}); return
            self._json(200, {
                "conversation": {
                    "id": row["conversation_id"], "title": row["title"],
                    "updated_at": row["updated_at"], "last_message_at": row["last_message_at"],
                },
                "messages": [{
                    "id": message["message_id"], "role": message["role"],
                    "content": message["content"], "created_at": message["created_at"],
                    "citations": message["citations"],
                } for message in row["messages"]],
            })

        def _conversation_message(self, principal: ApiPrincipal, conversation_id: str) -> None:
            if not _canonical_uuid(conversation_id) or not _canonical_uuid(principal.principal_id):
                self._json(404, {"error": "not_found"}); return
            try:
                request = json.loads(self._body(MAX_JSON_BYTES))
            except json.JSONDecodeError as exc:
                raise ApiError(400, "invalid_json") from exc
            if not isinstance(request, dict) or "question" not in request or set(request) - {"question", "mode", "document_id", "document_version"}:
                raise ApiError(400, "invalid_request")
            question = request["question"]
            if not isinstance(question, str) or not 4 <= len(question.strip()) <= 2000:
                raise ApiError(400, "invalid_question")
            require_safe_text(question)

            summary_scope = self._summary_scope(request)

            # Verify ownership before invoking embeddings, retrieval, or an LLM.
            # append_turn repeats the check under lock to cover deletion races.
            from .conversation_store import conversation_exists
            with service._connect() as connection:
                if not conversation_exists(connection, tenant_id=principal.tenant_id,
                                           principal_id=principal.principal_id,
                                           conversation_id=conversation_id):
                    self._json(404, {"error": "not_found"}); return

            def reauthorize():
                current = self._principal()
                if (current.tenant_id, current.principal_id) != (principal.tenant_id, principal.principal_id):
                    raise ApiError(403, "identity_changed")
                return current.role

            # Provider calls run without a DB transaction; persist a complete turn atomically afterwards.
            answer = self._ask_with_ops(principal, question=question, reauthorize=reauthorize, **summary_scope)
            from .conversation_store import append_turn
            with service._connect() as connection:
                try:
                    ids = append_turn(
                        connection, tenant_id=principal.tenant_id,
                        principal_id=principal.principal_id,
                        conversation_id=conversation_id, question=question,
                        answer=answer.answer,
                        citations=[dict(citation) for citation in answer.citations],
                    )
                except LookupError:
                    self._json(404, {"error": "not_found"}); return
            now = datetime.now(timezone.utc).isoformat()
            self._json(200, {
                "user_message": {"id": ids["user_message_id"], "role": "user", "content": question.strip(), "created_at": now, "citations": []},
                "assistant_message": {"id": ids["assistant_message_id"], "role": "assistant", "content": answer.answer, "created_at": now, "citations": list(answer.citations)},
            })

        def _ops(self, principal: ApiPrincipal, section: str) -> None:
            rows = [{key: value for key, value in row.items() if key not in {"tenant_id", "citations"}} | {"citations": []}
                    for row in list(self.server._ops_queries) if row["tenant_id"] == principal.tenant_id]
            if section == "traces" or section == "retrieval":
                self._json(200, {"items": rows[-100:], "source": "process-local recent telemetry"})
                return
            if section == "documents":
                with service._connect() as connection:
                    with connection.transaction():
                        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (principal.tenant_id,))
                        result = connection.execute(
                            """SELECT d.document_id::text, d.current_version, d.latest_version,
                                      v.document_version, v.processing_status, v.created_at,
                                      (SELECT count(*) FROM knowledge_chunks c WHERE c.tenant_id=d.tenant_id
                                        AND c.document_id=d.document_id AND c.document_version=v.document_version) AS chunk_count
                               FROM knowledge_documents d JOIN knowledge_document_versions v USING (tenant_id,document_id)
                               WHERE d.tenant_id=%s AND d.deleted_at IS NULL
                                 AND (CASE d.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END)
                                     <= (CASE %s WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 WHEN 'admin' THEN 3 ELSE 0 END)
                                 AND (cardinality(d.acl_principals)=0 OR %s::uuid=ANY(d.acl_principals))
                                 AND (CASE v.min_role WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END)
                                     <= (CASE %s WHEN 'viewer' THEN 1 WHEN 'operator' THEN 2 WHEN 'admin' THEN 3 ELSE 0 END)
                                 AND (cardinality(v.acl_principals)=0 OR %s::uuid=ANY(v.acl_principals))
                               ORDER BY v.created_at DESC LIMIT 100""",
                            (principal.tenant_id, principal.role, principal.principal_id,
                             principal.role, principal.principal_id)
                        ).fetchall()
                self._json(200, {"items": [{"document_id": r[0], "current_version": r[1],
                    "latest_version": r[2], "version": r[3], "status": r[4],
                    "created_at": r[5].isoformat(), "chunk_count": r[6]} for r in result]})
                return
            if section == "evaluations":
                from .operations_reports import evaluation_snapshot
                self._json(200, evaluation_snapshot(getattr(service, '_evaluation_report_file', None)))
                return
            if section == "cache":
                cache = getattr(service, '_retrieval_cache', None)
                self._json(200, cache.snapshot(principal.tenant_id) if cache is not None and hasattr(cache, 'snapshot') else {
                    "available": False, "redis": "not_configured", "hit_ratio": None,
                    "note": "Knowledge retrieval and embedding caches are not configured."})
                return
            latencies = sorted(row["latency_ms"] for row in rows)
            def percentile(p):
                return latencies[min(len(latencies)-1, int((len(latencies)-1)*p))] if latencies else None
            successes = sum(row["status"] == "ok" for row in rows)
            with service._connect() as connection:
                connection.execute("SELECT 1").fetchone()
            self._json(200, {"health": "ready", "telemetry_window": "last 5000 requests per service process",
                "query_count": len(rows),
                "success_rate": (successes / len(rows)) if rows else None,
                "empty_result_rate": (sum(bool(row.get("empty")) for row in rows if row["status"] == "ok") / successes) if successes else None,
                "latency_ms": {"p50": percentile(.50), "p95": percentile(.95), "p99": percentile(.99)},
                "embedding_model": service._embedding_model, "reranker_model": service._reranker_model,
                "answer_model": service._answer_model, "index_version": "not_versioned",
                "cache": "configured" if getattr(service, "_retrieval_cache", None) is not None else "not_configured", "metrics_source": "bounded process-local summaries"})

    class BoundedServer(ThreadingHTTPServer):
        daemon_threads = True
        request_queue_size = 64

        def __init__(self, address: tuple[str, int], handler: Any):
            self._slots = threading.BoundedSemaphore(32)
            self._upload_slots = threading.BoundedSemaphore(2)
            self._download_slots = threading.BoundedSemaphore(2)
            self._ops_queries = deque(maxlen=5000)
            self.draining = False
            self._handler_condition=threading.Condition()
            self._active_handlers=0
            super().__init__(address, handler)

        def get_request(self) -> tuple[socket.socket, Any]:
            request, address = super().get_request()
            request.settimeout(30)
            return request, address

        def process_request(self, request: socket.socket, client_address: Any) -> None:
            if not self._slots.acquire(blocking=False):
                try:
                    request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                finally:
                    self.shutdown_request(request)
                return
            with self._handler_condition:
                self._active_handlers+=1
            try:
                super().process_request(request, client_address)
            except Exception:
                self._slots.release()
                with self._handler_condition:
                    self._active_handlers-=1
                    self._handler_condition.notify_all()
                raise

        def process_request_thread(self, request: socket.socket, client_address: Any) -> None:
            try:
                super().process_request_thread(request, client_address)
            finally:
                self._slots.release()
                with self._handler_condition:
                    self._active_handlers-=1
                    self._handler_condition.notify_all()

        def wait_for_handlers(self,timeout: float) -> None:
            deadline=time.monotonic()+timeout
            with self._handler_condition:
                while self._active_handlers:
                    remaining=deadline-time.monotonic()
                    if remaining<=0:
                        break
                    self._handler_condition.wait(remaining)

    return BoundedServer((host, port), Handler)
