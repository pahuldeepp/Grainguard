"""Offline fixtures for the read-only deployed workload gate."""
import copy
import hashlib
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
            "requiredApplications": ["greenguard-edge-routing"],
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
            "ml_synthetic_enabled": False,
            "ml_synthetic_scorer_image_digest": "",
            "managed_dex_enabled": False,
            "membership_acceptance_enabled": False,
            "clickhouse_image_digest": "ghcr.io/pahuldeepp/grainguard/clickhouse@sha256:" + "f" * 64,
            "cassandra_image_digest": "ghcr.io/pahuldeepp/grainguard/cassandra@sha256:" + "a" * 64,
            "data_plane_image_digests": {name: f"ghcr.io/pahuldeepp/grainguard/{name}@sha256:" + "a" * 64 for name in ["pgbouncer", "kafka-topics", "kafka-connect", "connector-registration", "redis"]},
        }
        labels = {"app.kubernetes.io/instance": "bff"}
        self.snapshot = {"cell_name": self.cell["cluster_name"], "items": [
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
            {"kind": "Application", "metadata": {"name": "greenguard-bff",
                                                        "labels": {"greenguard.io/cell": self.cell["cluster_name"]}},
             "spec": {"source": {"targetRevision": self.release["gitops_revision"]}},
             "status": {"sync": {"status": "Synced", "revision": self.release["gitops_revision"]},
                        "health": {"status": "Healthy"}}},
            {"kind": "Application", "metadata": {"name": "greenguard-edge-routing",
                                                        "labels": {"greenguard.io/cell": self.cell["cluster_name"]}},
             "spec": {"source": {"targetRevision": self.release["gitops_revision"]}},
             "status": {"sync": {"status": "Synced", "revision": self.release["gitops_revision"]},
                        "health": {"status": "Healthy"}}},
        ]}

    def enable_ai(self):
        names = {"knowledge":"knowledge-service", "indexer":"knowledge-indexer", "parser":"knowledge-parser", "advisor":"grain-advisor", "gateway":"model-gateway", "usage":"model-gateway-usage", "mcp":"mcp-gateway"}
        self.release["ai_runtime_enabled"] = True
        self.release["ai_runtime_image_digests"] = {key: "ghcr.io/pahuldeepp/grainguard/"+name+"@sha256:"+"f"*64 for key,name in names.items()}
        self.release["ai_runtime_image_digests"]["clamav"] = "clamav/clamav@sha256:"+"f"*64

    def test_checked_in_contract_covers_clickhouse_and_conditional_oidc_membership(self):
        contract = json.loads((gate.BASE / "contract.json").read_text())
        release_names = {entry["image"] for entry in contract["releases"]}
        migration_names = {entry["name"] for entry in json.loads((gate.BASE / "owner-migration-inventory.json").read_text())}
        release = {
            "gitops_revision": "a" * 40,
            "deployment_image_digests": {
                name: f"ghcr.io/pahuldeepp/grainguard/{name}@sha256:" + "a" * 64
                for name in release_names
            },
            "migration_image_digests": {
                name: f"ghcr.io/pahuldeepp/grainguard/migration-{name}@sha256:" + "b" * 64
                for name in migration_names
            },
            "migration_gate_image_digest": "ghcr.io/pahuldeepp/grainguard/migration-gate@sha256:" + "c" * 64,
            "migration_sql_image_digest": "ghcr.io/pahuldeepp/grainguard/migration-sql@sha256:" + "d" * 64,
            "ml_synthetic_enabled": False,
            "ml_synthetic_scorer_image_digest": "",
            "managed_dex_enabled": True,
            "membership_acceptance_enabled": False,
            "clickhouse_image_digest": "ghcr.io/pahuldeepp/grainguard/clickhouse@sha256:" + "e" * 64,
            "cassandra_image_digest": self.release["cassandra_image_digest"],
            "data_plane_image_digests": self.release["data_plane_image_digests"],
        }
        gate.inputs(self.cell, release, contract)
        release["membership_acceptance_enabled"] = True
        gate.inputs(self.cell, release, contract)
        release["managed_dex_enabled"] = False
        with self.assertRaisesRegex(ValueError, "invalid exact-revision image inventory"):
            gate.inputs(self.cell, release, contract)

    def test_ai_inventory_is_exact_and_owned(self):
        self.enable_ai()
        gate.inputs(self.cell, self.release, self.contract)
        for bad in ({}, {**self.release["ai_runtime_image_digests"], "gateway":"ghcr.io/other/model-gateway@sha256:"+"f"*64}):
            with self.subTest(bad=bad):
                release = copy.deepcopy(self.release)
                release["ai_runtime_image_digests"] = bad
                with self.assertRaises(ValueError): gate.inputs(self.cell, release, self.contract)

    def test_ai_workloads_cannot_be_absent_behind_healthy_core(self):
        self.enable_ai()
        failures = gate.readiness(self.snapshot, self.release, self.contract)
        self.assertTrue(any("greenguard-ai-runtime" in failure for failure in failures))
        self.assertTrue(any("model-gateway: expected exactly one workload" in failure for failure in failures))
        self.assertTrue(any("knowledge-indexer: expected exactly one workload" in failure for failure in failures))

    def test_ai_setup_jobs_require_success_and_selected_image(self):
        self.enable_ai()
        job = {"kind": "Job", "metadata": {"uid": "budget-owner", "labels": {
            "greenguard.io/cell": self.cell["cluster_name"],
            "greenguard.io/ai-gate": "budget-bootstrap"}},
            "spec": {"template": {"spec": {"containers": [{"name": "budget-bootstrap", "image": self.release["ai_runtime_image_digests"]["gateway"]}]}}},
            "status": {"succeeded": 1, "conditions": [{"type": "Complete", "status": "True"}]}}
        self.snapshot["items"].append({"kind": "Pod", "metadata": {"ownerReferences": [{"uid": "budget-owner", "controller": True}]},
            "spec": copy.deepcopy(job["spec"]["template"]["spec"]),
            "status": {"phase": "Succeeded", "containerStatuses": [{"name": "budget-bootstrap", "imageID": "containerd://sha256:proof", "state": {"terminated": {"exitCode": 0}}}]}})
        self.snapshot["items"].append(job)
        self.assertFalse(any("AI budget-bootstrap:" in f for f in gate.readiness(self.snapshot, self.release, self.contract)))
        for change in ("failed", "image", "duplicate", "missing-pod", "pod-failed"):
            snapshot = copy.deepcopy(self.snapshot)
            item = snapshot["items"][-1]
            if change == "failed": item["status"]["failed"] = 1
            elif change == "image": item["spec"]["template"]["spec"]["containers"][0]["image"] = "wrong:latest"
            elif change == "duplicate": snapshot["items"].append(copy.deepcopy(item))
            elif change == "missing-pod": snapshot["items"].pop(-2)
            else: snapshot["items"][-2]["status"]["containerStatuses"][0]["state"]["terminated"]["exitCode"] = 1
            with self.subTest(change=change):
                self.assertTrue(any("AI budget-bootstrap:" in f for f in gate.readiness(snapshot, self.release, self.contract)))

    def test_exact_healthy_release_passes(self):
        gate.inputs(self.cell, self.release, self.contract)
        self.assertEqual([], gate.readiness(self.snapshot, self.release, self.contract))

    def test_synthetic_ml_opt_in_requires_digest_and_both_argo_applications(self):
        release = copy.deepcopy(self.release)
        release["ml_synthetic_enabled"] = True
        release["ml_synthetic_scorer_image_digest"] = "ghcr.io/pahuldeepp/grainguard/ml-scoring-synthetic@sha256:" + "f" * 64
        gate.inputs(self.cell, release, self.contract)
        with self.assertRaisesRegex(ValueError, "ml-scoring-synthetic"):
            gate.inputs(self.cell, {**release, "ml_synthetic_scorer_image_digest": ""}, self.contract)
        enabled_applications = copy.deepcopy(self.snapshot)
        for name in ("greenguard-ml-synthetic-data", "greenguard-ml-synthetic-scorer"):
            enabled_applications["items"].append({
                "kind": "Application", "metadata": {"name": name,
                    "labels": {"greenguard.io/cell": self.cell["cluster_name"]}},
                "spec": {"source": {"targetRevision": release["gitops_revision"]}},
                "status": {"sync": {"status": "Synced", "revision": release["gitops_revision"]},
                           "health": {"status": "Healthy"}},
            })
        failures = gate.readiness(enabled_applications, release, self.contract)
        self.assertIn("ml-synthetic-postgres: expected exactly one synthetic ML workload", " ".join(failures))
        without_scorer = copy.deepcopy(enabled_applications)
        without_scorer["items"] = [item for item in without_scorer["items"]
                                    if item["metadata"].get("name") != "greenguard-ml-synthetic-scorer"]
        self.assertIn("greenguard-ml-synthetic-scorer: expected exactly one cell-scoped Argo Application",
                      " ".join(gate.readiness(without_scorer, release, self.contract)))

    def test_synthetic_ml_gate_rejects_empty_runtime_and_bootstrap_containers(self):
        release = copy.deepcopy(self.release)
        release["ml_synthetic_enabled"] = True
        release["ml_synthetic_scorer_image_digest"] = "ghcr.io/pahuldeepp/grainguard/ml-scoring-synthetic@sha256:" + "f" * 64
        snapshot = copy.deepcopy(self.snapshot)
        snapshot.update(account_id=self.cell["account_id"], region=self.cell["region"], environment=self.cell["environment"])
        snapshot["items"].append({"kind": "Namespace", "metadata": {"name": "ml-synthetic", "labels": {
            "greenguard.io/cell": self.cell["cluster_name"], "greenguard.io/isolation": "synthetic-only",
            "istio-injection": "disabled"}, "annotations": {"greenguard.io/terraform-scope": ":".join((
                self.cell["account_id"], self.cell["region"], self.cell["environment"], self.cell["cluster_name"], self.cell["cluster_name"]))}}})
        snapshot["items"].append({"kind": "Deployment", "metadata": {"name": "ml-synthetic-postgres", "namespace": "ml-synthetic",
            "uid": "postgres-uid", "generation": 1, "labels": {"greenguard.io/cell": self.cell["cluster_name"]}},
            "spec": {"replicas": 1, "selector": {"matchLabels": {"app": "pg"}}, "template": {"spec": {"containers": []}}},
            "status": {"observedGeneration": 1, "readyReplicas": 1, "updatedReplicas": 1}})
        failures = " ".join(gate.readiness(snapshot, release, self.contract))
        self.assertIn("ml-synthetic-postgres: expected exactly one runtime container", failures)

    def test_synthetic_ml_gate_rejects_ready_controller_without_owned_ready_pod(self):
        release = copy.deepcopy(self.release)
        release["ml_synthetic_enabled"] = True
        release["ml_synthetic_scorer_image_digest"] = "ghcr.io/pahuldeepp/grainguard/ml-scoring-synthetic@sha256:" + "f" * 64
        snapshot = copy.deepcopy(self.snapshot)
        snapshot.update(account_id=self.cell["account_id"], region=self.cell["region"], environment=self.cell["environment"])
        snapshot["items"].append({"kind": "Namespace", "metadata": {"name": "ml-synthetic", "labels": {
            "greenguard.io/cell": self.cell["cluster_name"], "greenguard.io/isolation": "synthetic-only",
            "istio-injection": "disabled"}, "annotations": {"greenguard.io/terraform-scope": ":".join((
                self.cell["account_id"], self.cell["region"], self.cell["environment"], self.cell["cluster_name"], self.cell["cluster_name"]))}}})
        snapshot["items"].append({"kind": "StatefulSet", "metadata": {"name": "ml-synthetic-postgres", "namespace": "ml-synthetic",
            "uid": "postgres-uid", "generation": 1, "labels": {"greenguard.io/cell": self.cell["cluster_name"]}},
            "spec": {"replicas": 1, "selector": {"matchLabels": {"app": "pg"}}, "template": {"spec": {"containers": [{"name": "postgres", "image": "postgres@sha256:" + "1" * 64}]}}},
            "status": {"observedGeneration": 1, "readyReplicas": 1, "updatedReplicas": 1}})
        failures = " ".join(gate.readiness(snapshot, release, self.contract))
        self.assertIn("ml-synthetic-postgres: expected exactly one active owned Pod", failures)

    def test_argo_application_must_be_synced_healthy_at_selected_gitops_revision(self):
        for mutate in [
            lambda item: item["status"]["sync"].update(status="OutOfSync"),
            lambda item: item["status"]["health"].update(status="Degraded"),
            lambda item: item["status"]["sync"].update(revision="c" * 40),
            lambda item: item["spec"]["source"].update(targetRevision="main"),
        ]:
            candidate = copy.deepcopy(self.snapshot)
            mutate(candidate["items"][-2])
            self.assertIn("Argo sync, health or GitOps revision is not ready", " ".join(
                gate.readiness(candidate, self.release, self.contract)))
        candidate = copy.deepcopy(self.snapshot)
        candidate["items"] = [item for item in candidate["items"] if item["metadata"].get("name") != "greenguard-bff"]
        self.assertIn("expected exactly one cell-scoped Argo Application", " ".join(
            gate.readiness(candidate, self.release, self.contract)))

    def test_every_contract_required_application_must_exist_and_converge(self):
        candidate = copy.deepcopy(self.snapshot)
        candidate["items"] = [item for item in candidate["items"]
                              if item["metadata"].get("name") != "greenguard-edge-routing"]
        self.assertIn("greenguard-edge-routing: expected exactly one cell-scoped Argo Application",
                      " ".join(gate.readiness(candidate, self.release, self.contract)))
        candidate = copy.deepcopy(self.snapshot)
        edge = next(item for item in candidate["items"]
                    if item["metadata"].get("name") == "greenguard-edge-routing")
        edge["status"]["health"]["status"] = "Progressing"
        self.assertIn("greenguard-edge-routing: Argo sync, health or GitOps revision is not ready",
                      " ".join(gate.readiness(candidate, self.release, self.contract)))

    def test_ecr_image_must_use_this_cell_owned_repository_namespace(self):
        cell_hash = hashlib.sha256(self.cell["cluster_name"].encode()).hexdigest()[:16]
        scoped = f"{self.cell['account_id']}.dkr.ecr.{self.cell['region']}.amazonaws.com/greenguard/{self.cell['environment']}/cell-{cell_hash}/bff@sha256:" + "f" * 64
        release = copy.deepcopy(self.release)
        release["deployment_image_digests"]["bff"] = scoped
        gate.inputs(self.cell, release, self.contract)
        release["deployment_image_digests"]["bff"] = f"{self.cell['account_id']}.dkr.ecr.{self.cell['region']}.amazonaws.com/greenguard/bff@sha256:" + "f" * 64
        with self.assertRaises(ValueError):
            gate.inputs(self.cell, release, self.contract)

    def test_deployment_contract_health_path_requires_matching_readiness_probe(self):
        self.snapshot["items"][0]["spec"]["template"]["spec"]["containers"][0]["readinessProbe"]["httpGet"]["path"] = "/healthz"
        self.assertIn("readiness probe differs", " ".join(gate.readiness(self.snapshot, self.release, self.contract)))
        self.snapshot["items"][0]["spec"]["template"]["spec"]["containers"][0]["readinessProbe"] = None
        self.assertIn("readiness probe differs", " ".join(gate.readiness(self.snapshot, self.release, self.contract)))

    def test_exec_readiness_contract_requires_exact_command(self):
        contract = {"requiredApplications": ["greenguard-edge-routing"],
            "releases": [{"name": "bff", "image": "bff", "health": {
            "type": "exec", "command": ["python", "-c", "check-ready"]}}],
            "acceptanceJobs": copy.deepcopy(self.contract["acceptanceJobs"])}
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
        self.assertIn("acceptance Job has not completed successfully", " ".join(
            gate.readiness(self.snapshot, self.release, self.contract)))

    def test_every_declared_acceptance_job_is_required_and_must_succeed(self):
        journey = {
            "name": "authenticated-web-journey",
            "selector": {"greenguard.io/migration-gate": "false",
                         "greenguard.io/acceptance": "authenticated-web"},
            "images": ["bff"],
        }
        self.contract["acceptanceJobs"].append(journey)
        journey_job = {
            "kind": "Job",
            "metadata": {"name": "authenticated-web-journey", "labels": journey["selector"]},
            "spec": {"template": {"spec": {"containers": [
                {"name": "journey", "image": self.image},
            ]}}},
            "status": {"succeeded": 1, "failed": 0,
                       "conditions": [{"type": "Complete", "status": "True"}]},
        }
        gate.inputs(self.cell, self.release, self.contract)
        self.assertIn("expected exactly one completed acceptance Job", " ".join(
            gate.readiness(self.snapshot, self.release, self.contract)))
        self.snapshot["items"].append(copy.deepcopy(journey_job))
        self.assertEqual([], gate.readiness(self.snapshot, self.release, self.contract))
        self.snapshot["items"][-1]["status"] = {"succeeded": 0, "failed": 1, "conditions": []}
        self.assertIn("authenticated-web-journey: acceptance Job has not completed successfully", " ".join(
            gate.readiness(self.snapshot, self.release, self.contract)))

    def test_all_data_jobs_are_required_at_exact_revision_and_image(self):
        production = json.loads((gate.BASE / "contract.json").read_text())
        probes = [job for job in production["acceptanceJobs"] if job["name"] in {
            "kafka-produce-consume", "redis-tenant-cache-roundtrip", "cassandra-tenant-partition-roundtrip", "opensearch-index-search", "clickhouse-roundtrip"}]
        self.assertEqual(len(probes), 5)
        for probe in probes:
            contract = copy.deepcopy(self.contract)
            contract["acceptanceJobs"].append(probe)
            gate.inputs(self.cell, self.release, contract)
            self.assertIn(f'{probe["name"]}: expected exactly one completed acceptance Job', gate.readiness(self.snapshot, self.release, contract))
            owner = probe["images"][0]
            image = (self.release["data_plane_image_digests"].get(owner) or
                     self.release.get(owner + "_image_digest"))
            job = {"kind": "Job", "metadata": {"name": probe["name"], "labels": {
                **probe["selector"], "greenguard.io/acceptance-revision": self.release["gitops_revision"]}},
                "spec": {"template": {"spec": {"containers": [{"name": "probe", "image": image}]}}},
                "status": {"succeeded": 1, "failed": 0, "conditions": [{"type": "Complete", "status": "True"}]}}
            snapshot = copy.deepcopy(self.snapshot)
            snapshot["items"].append(job)
            with self.subTest(probe=probe["name"]):
                self.assertEqual(gate.readiness(snapshot, self.release, contract), [])
                job["metadata"]["labels"]["greenguard.io/acceptance-revision"] = "0" * 40
                self.assertIn(f'{probe["name"]}: acceptance Job revision differs from the exact release', gate.readiness(snapshot, self.release, contract))
                job["metadata"]["labels"]["greenguard.io/acceptance-revision"] = self.release["gitops_revision"]
                job["status"]["failed"] = 1
                self.assertIn(f'{probe["name"]}: acceptance Job has not completed successfully', gate.readiness(snapshot, self.release, contract))
                job["status"]["failed"] = 0
                job["spec"]["template"]["spec"]["containers"].append({"name": "unowned", "image": "example.test/admin:latest"})
                self.assertIn(f'{probe["name"]}: acceptance tools differ from immutable release inputs', gate.readiness(snapshot, self.release, contract))

    def test_acceptance_job_contract_is_extensible_but_postgres_gate_is_mandatory(self):
        contract = copy.deepcopy(self.contract)
        contract["acceptanceJobs"].append({
            "name": "data-plane-smoke",
            "selector": {"greenguard.io/migration-gate": "false",
                          "greenguard.io/acceptance": "data-plane"},
            "images": ["bff"],
        })
        gate.inputs(self.cell, self.release, contract)
        contract["acceptanceJobs"] = [job for job in contract["acceptanceJobs"]
                                      if job["name"] != "postgres-owner-migration-gate"]
        with self.assertRaisesRegex(ValueError, "must require the PostgreSQL owner migration gate"):
            gate.inputs(self.cell, self.release, contract)

    def test_acceptance_jobs_reject_duplicate_selectors_and_unknown_images(self):
        contract = copy.deepcopy(self.contract)
        contract["acceptanceJobs"].append({
            "name": "duplicate-selector",
            "selector": self.contract["acceptanceJobs"][0]["selector"],
            "images": ["bff"],
        })
        with self.assertRaisesRegex(ValueError, "selectors must be mutually exclusive"):
            gate.inputs(self.cell, self.release, contract)
        contract["acceptanceJobs"][1]["selector"] = {
            "greenguard.io/migration-gate": "true",
            "greenguard.io/acceptance": "postgres",
        }
        with self.assertRaisesRegex(ValueError, "selectors must be mutually exclusive"):
            gate.inputs(self.cell, self.release, contract)
        contract["acceptanceJobs"][1]["selector"] = {
            "greenguard.io/migration-gate": "false",
            "greenguard.io/acceptance": "unknown-image",
        }
        contract["acceptanceJobs"][1]["images"] = ["unpublished-test-runner"]
        with self.assertRaisesRegex(ValueError, "absent from the immutable release inventory"):
            gate.inputs(self.cell, self.release, contract)

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
        with patch.object(gate, "command", side_effect=[self.cell["account_id"], json.dumps({"cluster": cluster}), json.dumps(config), "ok", json.dumps(self.snapshot), json.dumps({"items": []}), "applications.argoproj.io\n"]) as command:
            self.assertEqual(self.snapshot, gate.collect(self.cell, "explicit-kubeconfig"))
            args = [call.args[0] for call in command.call_args_list]
            self.assertEqual(["sts", "eks", "--kubeconfig", "--kubeconfig", "--kubeconfig", "--kubeconfig", "--kubeconfig"], [arg[1] for arg in args])
            self.assertIn("deployments,statefulsets,replicasets,pods,cronjobs,jobs", args[4])
            self.assertIn("applications.argoproj.io", args[5])
            self.assertIn(f"greenguard.io/cell={self.cell['cluster_name']}", args[5])
            self.assertTrue(all("apply" not in arg and "delete" not in arg and "update-kubeconfig" not in arg for arg in args))

    def test_optional_rollout_discovery_collects_and_blocks_replaced_deployment(self):
        cluster = {"arn": "arn:aws:eks:us-west-2:123456789012:cluster/gg-test", "status": "ACTIVE", "endpoint": "https://correct.eks", "certificateAuthority": {"data": "test-ca"}}
        config = {"clusters": [{"cluster": {"server": "https://correct.eks", "certificate-authority-data": "test-ca"}}]}
        snapshot = copy.deepcopy(self.snapshot)
        rollout = snapshot["items"].pop(0)
        rollout["kind"] = "Rollout"
        responses = [self.cell["account_id"], json.dumps({"cluster": cluster}), json.dumps(config), "ok", json.dumps(snapshot), json.dumps({"items": []}), "rollouts.argoproj.io\n", json.dumps({"items": [rollout]})]
        with patch.object(gate, "command", side_effect=responses) as command:
            collected = gate.collect(self.cell, "explicit-kubeconfig")
            self.assertEqual(8, command.call_count)
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
