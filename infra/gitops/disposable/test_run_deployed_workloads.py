import importlib.util
import json
import io
import copy
import stat
import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).with_name("run-deployed-workloads.py")
spec = importlib.util.spec_from_file_location("run_deployed_workloads", SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class TerraformHealthAdapterTests(unittest.TestCase):
    def setUp(self):
        self.cell = {"account_id": "123456789012", "region": "us-east-1", "environment": "dev", "cluster_name": "gg-cell"}
        contract = json.loads((runner.BASE / "contract.json").read_text())
        self.release = {"gitops_revision": "a" * 40, "deployment_image_digests": {
            service: f"ghcr.io/pahuldeepp/grainguard/{service}@sha256:" + "b" * 64
            for service in {release["image"] for release in contract["releases"]}
        }, "migration_image_digests": {
            owner["name"]: f"ghcr.io/pahuldeepp/grainguard/migration-{owner['name']}@sha256:" + "c" * 64
            for owner in json.loads((runner.BASE / "owner-migration-inventory.json").read_text())
        }, "migration_gate_image_digest": "ghcr.io/pahuldeepp/grainguard/migration-gate@sha256:" + "d" * 64,
            "migration_sql_image_digest": "ghcr.io/pahuldeepp/grainguard/migration-sql@sha256:" + "e" * 64,
            "ml_synthetic_enabled": False, "ml_synthetic_scorer_image_digest": "",
            "managed_dex_enabled": True, "membership_acceptance_enabled": False,
            "clickhouse_image_digest": "ghcr.io/pahuldeepp/grainguard/clickhouse@sha256:" + "f" * 64}

    def test_creates_ephemeral_kubeconfig_and_invokes_scoped_readiness_gate(self):
        calls = []

        def fake(command, **kwargs):
            calls.append((command, kwargs))
            if command[:3] == ["aws", "eks", "update-kubeconfig"]:
                Path(command[command.index("--kubeconfig") + 1]).write_text("ephemeral")
                return subprocess.CompletedProcess(command, 0, "context created", "")
            for argument in command[2:5]:
                self.assertEqual(stat.S_IMODE(Path(argument).stat().st_mode), 0o600)
            return subprocess.CompletedProcess(command, 0, "", "")

        self.assertEqual(runner.run(self.cell, self.release, command=fake), 0)
        self.assertEqual(len(calls), 2)
        aws_command, aws_options = calls[0]
        self.assertEqual(aws_command[0:6], ["aws", "eks", "update-kubeconfig", "--region", "us-east-1", "--name"])
        self.assertTrue(aws_options["capture_output"])
        self.assertEqual(calls[1][1]["timeout"], 2520)
        gate_command = calls[1][0]
        self.assertEqual(gate_command[1], str(Path(runner.BASE / "check-deployed-workloads.py")))
        self.assertEqual(gate_command[-2:], ["--timeout", "2400"])
        self.assertFalse(Path(gate_command[2]).exists())
        self.assertFalse(Path(gate_command[3]).exists())
        self.assertFalse(Path(gate_command[4]).exists())

    def test_malformed_and_production_scopes_make_no_aws_subprocess(self):
        mutations = [
            lambda cell, release: cell.update(environment="prod"),
            lambda cell, release: cell.update(environment="production"),
            lambda cell, release: cell.update(environment="Production"),
            lambda cell, release: cell.update(environment="PROD"),
            lambda cell, release: cell.update(account_id="wrong-account"),
            lambda cell, release: cell.update(account_id=123456789012),
            lambda cell, release: cell.update(region="invalid-region"),
            lambda cell, release: cell.update(cluster_name="bad cluster"),
            lambda cell, release: release.update(gitops_revision="mutable-main"),
            lambda cell, release: release.update(deployment_image_digests={}),
            lambda cell, release: release["deployment_image_digests"].update(bff="foreign.io/bff:latest"),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                cell, release = copy.deepcopy(self.cell), copy.deepcopy(self.release)
                mutate(cell, release)
                command = Mock()
                with self.assertRaises(ValueError):
                    runner.run(cell, release, command=command)
                command.assert_not_called()

    def test_terraform_environment_success_propagates_gate_status(self):
        environment = {"GG_DISPOSABLE_CELL_IDENTITY": json.dumps(self.cell), "GG_DISPOSABLE_RELEASE_INPUTS": json.dumps(self.release)}
        with patch.dict(runner.os.environ, environment), patch.object(runner, "run", return_value=1) as run:
            self.assertEqual(1, runner.main())
            run.assert_called_once_with(self.cell, self.release, timeout=2400)

    def test_terraform_production_environment_is_rejected_without_aws(self):
        self.cell["environment"] = "prod"
        environment = {"GG_DISPOSABLE_CELL_IDENTITY": json.dumps(self.cell), "GG_DISPOSABLE_RELEASE_INPUTS": json.dumps(self.release)}
        command = Mock()
        real_run = runner.run
        with patch.dict(runner.os.environ, environment), patch.object(runner, "run", side_effect=lambda cell, release, timeout: real_run(cell, release, timeout=timeout, command=command)), patch.object(runner.sys, "stderr", io.StringIO()) as error:
            self.assertEqual(1, runner.main())
            self.assertIn("BLOCKED", error.getvalue())
            command.assert_not_called()

    def test_invalid_timeout_is_rejected_before_aws(self):
        for timeout in (0, 3601, True, "900"):
            command = Mock()
            with self.assertRaisesRegex(ValueError, "readiness timeout"):
                runner.run(self.cell, self.release, timeout=timeout, command=command)
            command.assert_not_called()

    def test_kubeconfig_failure_stops_before_kubectl_gate(self):
        calls = []

        def fake(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 1, "", "credentials redacted")

        with self.assertRaisesRegex(ValueError, "temporary kubeconfig"):
            runner.run(self.cell, self.release, command=fake)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
