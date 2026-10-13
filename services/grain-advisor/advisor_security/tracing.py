"""Privacy-preserving W3C tracing for the Advisor service.

Only validated traceparent context is accepted. Span names and attributes are
closed enums/numbers; request content, identity, owner URLs and credentials are
never recorded.
"""
from __future__ import annotations

import ipaddress
import os
import re
from urllib.parse import urlsplit

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator


_TRACEPARENT = re.compile(r"00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})\Z")
_OPERATIONS = frozenset({
    "Advisor.http.get_health", "Advisor.http.get_readiness",
    "Advisor.http.get_proposals", "Advisor.http.get_other",
    "Advisor.http.post_proposal", "Advisor.http.post_decision",
    "Advisor.http.post_execution", "Advisor.http.post_other",
    "Advisor.workflow.plan", "Advisor.workflow.owner_tool",
    "Advisor.workflow.apply_approval", "Advisor.workflow.start",
    "Advisor.workflow.resume", "Advisor.owner.membership",
    "Advisor.owner.alert_authorization", "Advisor.owner.alert_acknowledgement",
    "Advisor.owner.readiness", "Advisor.identity.jwks",
})


def validated_traceparent(value: str | None) -> str | None:
    match = _TRACEPARENT.fullmatch(value or "")
    if not match or int(match[1], 16) == 0 or int(match[2], 16) == 0:
        return None
    return value


def _validate_endpoint(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or
                parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError
        # Cleartext is limited to loopback and in-cluster service discovery;
        # remote collectors must use HTTPS.
        if parsed.scheme == "http":
            host = parsed.hostname.lower()
            try:
                loopback = ipaddress.ip_address(host).is_loopback
            except ValueError:
                loopback = host == "localhost" or host.endswith(".svc.cluster.local")
            if not loopback:
                raise ValueError
        return value.rstrip("/")
    except (TypeError, ValueError) as exc:
        raise ValueError("OTEL_EXPORTER_OTLP_ENDPOINT must be a safe HTTP(S) collector URL") from exc


class AdvisorTracing:
    """Owns a bounded OTLP exporter and creates fixed-name Advisor spans."""

    def __init__(self, *, endpoint: str | None = None, exporter=None):
        self.propagator = TraceContextTextMapPropagator()
        self.provider = TracerProvider(resource=Resource.create({
            "service.name": "grain-advisor",
            "service.version": "0.1.0",
        }))
        endpoint = endpoint if endpoint is not None else os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        if exporter is not None:
            self.provider.add_span_processor(BatchSpanProcessor(
                exporter, max_queue_size=1024, max_export_batch_size=128,
                schedule_delay_millis=5000, export_timeout_millis=5000,
            ))
        elif endpoint:
            endpoint = _validate_endpoint(endpoint)
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            export_url = endpoint if endpoint.endswith("/v1/traces") else endpoint + "/v1/traces"
            self.provider.add_span_processor(BatchSpanProcessor(
                OTLPSpanExporter(endpoint=export_url, timeout=5),
                max_queue_size=1024, max_export_batch_size=128,
                schedule_delay_millis=5000, export_timeout_millis=5000,
            ))
        self.tracer = self.provider.get_tracer("greenguard.grain_advisor")

    def extract(self, value: str | None):
        parent = validated_traceparent(value)
        return self.propagator.extract({"traceparent": parent} if parent else {})

    def span(self, name: str, *, parent=None, kind=SpanKind.INTERNAL):
        if name not in _OPERATIONS:
            raise ValueError("unregistered Advisor span operation")
        return self.tracer.start_as_current_span(name, context=parent, kind=kind,
                                                  record_exception=False, set_status_on_exception=False)

    def inject(self, carrier: dict[str, str]) -> dict[str, str]:
        # W3C trace-context propagator does not propagate baggage. Incoming
        # tracestate is deliberately not extracted, so it cannot leak out.
        self.propagator.inject(carrier)
        return carrier

    def shutdown(self, timeout_seconds: float = 5.0) -> bool:
        try:
            self.provider.force_flush(timeout_millis=max(1, min(5000, int(timeout_seconds * 1000))))
            self.provider.shutdown()
            return True
        except Exception:
            return False


def outcome_for_status(status: int) -> str:
    if 200 <= status < 300:
        return "success"
    if status in {401, 403}:
        return "denied"
    if status == 404:
        return "not_found"
    if status in {409, 412}:
        return "conflict"
    if status >= 500:
        return "error"
    return "rejected"


def finish_span(span, *, status: int | None = None, outcome: str | None = None) -> None:
    if status is not None:
        span.set_attribute("http.response.status_code", int(status))
        outcome = outcome or outcome_for_status(status)
    if outcome not in {"success", "denied", "not_found", "conflict", "error", "rejected", "interrupted"}:
        outcome = "error"
    span.set_attribute("greenguard.outcome", outcome)
    if outcome == "error":
        span.set_status(Status(StatusCode.ERROR))


_DEFAULT = AdvisorTracing()


def default_tracing() -> AdvisorTracing:
    return _DEFAULT


def set_default_tracing(tracing: AdvisorTracing) -> None:
    """Share the configured provider with isolated owner-call worker helpers."""
    global _DEFAULT
    if not isinstance(tracing, AdvisorTracing):
        raise TypeError("AdvisorTracing instance required")
    _DEFAULT = tracing
