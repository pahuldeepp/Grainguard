"""Offline ownership and mount-isolation checks for tenant bootstrap credentials."""
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TF = ROOT / "infra/terraform/disposable"
GITOPS = ROOT / "infra/gitops/disposable"
PROFILE = ROOT / "infra/helm/greenguard-service/values/tenant-bootstrap-worker.yaml"


def ruby_yaml_load(text, stream=False):
    expression = "YAML.load_stream(STDIN.read).compact.to_json" if stream else "YAML.safe_load(STDIN.read).to_json"
    result = subprocess.run(["ruby", "-ryaml", "-rjson", "-e", f"print({expression})"], input=text, capture_output=True, text=True, check=False)
    if result.returncode:
        raise AssertionError(f"YAML parse failed: {result.stderr}")
    return json.loads(result.stdout)


class TenantBootstrapSecretScopeTests(unittest.TestCase):
    def test_ephemeral_secret_inputs_and_four_shard_secret_versions_are_wired(self):
        shard = (TF / "shard-secret-values.tf").read_text()
        runtime = (TF / "runtime-secrets.tf").read_text()
        read_replicas = (TF / "read-replicas.tf").read_text()
        secret_vars = (TF / "secrets.tf").read_text()
        self.assertIn('variable "tenant_bootstrap_passwords"', shard)
        block = shard.split('variable "tenant_bootstrap_passwords"', 1)[1].split("\n}", 1)[0]
        self.assertIn("ephemeral   = true", block)
        self.assertIn("sensitive   = true", block)
        self.assertIn('"registry.json" = jsonencode', shard)
        self.assertIn('tenant_bootstrap_${shard_id}', shard)
        self.assertIn('tenant_bootstrap_secret_versions', runtime)
        self.assertIn('tenant_bootstrap_secret_sources', runtime)
        self.assertIn('aws_secretsmanager_secret_version.tenant_bootstrap', runtime)
        self.assertIn('"${shard_id}/tenant-bootstrap"', read_replicas)
        self.assertIn('tenant-bootstrap/', secret_vars)
        self.assertIn('tenant_bootstrap_secret_versions,', runtime)
        self.assertIn('tenant_bootstrap_secret_sources,', runtime)

    def test_role_provisioner_is_separate_and_login_is_limited(self):
        sql = (GITOPS / "rds-bootstrap-chart/files/provision-tenant-bootstrap-login.sql").read_text()
        self.assertIn("NOINHERIT NOBYPASSRLS", sql)
        self.assertIn("GRANT tenant_ownership_bootstrap TO", sql)
        self.assertIn("WITH INHERIT FALSE, SET TRUE", sql)
        self.assertIn("REVOKE CONNECT ON DATABASE postgres FROM PUBLIC", sql)
        self.assertIn("REVOKE CONNECT ON DATABASE template1 FROM PUBLIC", sql)
        for database in (
            "greenguard_telemetry", "greenguard_read", "greenguard_jobs",
            "greenguard_sagas", "greenguard_hardware", "greenguard_inventory",
            "greenguard_alerts", "greenguard_risk", "greenguard_notifications",
        ):
            self.assertIn(f"GRANT CONNECT ON DATABASE {database}", sql)
        self.assertNotIn("greenguard_control", sql)
        self.assertNotIn("greenguard_billing", sql)

    def test_worker_mounts_only_registry_files_and_separate_ca(self):
        values = ruby_yaml_load(PROFILE.read_text())
        mounts = values["container"]["volumeMounts"]
        self.assertEqual(
            mounts,
            [
                {"name": "tenant-bootstrap-registries", "mountPath": "/var/run/greenguard/tenant-bootstrap", "readOnly": True},
                {"name": "tenant-bootstrap-owner-ca", "mountPath": "/var/run/greenguard/tenant-bootstrap/ca", "readOnly": True},
            ],
        )
        registry_volume = next(volume for volume in values["volumes"] if volume["name"] == "tenant-bootstrap-registries")
        sources = registry_volume["projected"]["sources"]
        self.assertEqual(len(sources), 4)
        for index, source in enumerate(sources, 1):
            secret = source["secret"]
            self.assertEqual(secret["name"], f"greenguard-s{index}-tenant-bootstrap")
            self.assertEqual(secret["items"], [{"key": "registry.json", "path": f"s{index}.json"}])
        ca = next(volume for volume in values["volumes"] if volume["name"] == "tenant-bootstrap-owner-ca")["secret"]
        self.assertEqual(ca, {"secretName": "greenguard-rds-ca", "items": [{"key": "ca.pem", "path": "ca.crt"}]})
        self.assertNotIn("TENANT_BOOTSTRAP_PASSWORD", PROFILE.read_text())

    def test_worker_helm_render_keeps_secret_mounts_scoped_and_read_only(self):
        image = f"example.test/tenant-control-plane@sha256:{'a' * 64}"
        result = subprocess.run(
            ["helm", "template", "worker", str(ROOT / "infra/helm/greenguard-service"), "--namespace", "greenguard", "--set-string", f"image={image}", "-f", str(PROFILE)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        objects = ruby_yaml_load(result.stdout, stream=True)
        deployment = next(item for item in objects if item["kind"] == "Deployment")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        mounts = container["volumeMounts"]
        registry_mount = next(mount for mount in mounts if mount["name"] == "tenant-bootstrap-registries")
        ca_mount = next(mount for mount in mounts if mount["name"] == "tenant-bootstrap-owner-ca")
        self.assertTrue(registry_mount["readOnly"])
        self.assertTrue(ca_mount["readOnly"])
        pod_volumes = deployment["spec"]["template"]["spec"]["volumes"]
        registry = next(volume for volume in pod_volumes if volume["name"] == "tenant-bootstrap-registries")
        self.assertEqual(
            {source["secret"]["name"]: [item["key"] for item in source["secret"]["items"]] for source in registry["projected"]["sources"]},
            {f"greenguard-s{index}-tenant-bootstrap": ["registry.json"] for index in range(1, 5)},
        )
        self.assertNotIn("greenguard-s1-tenant-bootstrap", json.dumps(container.get("envFrom", [])))
        self.assertNotIn("TENANT_BOOTSTRAP_PASSWORD", json.dumps(container))


if __name__ == "__main__":
    unittest.main()
