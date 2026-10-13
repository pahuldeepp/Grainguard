import unittest
import urllib.error
import urllib.request

from worker_health import WorkerHealth, start_health_server


class WorkerHealthTests(unittest.TestCase):
    def test_ready_requires_explicit_dependency_and_loop_initialization(self):
        health = WorkerHealth()
        self.assertEqual(health.status("/healthz"), 200)
        self.assertEqual(health.status("/readyz"), 503)
        health.set_ready(True)
        self.assertEqual(health.status("/readyz"), 200)
        health.set_ready(False)
        self.assertEqual(health.status("/readyz"), 503)
        health.stop()
        self.assertEqual(health.status("/healthz"), 503)

    def test_health_server_binds_loopback_and_reports_worker_status(self):
        health = WorkerHealth()
        server = start_health_server(health, port=0)
        try:
            url = f"http://127.0.0.1:{server.server_port}/readyz"
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(url, timeout=2)
            self.assertEqual(error.exception.code, 503)
            error.exception.close()
            health.set_ready(True)
            with urllib.request.urlopen(url, timeout=2) as response:
                self.assertEqual(response.status, 200)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
