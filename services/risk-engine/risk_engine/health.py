"""Process health and Prometheus-text metrics.

Labels are bounded operational values (topic, outcome, reason). Tenant, device, lot
and event identifiers never become labels; they belong in logs and traces.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_FORBIDDEN_LABELS = frozenset({"tenant_id", "tenant", "device_id", "lot_id", "bin_id", "event_id"})


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], int] = {}
        self._placement_sum = 0.0
        self._placement_buckets = dict.fromkeys((0.01, 0.05, 0.1, 0.5, 1.0, 2.0, float("inf")), 0)

    def observe_placement(self, seconds: float, failed: bool) -> None:
        self.inc("greenguard_risk_placement_requests_total", outcome="error" if failed else "ok")
        with self._lock:
            self._placement_sum += seconds
            for bound in self._placement_buckets:
                if seconds <= bound:
                    self._placement_buckets[bound] += 1

    def inc(self, name: str, **labels: str) -> None:
        if _FORBIDDEN_LABELS.intersection(labels):
            raise ValueError("high-cardinality identity labels are not allowed")
        key = (name, tuple(sorted(labels.items())))
        with self._lock:
            self._counters[key] = self._counters.get(key, 0) + 1

    def value(self, name: str, **labels: str) -> int:
        return self._counters.get((name, tuple(sorted(labels.items()))), 0)

    def render(self) -> str:
        lines = []
        with self._lock:
            if self._placement_buckets[float("inf")]:
                for bound, count in self._placement_buckets.items():
                    label = "+Inf" if bound == float("inf") else str(bound)
                    lines.append(f'greenguard_risk_placement_request_seconds_bucket{{le="{label}"}} {count}')
                lines.append(f"greenguard_risk_placement_request_seconds_sum {self._placement_sum}")
                lines.append(f'greenguard_risk_placement_request_seconds_count {self._placement_buckets[float("inf")]}')
            for (name, labels), count in sorted(self._counters.items()):
                rendered = ",".join(f'{key}="{value}"' for key, value in labels)
                lines.append(f"{name}{{{rendered}}} {count}" if rendered else f"{name} {count}")
        return "\n".join(lines) + "\n"


def serve(port: int, metrics: Metrics, ready: Callable[[], bool], host: str = "0.0.0.0",
          policy_api: object | None = None) -> ThreadingHTTPServer:
    """Start /healthz (liveness), /readyz (database reachable) and /metrics."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if policy_api is not None and policy_api.handle(self):
                return
            if self.path == "/healthz":
                self._send(200, "ok\n")
            elif self.path == "/readyz":
                ok = ready()
                self._send(200 if ok else 503, "ready\n" if ok else "not ready\n")
            elif self.path == "/metrics":
                self._send(200, metrics.render())
            else:
                self._send(404, "not found\n")

        def do_POST(self) -> None:
            if policy_api is not None and policy_api.handle(self):
                return
            self._send(404, "not found\n")

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(10)

        def _send(self, status: int, body: str) -> None:
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:
            """Probes are frequent; access logs are intentionally not written."""

    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, name="risk-health", daemon=True).start()
    return server
