"""Process health and Prometheus-text metrics.

Labels are bounded operational values (topic, outcome, reason). Tenant, device, lot
and event identifiers never become labels; they belong in logs and traces.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

_FORBIDDEN_LABELS = frozenset({"tenant_id", "tenant", "device_id", "lot_id", "bin_id", "event_id"})


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], int] = {}

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
            for (name, labels), count in sorted(self._counters.items()):
                rendered = ",".join(f'{key}="{value}"' for key, value in labels)
                lines.append(f"{name}{{{rendered}}} {count}" if rendered else f"{name} {count}")
        return "\n".join(lines) + "\n"


def serve(port: int, metrics: Metrics, ready: Callable[[], bool], host: str = "0.0.0.0") -> ThreadingHTTPServer:
    """Start /healthz (liveness), /readyz (database reachable) and /metrics."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - http.server API
            if self.path == "/healthz":
                self._send(200, "ok\n")
            elif self.path == "/readyz":
                ok = ready()
                self._send(200 if ok else 503, "ready\n" if ok else "not ready\n")
            elif self.path == "/metrics":
                self._send(200, metrics.render())
            else:
                self._send(404, "not found\n")

        def _send(self, status: int, body: str) -> None:
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            """Probes are frequent; access logs are intentionally not written."""

    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, name="risk-health", daemon=True).start()
    return server
