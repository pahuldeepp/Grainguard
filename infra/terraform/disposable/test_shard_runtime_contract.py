import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
REPO = ROOT.parents[2]


def local_block(source: str, name: str) -> str:
    match = re.search(rf"\b{name}\s*=\s*\{{", source)
    if not match:
        raise AssertionError(f"Terraform local {name} is missing")
    start = match.end()
    depth = 1
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index]
    raise AssertionError(f"Terraform local {name} is not closed")


class ShardRuntimeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gitops = (ROOT / "gitops.tf").read_text()
        cls.shards = (ROOT / "shard-secret-values.tf").read_text()
        cls.contract = json.loads(
            (REPO / "infra/gitops/disposable/contract.json").read_text()
        )
        cls.releases = {release["name"] for release in cls.contract["releases"]}

    def test_every_sharded_runtime_release_is_present_in_deployment_contract(self):
        registry_map = local_block(self.gitops, "shard_registry_by_release")
        mappings = {
            name: (service, secret, env)
            for name, service, secret, env in re.findall(
                r'"([a-z0-9-]+)"\s*=\s*\{\s*service\s*=\s*"([a-z0-9-]+)"\s*,\s*secret\s*=\s*"([a-z0-9-]+)"\s*,\s*env\s*=\s*"([A-Z_]+)"\s*\}',
                registry_map,
            )
        }
        self.assertTrue(mappings, "Terraform shard registry map could not be parsed")
        self.assertEqual(set(mappings) - self.releases, set())
        self.assertEqual(
            {value[2] for value in mappings.values()},
            {
                "SHARD_REGISTRY_FILE",
                "READ_SHARD_REGISTRY_FILE",
                "INVENTORY_SHARD_REGISTRY_FILE",
                "INVENTORY_AUDIT_SHARD_REGISTRY_FILE",
            },
        )
        self.assertEqual(mappings["read-api"][2], "READ_SHARD_REGISTRY_FILE")
        self.assertEqual(
            mappings["tenant-control-plane"][2], "INVENTORY_SHARD_REGISTRY_FILE"
        )
        self.assertEqual(
            mappings["audit-export-worker"][2],
            "INVENTORY_AUDIT_SHARD_REGISTRY_FILE",
        )

        # Each owner profile is consumed by a runnable release. Aliases use
        # separate least-privilege registry Secrets rather than the API role.
        owner_profiles = {
            "device-service": "device-service",
            "telemetry-ingest": "telemetry-ingest",
            "projection-builder": "projection-builder",
            "risk-engine": "risk-engine",
            "workflow-alerts": "workflow-alerts",
            "jobs-worker": "jobs-worker",
            "notification-service": "notification-service",
            "saga-orchestrator": "saga-api",
            "hardware-service": "hardware-service-worker",
            "read-api": "read-api",
            "audit-export-worker": "audit-export-worker",
        }
        for owner, release in owner_profiles.items():
            with self.subTest(owner=owner):
                self.assertIn(release, mappings)
                self.assertEqual(mappings[release][0], owner)

        for release, service, secret in (
            ("device-saga-worker", "device-service", "device-service"),
            ("device-tenant-projector", "device-service", "inventory-projector"),
            ("inventory-entitlement-projector", "device-service", "inventory-projector"),
            ("telemetry-entitlement-projector", "telemetry-ingest", "telemetry-entitlement-projector"),
            ("read-entitlement-projector", "read-entitlement-projector", "read-entitlement-projector"),
            ("tenant-control-plane", "audit-export-worker", "audit-export-worker"),
        ):
            with self.subTest(release=release):
                self.assertEqual(mappings[release][:2], (service, secret))

    def test_registry_mount_is_read_only_and_tls_ca_is_supplied(self):
        self.assertIn('mountPath = "/run/greenguard-shards", readOnly = true', self.gitops)
        self.assertIn('value = "/run/greenguard-shards/registry.json"', self.gitops)
        self.assertIn('defaultMode = 288', self.gitops)
        self.assertIn('postgresReadReplica = { caSecretName = "greenguard-rds-ca" }', self.gitops)
        self.assertIn('sslrootcert=/etc/greenguard/rds/ca.pem', self.shards)

    def test_production_registry_builds_four_shards_and_writer_profiles_have_replica_urls(self):
        profiles = local_block(self.shards, "shard_service_profiles")
        for shard_id in ("s1", "s2", "s3", "s4"):
            with self.subTest(shard=shard_id):
                self.assertIn(f'"{shard_id}"', self.shards)
        self.assertIn("replicaUrls = [for replica_id, replica in aws_db_instance.read_replica", self.shards)
        self.assertIn('formatVersion = 1, service = service, database = profile.database', self.shards)
        self.assertIn("var.shard_registry_passwords[service][shard_id] != \"\"", self.shards)
        self.assertIn("var.shard_registry_passwords[service][shard_id] == var.shard_role_passwords[shard_id][profile.password_key]", self.shards)
        self.assertTrue(profiles.strip())


if __name__ == "__main__":
    unittest.main()
