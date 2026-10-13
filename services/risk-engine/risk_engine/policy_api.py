"""Owner API adapter for authenticated tenant policy publication and reads."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, urlsplit

from risk_engine.policy import PolicyVersion
from risk_engine.policy_auth import AuthenticationError, OIDCVerifier
from risk_engine.policy_service import PolicyService
from risk_engine.store import StoreError

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_FIELDS = frozenset({
    "policy_id", "version", "grain_type", "bin_id", "effective_from", "effective_to",
    "measurement_thresholds", "risk_thresholds", "calibrated", "status", "provenance",
    "calibration_evidence", "approved_by", "approved_at",
})


def _time(value: object, name: str, nullable: bool = False) -> datetime | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"{name} must be a UTC timestamp ending in Z")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError(f"{name} must be an ISO timestamp") from error
    if parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValueError(f"{name} must be UTC")
    return parsed


def _validate_policy_objects(body) -> None:
    for key in ("measurement_thresholds", "risk_thresholds", "provenance"):
        if not isinstance(body[key], dict):
            raise TypeError(f"{key} must be an object")
    for key in ("calibration_evidence", "approved_by"):
        if body[key] is not None and not isinstance(body[key], str):
            raise ValueError(f"{key} must be a string or null")


def _parse_policy(body: object, tenant_id: str) -> PolicyVersion:
    if not isinstance(body, dict) or set(body) != _FIELDS:
        raise ValueError("policy fields do not match the owner contract")
    if not isinstance(body["policy_id"], str) or not _UUID.fullmatch(body["policy_id"]):
        raise ValueError("policy_id must be a canonical UUID")
    version = body["version"]
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError("version must be a positive integer")
    bin_id = body["bin_id"]
    if bin_id is not None and (not isinstance(bin_id, str) or not _UUID.fullmatch(bin_id)):
        raise ValueError("bin_id must be a canonical UUID or null")
    if not isinstance(body["grain_type"], str) or not isinstance(body["status"], str):
        raise TypeError("grain_type and status must be strings")
    if not isinstance(body["calibrated"], bool):
        raise TypeError("calibrated must be boolean")
    _validate_policy_objects(body)
    return PolicyVersion(
        tenant_id, body["policy_id"], version, body["grain_type"], bin_id,
        _time(body["effective_from"], "effective_from"),
        _time(body["effective_to"], "effective_to", nullable=True),
        body["measurement_thresholds"], body["risk_thresholds"], body["calibrated"],
        body["status"], body["provenance"], body["calibration_evidence"], body["approved_by"],
        _time(body["approved_at"], "approved_at", nullable=True),
    )


class PolicyAPI:
    def __init__(self, service: PolicyService | None, verifier: OIDCVerifier | None):
        self.service, self.verifier = service, verifier

    def handle(self, handler: Any) -> bool:
        parsed = urlsplit(handler.path)
        if parsed.path != "/v1/policies":
            return False
        if self.verifier is None:
            self._send(handler, 503, {"error": "policy_api_auth_not_configured"})
            return True
        try:
            principal = self.verifier.verify(handler.headers.get("Authorization"))
        except AuthenticationError as error:
            self._send(handler, error.status, {"error": error.code})
            return True
        if "device" in principal.roles or "admin" not in principal.roles:
            self._send(handler, 403, {"error": "admin_role_required"})
            return True
        try:
            self._dispatch(handler, parsed, principal)
        except PermissionError as error:
            self._send(handler, 403, {"error": str(error)})
        except TimeoutError:
            self._send(handler, 408, {"error": "request_timeout"})
        except (ValueError, TypeError) as error:
            self._send(handler, 400, {"error": str(error)})
        except StoreError as error:
            status = 409 if error.sqlstate and error.sqlstate.startswith("23") else 503
            self._send(handler, status, {"error": "policy_version_conflict" if status == 409 else
                                         "policy_store_unavailable"})
        return True

    def _dispatch(self, handler, parsed, principal) -> None:
        if handler.command == "POST" and not parsed.query:
            self._publish(handler, principal)
        elif handler.command == "GET" and parsed.query:
            self._effective(handler, parsed, principal)
        else:
            self._send(handler, 405, {"error": "method_not_allowed"})

    def _publish(self, handler, principal) -> None:
        length = int(handler.headers.get("Content-Length", "0"))
        if not 1 <= length <= 65536:
            self._send(handler, 413, {"error": "request_too_large"})
            return
        body = json.loads(handler.rfile.read(length))
        event = self.service.publish(principal, _parse_policy(body, principal.tenant_id))
        self._send(handler, 201, event)

    def _effective(self, handler, parsed, principal) -> None:
        query = parse_qs(parsed.query, strict_parsing=True)
        if set(query) != {"grain_type", "bin_id", "at"} or any(len(v) != 1 for v in query.values()):
            raise ValueError("query requires grain_type, bin_id and at")
        grain, bin_id = query["grain_type"][0], query["bin_id"][0]
        if bin_id == "*":
            # The zero UUID is only a lookup sentinel for a grain-wide policy.
            bin_id = "00000000-0000-0000-0000-000000000000"
        elif not _UUID.fullmatch(bin_id):
            raise ValueError("bin_id must be a UUID or *")
        policy = self.service.effective(principal, bin_id, grain, _time(query["at"][0], "at"))
        self._send(handler, 404 if policy is None else 200,
                   {"status": "not_configured"} if policy is None else
                   {"status": "configured", "policy": policy.as_dict()})

    @staticmethod
    def _send(handler: Any, status: int, value: dict[str, Any]) -> None:
        data = json.dumps(value, separators=(",", ":"), default=lambda item: item.isoformat()).encode()
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
