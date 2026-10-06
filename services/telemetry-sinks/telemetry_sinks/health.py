"""Bounded health and Prometheus endpoint with fixed-cardinality labels."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
from typing import Any


class HealthState:
    def __init__(self, mode: str):
        self.mode = mode
        self.lock = threading.Lock()
        self.started = time.monotonic()
        self.ready = False
        self.stopping = False
        self.fatal = False
        self.backend_ready = False
        self.kafka_ready = False
        self.last_poll = 0.0
        self.last_success = 0.0
        self.counters: dict[tuple[str, str], int] = {}
        self.retries = 0

    def set_backends(self, *, kafka_ready: bool | None = None, backend_ready: bool | None = None) -> None:
        with self.lock:
            if kafka_ready is not None:
                self.kafka_ready = kafka_ready
            if backend_ready is not None:
                self.backend_ready = backend_ready
            self.ready = self.kafka_ready and self.backend_ready and not self.stopping and not self.fatal

    def heartbeat(self) -> None:
        with self.lock:
            self.last_poll = time.monotonic()
            self.ready = self.kafka_ready and self.backend_ready and not self.stopping and not self.fatal

    def success(self, mode: str, topic: str, count: int) -> None:
        with self.lock:
            self.counters[(mode, topic)] = self.counters.get((mode, topic), 0) + count
            self.last_success = time.time()

    def retry(self) -> None:
        with self.lock:
            self.retries += 1

    def mark_stopping(self) -> None:
        with self.lock:
            self.stopping = True
            self.ready = False

    def mark_fatal(self) -> None:
        with self.lock:
            self.fatal = True
            self.ready = False

    def render(self) -> tuple[bool, bytes]:
        now = time.monotonic()
        with self.lock:
            ready = self.ready and now - self.last_poll <= 60 and not self.stopping and not self.fatal
            counters = dict(self.counters)
            retries = self.retries
            backend_ready = self.backend_ready
            kafka_ready = self.kafka_ready
            last_success = self.last_success
        lines = [
            "# HELP greenguard_telemetry_sink_ready Sink has healthy dependencies and is accepting Kafka records.",
            "# TYPE greenguard_telemetry_sink_ready gauge",
            f"greenguard_telemetry_sink_ready {int(ready)}",
            "# HELP greenguard_telemetry_sink_backend_ready Downstream ClickHouse or S3 endpoint is ready.",
            "# TYPE greenguard_telemetry_sink_backend_ready gauge",
            f"greenguard_telemetry_sink_backend_ready {int(backend_ready)}",
            "# HELP greenguard_telemetry_sink_kafka_ready Kafka consumer has an assigned partition.",
            "# TYPE greenguard_telemetry_sink_kafka_ready gauge",
            f"greenguard_telemetry_sink_kafka_ready {int(kafka_ready)}",
            "# HELP greenguard_telemetry_sink_retries_total Bounded dependency retry attempts.",
            "# TYPE greenguard_telemetry_sink_retries_total counter",
            f"greenguard_telemetry_sink_retries_total {retries}",
            "# HELP greenguard_telemetry_sink_events_total Durable records written to a sink.",
            "# TYPE greenguard_telemetry_sink_events_total counter",
        ]
        for (mode, topic), count in sorted(counters.items()):
            lines.append(f'greenguard_telemetry_sink_events_total{{mode="{mode}",topic="{topic}"}} {count}')
        lines.extend([
            "# HELP greenguard_telemetry_sink_last_success_timestamp_seconds Last sink durability acknowledgement time.",
            "# TYPE greenguard_telemetry_sink_last_success_timestamp_seconds gauge",
            f"greenguard_telemetry_sink_last_success_timestamp_seconds {last_success}",
        ])
        return ready, ("\n".join(lines) + "\n").encode("utf-8")


def start_health_server(state: HealthState, host: str = "0.0.0.0", port: int = 8080) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            ready, metrics = state.render()
            if self.path == "/healthz":
                self._send(200 if not state.fatal else 500, b"ok\n", "text/plain")
            elif self.path == "/readyz":
                self._send(200 if ready else 503, b"ready\n" if ready else b"not ready\n", "text/plain")
            elif self.path == "/metrics":
                self._send(200, metrics, "text/plain; version=0.0.4; charset=utf-8")
            else:
                self._send(404, b"not found\n", "text/plain")

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="telemetry-sink-health", daemon=True)
    thread.start()
    return server
