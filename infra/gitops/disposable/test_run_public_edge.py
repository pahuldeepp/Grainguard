"""Offline tests for the bounded Terraform public-edge adapter."""
import importlib.util
import subprocess
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("public_edge_adapter", Path(__file__).with_name("run-public-edge.py"))
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class PublicEdgeAdapterTests(unittest.TestCase):
    def setUp(self):
        self.cell = {"region": "us-east-1", "environment": "sandbox", "cluster_name": "greenguard-sandbox",
                     "account_id": "123456789012"}
        self.tg = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/ggmsh-abc/0123456789abcdef"
        self.web = "https://dweb123.cloudfront.net"
        self.api = "https://dapi123.cloudfront.net/graphql"
        self.clock = [0.0]
        self.sleeps = []

    def now(self):
        return self.clock[0]

    def sleep(self, duration):
        self.sleeps.append(duration)
        self.clock[0] += duration

    def run_adapter(self, command):
        return adapter.run(self.cell, self.tg, self.web, self.api, "E1234567890WEB", "E1234567890API",
                           timeout=10, interval=3, command=command, sleep=self.sleep, monotonic=self.now)

    def test_retries_transient_then_passes(self):
        outcomes = iter([2, 2, 0])
        calls = []

        def command(*args, **kwargs):
            calls.append((args, kwargs))
            code = next(outcomes)
            return subprocess.CompletedProcess(args[0], code, "", "BLOCKED: target group has no registered targets" if code == 2 else "")

        self.assertEqual(self.run_adapter(command), 0)
        self.assertEqual(len(calls), 3)
        self.assertEqual(self.sleeps, [3, 3])

    def test_permanent_failure_fails_without_retry(self):
        calls = []

        def command(*args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args[0], 1, "", "BLOCKED: wrong cell")

        with self.assertRaisesRegex(ValueError, "wrong cell"):
            self.run_adapter(command)
        self.assertEqual(len(calls), 1)

    def test_deadline_is_bounded_and_diagnostics_sanitized(self):
        def command(*args, **kwargs):
            self.clock[0] += kwargs["timeout"]
            raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

        with self.assertRaisesRegex(ValueError, "timed out"):
            self.run_adapter(command)
        self.assertLessEqual(self.clock[0], 10)

    def test_invalid_foreign_input_fails_before_running_command(self):
        calls = []
        with self.assertRaisesRegex(ValueError, "production"):
            adapter.run(dict(self.cell, environment="Production"), self.tg, self.web, self.api,
                        "E1234567890WEB", "E1234567890API", command=lambda *a, **k: calls.append(a))
        self.assertEqual(calls, [])

    def test_timeout_and_interval_ranges_are_enforced(self):
        with self.assertRaisesRegex(ValueError, "between 1 and 600"):
            adapter.run(self.cell, self.tg, self.web, self.api, "E1234567890WEB", "E1234567890API", timeout=601)
        with self.assertRaisesRegex(ValueError, "between 1 and 60"):
            adapter.run(self.cell, self.tg, self.web, self.api, "E1234567890WEB", "E1234567890API", interval=61)


if __name__ == "__main__":
    unittest.main()
