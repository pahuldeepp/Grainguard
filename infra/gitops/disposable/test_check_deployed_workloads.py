"""Offline fixtures for the read-only deployed workload gate."""
import copy
import importlib.util
import json
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("deployed", Path(__file__).with_name("check-deployed-workloads.py"))
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class WorkloadGateTests(unittest.TestCase):
    def setUp(self):
        self.cell = {"account_id": "123456789012", "region": "us-west-2", "environment": "dev", "cluster_name": "gg-test"}
        self.contract = {
            "releases": [{"name": "bff", "image": "bff", "health": "/readyz"}],
            "acceptanceJobs": [{
                "name": "postgres-owner-migration-gate",
                "selector": {"greenguard.io/migration-gate": "true"},
                "images": ["migration-gate", "migration-sql"],
            }],
        }
        self.image = "ghcr.io/pahuldeepp/grainguard/bff@sha256:" + "a" * 64
        self.release = {
            "gitops_revision": "b" * 40,
            "deployment_image_digests": {"bff": self.image},
            "migration_image_digests": {
                owner["name"]: f"ghcr.io/pahuldeepp/grainguard/migration-{owner['name']}@sha256:" + "c" * 64
                for owner in json.loads((gate.BASE / "owner-migration-inventory.json").read_text())
            },
            "migration_gate_image_digest": "ghcr.io/pahuldeepp/grainguard/migration-gate@sha256:" + "d" * 64,
            "migration_sql_image_digest": "ghcr.io/pahuldeepp/grainguard/migration-sql@sha256:" + "e" * 64,
        }
        labels = {"app.kubernetes.io/instance": "bff"}
        self.snapshot = {"items": [
            {"kind": "Deployment", "metadata": {"labels": labels, "generation": 2},
             "spec": {"replicas": 1, "template": {"spec": {"containers": [{"name": "bff", "image": self.image,
                                                                                 "readinessProbe": {"httpGet": {"path": "/readyz"}}}]}}},
             "status": {"observedGeneration": 2, "updatedReplicas": 1, "readyReplicas": 1, "availableReplicas": 1, "replicas": 1}},
            {"kind": "Pod", "metadata": {"labels": labels}, "spec": {"containers": [{"name": "bff", "image": self.image}]},
             "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}],
                        "containerStatuses": [{"name": "bff", "ready": True, "imageID": "containerd://sha256:" + "c" * 64, "state": {"running": {}}}]}},
            {"kind": "Job", "metadata": {"name": "gg-migration-gate-test",
                                             "labels": {"greenguard.io/migration-gate": "true"}},
             "spec": {"template": {"spec": {
                 "initContainers": [
                     {"name": "completed-owner-jobs", "image": self.release["migration_gate_image_digest"]},
                     {"name": "owner-sql-check", "image": self.release["migration_sql_image_digest"]},
                 ],
                 "containers": [{"name": "accepted", "image": self.release["migration_sql_image_digest"]}],
             }}},
             "status": {"succeeded": 1, "failed": 0,
                        "conditions": [{"type": "Complete", "status": "True"}]}},
        ]}

    def test_exact_healthy_release_passes(self):
        gate.inputs(self.cell, self.release, self.contract)
        self.assertEqual([], gate.readiness(self.snapshot, self.release, self.contract))

    def test_deployment_contract_health_path_requires_matching_readiness_probe(self):
        self.snapshot["items"][0]["spec"]["template"]["spec"]["containers"][0]["readinessProbe"]["httpGet"]["path"] = "/healthz"
        self.assertIn("readiness probe differs", " ".join(gate.readiness(self.snapshot, self.release, self.contract)))
        self.snapshot["items"][0]["spec"]["template"]["spec"]["containers"][0]["readinessProbe"] = None
        self.assertIn("readiness probe differs", " ".join(gate.readiness(self.snapshot, self.release, self.contract)))

    def test_exec_readiness_contract_requires_exact_command(self):
        contract = {"releases": [{"name": "bff", "image": "bff", "health": {
            "type": "exec", "command": ["python", "-c", "check-ready"]}}]}
        snapshot = copy.deepcopy(self.snapshot)
        container = snapshot["items"][0]["spec"]["template"]["spec"]["containers"][0]
        container["readinessProbe"] = {"exec": {"command": ["python", "-c", "check-ready"]}}
        self.assertEqual([], gate.readiness(snapshot, self.release, contract))
        container["readinessProbe"]["exec"]["command"][-1] = "wrong-check"
        self.assertIn("readiness probe differs", " ".join(gate.readiness(snapshot, self.release, contract)))
        container["readinessProbe"] = None
        self.assertIn("readiness probe differs", " ".join(gate.readiness(snapshot, self.release, contract)))

    def test_inputs_reject_production_foreign_registry_mutable_and_missing_images(self):
        for mutate in [lambda cell, release: cell.update(environment="prod"),
                       lambda cell, release: cell.update(environment="production"),
                       lambda cell, release: cell.update(environment="Production"),
                       lambda cell, release: release["deployment_image_digests"].update(bff="wrong.io/bff@sha256:" + "a" * 64),
                       lambda cell, release: release["deployment_image_digests"].update(bff="ghcr.io/pahuldeepp/grainguard/bff:latest"),
                       lambda cell, release: release.update(deployment_image_digests={})]:
            cell, release = copy.deepcopy(self.cell), copy.deepcopy(self.release)
            mutate(cell, release)
            with self.assertRaises(ValueError):
                gate.inputs(cell, release, self.contract)

    def test_stale_generation_scale_zero_partial_rollout_and_image_drift_block(self):
        for mutate in [lambda items: items[0]["status"].update(observedGeneration=1),
                       lambda items: items[0]["spec"].update(replicas=0),
                       lambda items: items[0]["status"].update(updatedReplicas=0),
                       lambda items: items[0]["spec"]["template"]["spec"]["containers"][0].update(image="wrong"),
                       lambda items: items[1]["spec"]["containers"][0].update(image="wrong"),
                       lambda items: items[1]["status"]["containerStatuses"][0].update(ready=False),
                       lambda items: items[1]["status"]["conditions"][0].update(status="False")]:
            snapshot = copy.deepcopy(self.snapshot)
            mutate(snapshot["items"])
            self.assertTrue(gate.readiness(snapshot, self.release, self.contract))

    def test_kubernetes_workload_fields_require_expected_json_types(self):
        for mutate in [
            lambda workload: workload["status"].update(updatedReplicas=True),
            lambda workload: workload["status"].update(observedGeneration="2"),
            lambda workload: workload["metadata"].update(labels=[]),
        ]:
            snapshot = copy.deepcopy(self.snapshot)
            mutate(snapshot["items"][0])
            with self.assertRaises(ValueError):
                gate.readiness(snapshot, self.release, self.contract)

        malformed = copy.deepcopy(self.snapshot)
        malformed["items"][0]["kind"] = 7
        with self.assertRaisesRegex(ValueError, "workload object"):
            gate.readiness(malformed, self.release, self.contract)

    def test_missing_extra_or_terminating_pods_block(self):
        for mutate in [lambda items: items.pop(), lambda items: items.append(copy.deepcopy(items[1])),
                       lambda items: items[1]["metadata"].update(deletionTimestamp="now")]:
            snapshot = copy.deepcopy(self.snapshot)
            mutate(snapshot["items"])
            self.assertTrue(gate.readiness(snapshot, self.release, self.contract))

    def test_statefulset_needs_matching_current_revision(self):
        obj = self.snapshot["items"][0]
        obj["kind"] = "StatefulSet"
        obj["status"].update(currentRevision="old", updateRevision="new")
        self.assertTrue(gate.readiness(self.snapshot, self.release, self.contract))
        obj["status"].update(currentRevision="new")
        self.assertEqual([], gate.readiness(self.snapshot, self.release, self.contract))

    def test_rollout_does_not_infer_promotion_from_ready_pods(self):
        self.snapshot["items"][0]["kind"] = "Rollout"
        self.assertIn("controller-aware", gate.readiness(self.snapshot, self.release, self.contract)[0])

    def test_postdeploy_gate_requires_completed_postgres_migration_and_rls_job(self):
        self.snapshot["items"] = [obj for obj in self.snapshot["items"] if obj["kind"] != "Job"]
        self.assertIn("expected exactly one completed acceptance Job", " ".join(
            gate.readiness(self.snapshot, self.release, self.contract)))
        self.snapshot = copy.deepcopy(self.snapshot)
        self.snapshot["items"].append({"kind": "Job", "metadata": {"name": "gate", "labels": {
            "greenguard.io/migration-gate": "true"}}, "spec": {"template": {"spec": {
            "initContainers": [{"name": "completed-owner-jobs", "image": self.release["migration_gate_image_digest"]},
                               {"name": "sql", "image": self.release["migration_sql_image_digest"]}],
            "containers": [{"name": "accepted", "image": self.release["migration_sql_image_digest"]}],
        }}}, "status": {"succeeded": 1, "failed": 0, "conditions": []}})
        self.assertIn("have not completed successfully", " ".join(
            gate.readiness(self.snapshot, self.release, self.contract)))

    def test_postdeploy_gate_requires_exact_tool_digests(self):
        gate_job = next(obj for obj in self.snapshot["items"] if obj["kind"] == "Job")
        gate_job["spec"]["template"]["spec"]["initContainers"][0]["image"] = "wrong/tool:latest"
        self.assertIn("tools differ from immutable release inputs", " ".join(
            gate.readiness(self.snapshot, self.release, self.contract)))

    def test_inputs_fail_closed_if_migration_gate_contract_is_removed(self):
        contract = copy.deepcopy(self.contract)
        contract.pop("acceptanceJobs")
        with self.assertRaisesRegex(ValueError, "must require the PostgreSQL owner migration gate"):
            gate.inputs(self.cell, self.release, contract)

    def test_scheduled_shard_task_requires_cronjob_and_successful_initial_job(self):
        task_image = "ghcr.io/pahuldeepp/grainguard/projection-builder@sha256:" + "d" * 64
        self.release["deployment_image_digests"]["projection-builder"] = task_image
        self.contract["scheduledTasks"] = [{"name": "projection-history-s1", "image": "projection-builder",
                                            "schedule": "*/10 * * * *", "initialJob": "projection-history-s1-initial"}]
        labels = {"app.kubernetes.io/instance": "projection-history-s1"}
        self.snapshot["items"].extend([
            {"kind": "CronJob", "metadata": {"labels": labels}, "spec": {
                "schedule": "*/10 * * * *", "suspend": False,
                "jobTemplate": {"spec": {"template": {"spec": {"containers": [{"image": task_image}]}}}},
            }},
            {"kind": "Job", "metadata": {"name": "projection-history-s1-initial", "labels": labels},
             "spec": {"template": {"spec": {"containers": [{"image": task_image}]}}},
             "status": {"succeeded": 1, "conditions": [{"type": "Complete", "status": "True"}]}},
        ])
        self.assertEqual([], gate.readiness(self.snapshot, self.release, self.contract))
        self.snapshot["items"][-1]["status"] = {"succeeded": 0, "conditions": []}
        self.assertIn("initial Job has not completed", " ".join(gate.readiness(self.snapshot, self.release, self.contract)))

    def test_missing_or_suspended_shard_maintenance_blocks_acceptance(self):
        self.contract["scheduledTasks"] = [{"name": "projection-history-s1", "image": "projection-builder",
                                            "schedule": "*/10 * * * *", "initialJob": "projection-history-s1-initial"}]
        self.release["deployment_image_digests"]["projection-builder"] = "ghcr.io/pahuldeepp/grainguard/projection-builder@sha256:" + "d" * 64
        self.assertIn("expected exactly one CronJob", " ".join(gate.readiness(self.snapshot, self.release, self.contract)))
        labels = {"app.kubernetes.io/instance": "projection-history-s1"}
        image = self.release["deployment_image_digests"]["projection-builder"]
        self.snapshot["items"].append({"kind": "CronJob", "metadata": {"labels": labels}, "spec": {
            "schedule": "*/10 * * * *", "suspend": True,
            "jobTemplate": {"spec": {"template": {"spec": {"containers": [{"image": image}]}}}},
        }})
        self.assertIn("schedule, suspension or immutable image", " ".join(gate.readiness(self.snapshot, self.release, self.contract)))

    def test_account_mismatch_stops_before_any_cluster_call(self):
        with patch.object(gate, "command", return_value="999999999999") as command:
            with self.assertRaisesRegex(ValueError, "account differs"):
                gate.collect(self.cell, "explicit-kubeconfig")
            self.assertEqual(1, command.call_count)

    def test_wrong_cluster_or_kube_endpoint_blocks_before_workload_reads(self):
        cluster = {"arn": "arn:aws:eks:us-west-2:123456789012:cluster/gg-test", "status": "ACTIVE", "endpoint": "https://correct.eks", "certificateAuthority": {"data": "test-ca"}}
        for responses in [[self.cell["account_id"], json.dumps({"cluster": {**cluster, "arn": "wrong"}})],
                          [self.cell["account_id"], json.dumps({"cluster": cluster}), json.dumps({"clusters": [{"cluster": {"server": "https://wrong.eks"}}]})]]:
            with patch.object(gate, "command", side_effect=responses) as command:
                with self.assertRaises(ValueError):
                    gate.collect(self.cell, "explicit-kubeconfig")
                self.assertLessEqual(command.call_count, 3)

    def test_correct_scope_and_private_api_are_read_only(self):
        cluster = {"arn": "arn:aws:eks:us-west-2:123456789012:cluster/gg-test", "status": "ACTIVE", "endpoint": "https://correct.eks", "certificateAuthority": {"data": "test-ca"}}
        config = {"clusters": [{"cluster": {"server": "https://correct.eks", "certificate-authority-data": "test-ca"}}]}
        with patch.object(gate, "command", side_effect=[self.cell["account_id"], json.dumps({"cluster": cluster}), json.dumps(config), "ok", json.dumps(self.snapshot), "applications.argoproj.io\n"]) as command:
            self.assertEqual(self.snapshot, gate.collect(self.cell, "explicit-kubeconfig"))
            args = [call.args[0] for call in command.call_args_list]
            self.assertEqual(["sts", "eks", "--kubeconfig", "--kubeconfig", "--kubeconfig", "--kubeconfig"], [arg[1] for arg in args])
            self.assertIn("deployments,statefulsets,pods,cronjobs,jobs", args[4])
            self.assertTrue(all("apply" not in arg and "delete" not in arg and "update-kubeconfig" not in arg for arg in args))

    def test_optional_rollout_discovery_collects_and_blocks_replaced_deployment(self):
        cluster = {"arn": "arn:aws:eks:us-west-2:123456789012:cluster/gg-test", "status": "ACTIVE", "endpoint": "https://correct.eks", "certificateAuthority": {"data": "test-ca"}}
        config = {"clusters": [{"cluster": {"server": "https://correct.eks", "certificate-authority-data": "test-ca"}}]}
        snapshot = copy.deepcopy(self.snapshot)
        rollout = snapshot["items"].pop(0)
        rollout["kind"] = "Rollout"
        responses = [self.cell["account_id"], json.dumps({"cluster": cluster}), json.dumps(config), "ok", json.dumps(snapshot), "rollouts.argoproj.io\n", json.dumps({"items": [rollout]})]
        with patch.object(gate, "command", side_effect=responses) as command:
            collected = gate.collect(self.cell, "explicit-kubeconfig")
            self.assertEqual(7, command.call_count)
            self.assertIn("controller-aware", gate.readiness(collected, self.release, self.contract)[0])

    def test_missing_optional_crd_cannot_hide_missing_contract_deployment(self):
        self.snapshot["items"].pop(0)
        self.assertIn("expected exactly one workload", gate.readiness(self.snapshot, self.release, self.contract)[0])

    def test_wrong_tls_trust_blocks_before_workload_reads(self):
        cluster = {"arn": "arn:aws:eks:us-west-2:123456789012:cluster/gg-test", "status": "ACTIVE", "endpoint": "https://correct.eks", "certificateAuthority": {"data": "test-ca"}}
        for connection in [{"server": "https://correct.eks", "certificate-authority-data": "wrong"},
                           {"server": "https://correct.eks", "certificate-authority-data": "test-ca", "insecure-skip-tls-verify": True}]:
            config = {"clusters": [{"cluster": connection}]}
            with patch.object(gate, "command", side_effect=[self.cell["account_id"], json.dumps({"cluster": cluster}), json.dumps(config)]) as command:
                with self.assertRaisesRegex(ValueError, "TLS trust differs"):
                    gate.collect(self.cell, "explicit-kubeconfig")
                self.assertEqual(3, command.call_count)

    def test_deadline_exhaustion_makes_no_cloud_call(self):
        with patch.object(gate.time, "monotonic", return_value=11), patch.object(gate, "command") as command:
            with self.assertRaisesRegex(ValueError, "deadline exhausted"):
                gate.collect(self.cell, "explicit-kubeconfig", deadline=10)
            command.assert_not_called()

    def cli_fixture(self, directory):
        root = Path(directory)
        (root / "contract.json").write_text(json.dumps(self.contract))
        (root / "owner-migration-inventory.json").write_text(
            (Path(__file__).with_name("owner-migration-inventory.json")).read_text()
        )
        (root / "cell.json").write_text(json.dumps(self.cell))
        (root / "release.json").write_text(json.dumps(self.release))
        (root / "kubeconfig").write_text("offline-fixture")
        return root, [str(root / name) for name in ("cell.json", "release.json", "kubeconfig")]

    def test_cli_success_uses_collector_without_any_live_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root, args = self.cli_fixture(directory)
            with patch.object(gate, "BASE", root), patch.object(gate, "collect", return_value=self.snapshot), patch.object(gate, "command") as command, patch.object(gate.sys, "stdout", io.StringIO()) as output:
                self.assertEqual(0, gate.main(args))
                self.assertIn("exact immutable images", output.getvalue())
                command.assert_not_called()

    def test_cli_timeout_reports_missing_workload(self):
        with tempfile.TemporaryDirectory() as directory:
            root, args = self.cli_fixture(directory)
            with patch.object(gate, "BASE", root), patch.object(gate, "collect", return_value={"items": []}), patch.object(gate.time, "monotonic", side_effect=[0, 2]), patch.object(gate.sys, "stderr", io.StringIO()) as error:
                self.assertEqual(1, gate.main(args + ["--timeout", "1"]))
                self.assertIn("expected exactly one workload", error.getvalue())

    def test_cli_refuses_production_before_collection(self):
        self.cell["environment"] = "prod"
        with tempfile.TemporaryDirectory() as directory:
            root, args = self.cli_fixture(directory)
            with patch.object(gate, "BASE", root), patch.object(gate, "collect") as collect, patch.object(gate.sys, "stderr", io.StringIO()):
                self.assertEqual(1, gate.main(args))
                collect.assert_not_called()

    def test_invalid_json_diagnostics_are_fixed_and_do_not_echo_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root, args = self.cli_fixture(directory)
            (root / "cell.json").write_text("{secret-credential-material")
            with patch.object(gate, "BASE", root), patch.object(gate, "collect") as collect, patch.object(gate.sys, "stderr", io.StringIO()) as error:
                self.assertEqual(1, gate.main(args))
                self.assertEqual("BLOCKED: deployed workload check received invalid JSON\n", error.getvalue())
                collect.assert_not_called()

    def test_command_errors_do_not_expose_cli_diagnostics(self):
        result = subprocess.CompletedProcess([], 1, "", "secret-token")
        with patch.object(gate.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(ValueError, "aws sts failed") as error:
                gate.command(["aws", "sts"])
            self.assertNotIn("secret-token", str(error.exception))


if __name__ == "__main__":
    unittest.main()
