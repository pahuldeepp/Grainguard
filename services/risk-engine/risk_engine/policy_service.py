"""Authorized owner operations for publishing tenant policy versions.

The HTTP/API adapter must pass a verified principal; tenant_id is never accepted
from a request body or free-standing tenant header.
"""

from __future__ import annotations

import hashlib
import uuid
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from risk_engine import events
from risk_engine.policy import PolicyVersion, validate_policy

_POLICY_EVENT_NAMESPACE = uuid.UUID("94596748-83d2-4f63-9fba-2a5085dc4d87")


@dataclass(frozen=True)
class VerifiedPrincipal:
    tenant_id: str
    subject: str
    roles: frozenset[str]


class PolicyTx(Protocol):
    def create_policy(self, policy: PolicyVersion, event: dict[str, Any]) -> None: ...


class PolicyDatabase(Protocol):
    def transaction(self, tenant_id: str) -> AbstractContextManager[PolicyTx]: ...


class PolicyService:
    def __init__(self, db: PolicyDatabase, clock=lambda: datetime.now(timezone.utc)):
        self.db, self.clock = db, clock

    def publish(self, principal: VerifiedPrincipal, request: PolicyVersion) -> dict[str, Any]:
        if "operator" not in principal.roles and "admin" not in principal.roles:
            raise PermissionError("operator role required to publish policy")
        if request.tenant_id != principal.tenant_id:
            raise PermissionError("policy tenant must match the verified principal")
        if request.calibrated and ("admin" not in principal.roles or request.approved_by != principal.subject):
            raise PermissionError("calibration approval requires the approving admin principal")
        provenance = {**dict(request.provenance), "created_by": principal.subject}
        policy = PolicyVersion(**{**request.__dict__, "provenance": provenance})
        validate_policy(policy)
        if not policy.policy_id:
            raise ValueError("policy_id is required")
        now = self.clock()
        event_id = str(uuid.uuid5(_POLICY_EVENT_NAMESPACE,
                                  f"{policy.tenant_id}:{policy.policy_id}:{policy.version}"))
        trace = hashlib.sha256(event_id.encode()).hexdigest()[:32]
        parent = hashlib.sha256((event_id + ":parent").encode()).hexdigest()[:16]
        event = {
            "event_id": event_id,
            "event_type": "risk.policy_changed",
            "schema_version": 1,
            "occurred_at": events.format_time(now),
            "tenant_id": policy.tenant_id,
            "aggregate_type": "grain_policy",
            "aggregate_id": policy.policy_id,
            "aggregate_version": str(policy.version),
            "correlation_id": event_id,
            "causation_id": event_id,
            "traceparent": f"00-{trace}-{parent}-01",
            "payload": policy.as_dict(),
        }
        event["payload"]["supersedes"] = None
        with self.db.transaction(principal.tenant_id) as tx:
            tx.create_policy(policy, event)
        return event

    def effective(self, principal: VerifiedPrincipal, bin_id: str, grain_type: str,
                  instant: datetime) -> PolicyVersion | None:
        if "admin" not in principal.roles:
            raise PermissionError("admin role required to read policy provenance")
        with self.db.transaction(principal.tenant_id) as tx:
            return tx.select_policy(bin_id, grain_type, instant)
