"""Small HTTP health endpoint for long-running Python workers."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time


class WorkerHealth:
    def __init__(self, *, stale_after_seconds: float = 90.0):
        self._lock = threading.Lock()
        self._alive = True
        self._ready = False
        self._last_heartbeat = time.monotonic()
        self._stale_after_seconds = stale_after_seconds

    def heartbeat(self) -> None:
        with self._lock:
            self._last_heartbeat = time.monotonic()

    def set_ready(self, ready: bool) -> None:
        with self._lock:
            self._ready = ready

    def stop(self) -> None:
        with self._lock:
            self._alive = False
            self._ready = False

    def status(self, path: str) -> int:
        with self._lock:
            live = self._alive and time.monotonic() - self._last_heartbeat <= self._stale_after_seconds
            ready = live and self._ready
        if path == "/healthz":
            return 200 if live else 503
        if path == "/readyz":
            return 200 if ready else 503
        return 404


def start_health_server(health: WorkerHealth, *, port: int = 8080) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            status = health.status(self.path)
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, _format, *_args):
            return

    # Kubernetes exec probes call loopback, so health endpoints need no pod ingress.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, name="worker-health", daemon=True).start()
    return server
