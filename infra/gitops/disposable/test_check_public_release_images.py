import importlib.util
import io
import json
import unittest
from pathlib import Path


path = Path(__file__).with_name("check-public-release-images.py")
spec = importlib.util.spec_from_file_location("public_images", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Response(io.BytesIO):
    status = 200

    def __init__(self, payload=b"", digest=None):
        super().__init__(payload)
        self.headers = {"Docker-Content-Digest": digest}


class PublicImagePreflightTest(unittest.TestCase):
    def setUp(self):
        self.contract = {"releases": [{"image": "bff"}, {"image": "bff"}, {"image": "dashboard"}]}
        self.owners = ("control", "billing", "telemetry", "projection", "jobs", "saga",
                       "hardware", "inventory", "alerts", "risk", "notifications")
        self.digest = "sha256:" + "a" * 64
        runtime = {name: f"ghcr.io/pahuldeepp/grainguard/{name}@{self.digest}" for name in ("bff", "dashboard")}
        platform_names = ("otel-collector", "prometheus", "grafana", "tempo", "loki", "pgbouncer",
                          "kafka-topics", "kafka-connect", "connector-registration", "opensearch", "cassandra",
                          "mqtt", "clickhouse", "clamav", "redis")
        platform = {name: f"ghcr.io/pahuldeepp/grainguard/{name}@{self.digest}" for name in platform_names}
        self.inputs = {
            "gitops_revision": "b" * 40,
            "deployment_image_digests": runtime,
            "migration_image_digests": {
                owner: f"ghcr.io/pahuldeepp/grainguard/migration-{owner}@{self.digest}"
                for owner in self.owners
            },
            "migration_gate_image_digest": f"ghcr.io/pahuldeepp/grainguard/migration-gate@{self.digest}",
            "migration_sql_image_digest": f"ghcr.io/pahuldeepp/grainguard/migration-sql@{self.digest}",
            "ml_synthetic_scorer_image_digest": f"ghcr.io/pahuldeepp/grainguard/ml-scoring-synthetic@{self.digest}",
            "observability_image_digests": {name: platform[name] for name in ("otel-collector", "prometheus", "grafana", "tempo", "loki")},
            "data_plane_image_digests": {name: platform[name] for name in ("pgbouncer", "kafka-topics", "kafka-connect", "connector-registration", "redis")},
            "opensearch_image_digest": platform["opensearch"],
            "cassandra_image_digest": platform["cassandra"],
            "mqtt_image_digest": platform["mqtt"],
            "clickhouse_image_digest": platform["clickhouse"],
            "ai_runtime_image_digests": {
                "knowledge": f"ghcr.io/pahuldeepp/grainguard/knowledge-service@{self.digest}",
                "indexer": f"ghcr.io/pahuldeepp/grainguard/knowledge-indexer@{self.digest}",
                "parser": f"ghcr.io/pahuldeepp/grainguard/knowledge-parser@{self.digest}",
                "advisor": f"ghcr.io/pahuldeepp/grainguard/grain-advisor@{self.digest}",
                "gateway": f"ghcr.io/pahuldeepp/grainguard/model-gateway@{self.digest}",
                "usage": f"ghcr.io/pahuldeepp/grainguard/model-gateway-usage@{self.digest}",
                "mcp": f"ghcr.io/pahuldeepp/grainguard/mcp-gateway@{self.digest}",
                "clamav": platform["clamav"]
            },
        }

    def test_exact_inventory(self):
        self.assertEqual(len(module.inventory(self.inputs, self.contract)), 38)

    def test_rejects_missing_or_foreign_synthetic_scorer_image(self):
        original = self.inputs.pop("ml_synthetic_scorer_image_digest")
        with self.assertRaises(ValueError):
            module.inventory(self.inputs, self.contract)
        self.inputs["ml_synthetic_scorer_image_digest"] = "ghcr.io/untrusted/ml-scoring-synthetic@" + self.digest
        with self.assertRaises(ValueError):
            module.inventory(self.inputs, self.contract)
        self.inputs["ml_synthetic_scorer_image_digest"] = original

    def test_rejects_missing_image(self):
        del self.inputs["deployment_image_digests"]["bff"]
        with self.assertRaises(ValueError):
            module.inventory(self.inputs, self.contract)

    def test_rejects_mutable_or_foreign_image(self):
        for value in ("ghcr.io/pahuldeepp/grainguard/bff:latest", f"ghcr.io/other/bff@{self.digest}"):
            with self.subTest(value=value):
                self.inputs["deployment_image_digests"]["bff"] = value
                with self.assertRaises(ValueError):
                    module.inventory(self.inputs, self.contract)

    def test_rejects_wrong_revision(self):
        self.inputs["gitops_revision"] = "latest"
        with self.assertRaises(ValueError):
            module.inventory(self.inputs, self.contract)

    def test_rejects_missing_owner_image(self):
        del self.inputs["migration_image_digests"]["risk"]
        with self.assertRaises(ValueError):
            module.inventory(self.inputs, self.contract)

    def test_rejects_foreign_tool_digest(self):
        self.inputs["migration_gate_image_digest"] = f"ghcr.io/elsewhere/kubectl@{self.digest}"
        with self.assertRaises(ValueError):
            module.inventory(self.inputs, self.contract)

    def test_anonymous_manifest_exact_digest(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            if len(requests) == 1:
                return Response(json.dumps({"token": "private-test-token"}).encode())
            return Response(digest=self.digest)

        module.anonymous_manifest("migration-control", self.inputs["migration_image_digests"]["control"], opener)
        self.assertEqual(requests[1].get_method(), "HEAD")
        self.assertEqual(requests[1].get_header("Authorization"), "Bearer private-test-token")
        self.assertTrue(requests[1].full_url.endswith("/manifests/" + self.digest))

    def test_rejects_registry_digest_mismatch(self):
        calls = 0

        def opener(request, timeout):
            nonlocal calls
            calls += 1
            return Response(json.dumps({"token": "token"}).encode()) if calls == 1 else Response(
                digest="sha256:" + "c" * 64
            )

        with self.assertRaises(ValueError):
            module.anonymous_manifest("bff", self.inputs["deployment_image_digests"]["bff"], opener)


if __name__ == "__main__":
    unittest.main()
