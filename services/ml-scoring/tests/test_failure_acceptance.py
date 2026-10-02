"""Focused checks for deterministic synthetic failures and resource isolation."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import failure_acceptance as acceptance
import failure_acceptance_driver as driver
from ml_scoring.contracts import parse_telemetry_recorded


class AbruptExit(BaseException):
    def __init__(self, code):
        self.code = code


def abrupt_exit(code):
    raise AbruptExit(code)


class FailureAcceptanceTests(unittest.TestCase):
    def test_fixture_is_deterministic_valid_and_tenant_keyed(self):
        key, raw = acceptance.synthetic_event(acceptance.DEVICES[0], 23)
        self.assertEqual((key, raw), acceptance.synthetic_event(acceptance.DEVICES[0], 23))
        event = parse_telemetry_recorded(key, raw)
        self.assertEqual(event.tenant_id, acceptance.TENANT)
        self.assertEqual(event.bin_id, acceptance.BIN)
        self.assertEqual(event.sequence, 24)
        now = datetime.now(timezone.utc)
        self.assertLessEqual(now - event.observed_at, timedelta(days=1))
        self.assertLessEqual(event.observed_at, now)
        events = [acceptance.synthetic_event(device, sequence)
                  for sequence in range(26) for device in acceptance.DEVICES]
        event_ids = {json.loads(raw)["event_id"] for _, raw in events}
        self.assertEqual(len(event_ids), 416)
        with patch.object(acceptance, "AdminClient"):
            harness = acceptance.Acceptance(Path("/tmp"))
        self.assertEqual(harness.synthetic_source_event_ids, event_ids)

    def test_external_credentials_and_endpoints_are_not_inherited(self):
        contaminated = {"PATH": os.environ["PATH"], "ML_DATABASE_URL": "postgresql://prod/shared",
                        "PGHOST": "shared-db", "KAFKA_BOOTSTRAP_SERVERS": "prod:9092",
                        "AWS_ACCESS_KEY_ID": "never-use", "OTEL_EXPORTER_OTLP_ENDPOINT": "https://remote",
                        "DOCKER_HOST": "ssh://remote", "COMPOSE_PROJECT_NAME": "shared"}
        with patch.dict(os.environ, contaminated, clear=True), patch.object(acceptance, "AdminClient"):
            harness = acceptance.Acceptance(Path("/tmp"))
        for name in contaminated.keys() - {"PATH"}:
            self.assertNotIn(name, harness.environment)
        self.assertTrue(harness.project.startswith("greenguard-ml-failure-"))
        self.assertIn("@127.0.0.1:", harness.app_dsn)
        self.assertNotEqual(harness.group, "ml-scoring-it-shadow")

    def test_ci_compose_project_is_explicit_and_prefix_constrained(self):
        project = "greenguard-ml-failure-ci-12345-2"
        with patch.dict(os.environ, {"ML_FAILURE_COMPOSE_PROJECT": project}, clear=True), \
                patch.object(acceptance, "AdminClient"):
            harness = acceptance.Acceptance(Path("/tmp"))
        self.assertEqual(harness.project, project)
        self.assertEqual(harness.environment["ML_FAILURE_COMPOSE_PROJECT"], project)
        with patch.dict(os.environ, {"ML_FAILURE_COMPOSE_PROJECT": "shared-production"}, clear=True), \
                patch.object(acceptance, "AdminClient"):
            with self.assertRaisesRegex(ValueError, "isolated CI project prefix"):
                acceptance.Acceptance(Path("/tmp"))

    def invoke_driver(self, mode, run, journal, event_id=""):
        with patch.dict(os.environ, {"ML_FAILURE_ACCEPTANCE_DRIVER": "disposable-local-only",
                                    "ML_DATABASE_URL": "postgresql://local",
                                    "KAFKA_BOOTSTRAP_SERVERS": "127.0.0.1:1"}), \
                patch.object(driver.main, "validate_local_endpoints"), \
                patch.object(driver.main, "run", side_effect=run), \
                patch.object(driver.main, "commit_offset_after_processing") as committed, \
                patch.object(driver.ShadowScoringProcessor, "process", return_value=SimpleNamespace(status="handled")), \
                patch.object(driver.store._PostgresTransaction, "mark_shadow_event_published") as marked, \
                patch.object(driver.os, "_exit", side_effect=abrupt_exit):
            with self.assertRaises(AbruptExit) as exited:
                driver.run(mode, journal, event_id)
            committed.assert_not_called()
            marked.assert_not_called()
            return exited.exception.code

    def test_input_crash_records_db_completion_before_exit_and_never_commits(self):
        key, raw = acceptance.synthetic_event(acceptance.DEVICES[0], 0)
        event_id = json.loads(raw)["event_id"]
        message = SimpleNamespace(value=lambda: raw, offset=lambda: 0)
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / "journal.jsonl"
            def run():
                driver.ShadowScoringProcessor.process(object(), acceptance.TOPIC, key, raw,
                                                      partition=0, offset=0)
                driver.main.commit_offset_after_processing(object(), message)
            code = self.invoke_driver("input-crash", run, journal, event_id)
            self.assertEqual(code, 73)
            self.assertEqual([row["boundary"] for row in acceptance.read_journal(journal)],
                             ["database_committed", "before_input_offset_commit"])

    def test_output_crash_records_ack_boundary_and_never_marks_published(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / "journal.jsonl"
            code = self.invoke_driver("output-crash", lambda:
                                      driver.store._PostgresTransaction.mark_shadow_event_published(
                                          object(), "event-1", "lease-1"), journal)
            self.assertEqual(code, 74)
            self.assertEqual(acceptance.read_journal(journal),
                             [{"boundary": "after_output_ack_before_database_mark", "event_id": "event-1"}])

    def test_fault_driver_refuses_missing_opt_in(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "opt-in"):
                driver.run("observe", Path("/tmp/unused"))

    def test_remote_docker_context_is_rejected_before_resource_creation(self):
        with patch.object(acceptance, "AdminClient"):
            harness = acceptance.Acceptance(Path("/tmp"))
        context = SimpleNamespace(stdout=json.dumps([{"Endpoints": {"docker": {"Host": "ssh://shared"}}}]))
        with patch.object(acceptance.subprocess, "run", return_value=context), \
                patch.object(harness, "compose") as compose:
            with self.assertRaisesRegex(RuntimeError, "local Docker"):
                harness.start()
            compose.assert_not_called()
        self.assertFalse(harness.compose_started)

    def test_teardown_runs_even_when_container_diagnostics_fail(self):
        with patch.object(acceptance, "AdminClient"):
            harness = acceptance.Acceptance(Path("/tmp"))
        harness.compose_started = True
        result = SimpleNamespace(returncode=0, stdout="")
        def compose(*args, **kwargs):
            if args[0] == "logs":
                raise TimeoutError("diagnostic timeout")
            return result
        with patch.object(harness, "compose", side_effect=compose) as called, \
                patch.object(acceptance.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "diagnostic timeout"):
                harness.cleanup(failed=True)
        self.assertTrue(any(call.args[0] == "down" and "--volumes" in call.args
                            for call in called.call_args_list))

    def test_journal_reader_ignores_unfinished_record(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "journal.jsonl"
            path.write_text('{"offset":0}\n{"offset":')
            self.assertEqual(acceptance.read_journal(path), [{"offset": 0}])


if __name__ == "__main__":
    unittest.main()
