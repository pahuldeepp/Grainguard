"""Offline render contracts; these do not prove Kubernetes runtime behavior."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

CHART = Path(__file__).resolve().parent
NAMES = {"knowledge": "knowledge-service", "indexer": "knowledge-indexer", "parser": "knowledge-parser", "advisor": "grain-advisor", "gateway": "model-gateway", "usage": "model-gateway-usage", "mcp": "mcp-gateway"}


def fixture():
    return {
        "enabled": True, "cell": "test-cell", "environment": "dev", "revision": "a" * 40,
        "scopeIdentity": "123456789012:ca-central-1:dev:test-cell:test-cell", "secretSyncEpoch": "offline-fixture",
        "rdsHost": "database.test.rds.amazonaws.com", "rdsCIDRs": ["10.0.0.0/24"],
        "externalHTTPSCIDRs": ["203.0.113.1/32"], "kubernetesAPICIDRs": ["10.1.0.1/32"],
        "knowledgeAPIRoleArn": "arn:aws:iam::123456789012:role/knowledge-api",
        "knowledgeIndexerRoleArn": "arn:aws:iam::123456789012:role/knowledge-indexer",
        "podIdentityAssociationsReady": True,
        "images": dict({key: "ghcr.io/pahuldeepp/grainguard/" + name + "@sha256:" + "b" * 64 for key, name in NAMES.items()}, clamav="clamav/clamav@sha256:" + "c" * 64),
        "providers": {
            "authIssuer": "https://issuer.example/", "authAudience": "test-audience", "authTokenMode": "audience", "authClientIds": [], "authJwksUrl": "https://issuer.example/jwks",
            "delegatedIssuer": "https://app.example/delegated", "delegatedJwksUrl": "https://app.example/jwks",
            "pineconeIndexHost": "https://index.example", "voyageUrl": "https://api.voyageai.com/v1", "anthropicUrl": "https://api.anthropic.com/v1",
            "embeddingModel": "explicit-test-embedding", "rerankerModel": "explicit-test-reranker", "answerModel": "explicit-test-answer",
            "s3Bucket": "test-cell-documents", "s3Region": "ca-central-1", "s3KmsKeyArn": "arn:aws:kms:ca-central-1:123456789012:key/test",
            "kafkaBootstrapServers": "kafka.greenguard.svc.cluster.local:29092", "clamavHost": "clamav.greenguard.svc.cluster.local",
        },
    }


def render(values=None, namespace="greenguard"):
    with tempfile.TemporaryDirectory(prefix="gg-ai-render-") as temp:
        command = ["helm", "template", "ai", str(CHART), "--namespace", namespace]
        if values is not None:
            source = Path(temp) / "values.json"
            source.write_text(json.dumps(values))
            command += ["-f", str(source)]
        result = subprocess.run(command, text=True, capture_output=True)
        if result.returncode:
            raise ValueError(result.stderr)
        parser = subprocess.run(["ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_stream(STDIN.read).compact)"], input=result.stdout, text=True, capture_output=True, check=True)
        return json.loads(parser.stdout)


class ChartContracts(unittest.TestCase):
    def test_disabled_is_empty(self):
        self.assertEqual(render(), [])

    def test_enabled_requires_scope_and_prerequisites(self):
        for field, value in [("scopeIdentity", ""), ("secretSyncEpoch", ""), ("podIdentityAssociationsReady", False), ("rdsCIDRs", []), ("externalHTTPSCIDRs", ["0.0.0.0/0"]), ("parserRuntimeClassName", "runc"), ("revision", "main"), ("environment", "production")]:
            with self.subTest(field=field):
                values = fixture(); values[field] = value
                with self.assertRaises(ValueError): render(values)
        with self.assertRaises(ValueError): render(fixture(), namespace="other")

    def test_cidrs_reject_invalid_ipv4_and_overbroad_prefixes(self):
        for cidr in ("256.1.2.3/24", "10.0.0.0/7", "10.0.0.0/33", "10.0.0.0/0", "10.0.0/24", "2001:db8::/64"):
            with self.subTest(cidr=cidr):
                values = fixture(); values["rdsCIDRs"] = [cidr]
                with self.assertRaises(ValueError): render(values)
        values = fixture(); values["rdsCIDRs"] = ["10.0.0.0/8", "192.0.2.1/32"]
        self.assertTrue(render(values))

    def test_immutable_images_and_exact_ecr_scope(self):
        values = fixture()
        for image in ["latest", "ghcr.io/foreign/knowledge-service@sha256:" + "b" * 64, "123456789099.dkr.ecr.ca-central-1.amazonaws.com/greenguard/dev/cell-test/knowledge-service@sha256:" + "b" * 64]:
            values["images"]["knowledge"] = image
            with self.assertRaises(ValueError): render(values)
        cell = hashlib.sha256(b"test-cell").hexdigest()[:16]
        values["images"]["knowledge"] = "123456789012.dkr.ecr.ca-central-1.amazonaws.com/greenguard/dev/cell-" + cell + "/knowledge-service@sha256:" + "b" * 64
        self.assertTrue(render(values))

    def test_external_urls_never_allow_http_or_credentials(self):
        for key in ["authIssuer", "authJwksUrl", "delegatedIssuer", "delegatedJwksUrl", "pineconeIndexHost", "voyageUrl", "anthropicUrl"]:
            values = fixture(); values["providers"][key] = "http://provider.example"
            with self.subTest(key=key), self.assertRaises(ValueError): render(values)

    def test_cognito_access_tokens_require_exact_client_allowlist(self):
        values = fixture()
        values["providers"].update(authTokenMode="cognito-access", authAudience="", authClientIds=["webclient123", "mobileclient456"])
        rendered = render(values)
        knowledge = next(item for item in rendered if item["kind"] == "Deployment" and item["metadata"]["name"] == "knowledge-service")
        env = knowledge["spec"]["template"]["spec"]["containers"][0]["env"]
        self.assertIn({"name": "AUTH_TOKEN_MODE", "value": "cognito-access"}, env)
        self.assertIn({"name": "AUTH_CLIENT_IDS", "value": "webclient123,mobileclient456"}, env)
        for changes in ({"authClientIds": []}, {"authAudience": "unexpected"}, {"authTokenMode": "unknown"}):
            bad = copy.deepcopy(values); bad["providers"].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError): render(bad)

    def test_actual_entrypoints_and_private_files(self):
        values = fixture(); values["providers"].update(authTokenMode="cognito-access", authAudience="", authClientIds=["web-client", "mobile-client"])
        api = next(item for item in render(values) if item["kind"] == "Deployment" and item["metadata"]["name"] == "knowledge-service")
        env = {item["name"]: item.get("value") for item in api["spec"]["template"]["spec"]["containers"][0]["env"]}
        self.assertEqual(env["AUTH_TOKEN_MODE"], "cognito-access")
        self.assertEqual(env["AUTH_CLIENT_IDS"], "web-client,mobile-client")
        values["providers"]["authClientIds"] = []
        with self.assertRaises(ValueError): render(values)
        objects = render(fixture())
        deployments = {item["metadata"]["name"]: item for item in objects if item["kind"] == "Deployment"}
        self.assertEqual(len(deployments), 13)
        for name, item in deployments.items():
            pod = item["spec"]["template"]["spec"]
            self.assertEqual(pod["securityContext"]["runAsUser"], 10001)
            for container in pod.get("initContainers", []) + pod["containers"]:
                self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
                self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
                self.assertEqual(container["securityContext"]["capabilities"]["drop"], ["ALL"])
        self.assertEqual(deployments["knowledge-service"]["spec"]["template"]["spec"]["serviceAccountName"], "knowledge-api")
        indexer = deployments["knowledge-indexer"]["spec"]["template"]["spec"]
        self.assertEqual(indexer["serviceAccountName"], "knowledge-indexer")
        self.assertEqual(indexer["nodeSelector"], {"kubernetes.io/arch": "amd64"})
        self.assertTrue(indexer["automountServiceAccountToken"])
        gateway = deployments["model-gateway"]["spec"]["template"]["spec"]
        self.assertFalse(gateway["automountServiceAccountToken"])
        self.assertIn("os.chmod", gateway["initContainers"][0]["command"][-1])
        self.assertIn("0o600", gateway["initContainers"][0]["command"][-1])
        self.assertTrue(next(m for m in gateway["containers"][0]["volumeMounts"] if m["name"] == "private")["readOnly"])
        self.assertEqual(gateway["containers"][0]["command"], ["/model-gateway"])
        self.assertEqual(gateway["terminationGracePeriodSeconds"], 150)
        worker_dsn = next(entry for entry in indexer["containers"][0]["env"] if entry["name"] == "KNOWLEDGE_DATABASE_URL")
        self.assertEqual(worker_dsn["valueFrom"]["secretKeyRef"], {"name": "greenguard-knowledge-worker-runtime", "key": "database-url"})
        source = next(volume for volume in indexer["volumes"] if volume["name"] == "source")["projected"]["sources"]
        self.assertNotIn("database-url", [item["key"] for item in source[0]["secret"]["items"]])

    def test_migrations_and_actual_parser_gate_precede_runtime(self):
        objects = render(fixture())
        jobs = [item for item in objects if item["kind"] == "Job"]
        self.assertEqual(sorted(item["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"] for item in jobs), ["10", "10", "10", "12", "5"])
        scripts = {item["metadata"]["name"]: item["data"] for item in objects if item["kind"] == "ConfigMap"}
        for data in scripts.values():
            for name, code in data.items():
                if name.endswith(".py"): ast.parse(code)
        self.assertIn("statuses[0]", scripts["ai-parser-gate"]["gate.py"])
        self.assertIn("'runsc'", scripts["ai-parser-gate"]["gate.py"])
        migrations = [job for job in jobs if job["metadata"]["name"].startswith("ai-model-gateway-migrate")]
        self.assertEqual(migrations[0]["spec"]["template"]["spec"]["containers"][0]["command"], ["/model-gateway-migrate"])
        budget = next(job for job in jobs if job["metadata"]["name"].startswith("ai-budget-bootstrap"))
        self.assertEqual(budget["spec"]["template"]["spec"]["containers"][0]["command"], ["/model-gateway-budget-bootstrap"])
        reconcile = next(item for item in objects if item["kind"] == "CronJob" and item["metadata"]["name"] == "ai-budget-reconcile")
        self.assertEqual(reconcile["spec"]["timeZone"], "Etc/UTC")
        self.assertEqual(reconcile["spec"]["schedule"], "0 0 * * *")
        self.assertEqual(reconcile["spec"]["startingDeadlineSeconds"], 86400)
        self.assertEqual(reconcile["spec"]["jobTemplate"]["spec"]["backoffLimit"], 2)

    def test_parent_applications_own_exact_children_and_scope(self):
        values = {"cell": "test-cell", "revision": "a" * 40, "repositoryUrl": "https://github.com/example/project.git", "aiRuntime": fixture()}
        values["observabilityImages"] = {name: "registry.example/fixture@sha256:" + "d" * 64 for name in ["otel-collector", "prometheus", "grafana", "tempo", "loki"]}
        with tempfile.TemporaryDirectory(prefix="gg-ai-parent-") as temp:
            path = Path(temp) / "values.json"; path.write_text(json.dumps(values))
            rendered = subprocess.run(["helm", "template", "apps", str(CHART.parent / "applications-chart"), "--namespace", "argocd", "-f", str(path)], capture_output=True, text=True, check=True)
            parsed = subprocess.run(["ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_stream(STDIN.read).compact)"], input=rendered.stdout, capture_output=True, text=True, check=True)
            children = {item["metadata"]["name"]: item for item in json.loads(parsed.stdout) if item["kind"] == "Application" and item["metadata"]["name"].startswith("greenguard-ai-")}
            self.assertEqual(set(children), {"greenguard-ai-runtime", "greenguard-ai-database-bootstrap"})
            self.assertEqual(children["greenguard-ai-runtime"]["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"], "30")
            self.assertEqual(children["greenguard-ai-database-bootstrap"]["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"], "22")
            for child in children.values():
                self.assertEqual(child["spec"]["destination"]["namespace"], "greenguard")
                self.assertEqual(child["spec"]["source"]["targetRevision"], "a" * 40)
                self.assertEqual(child["metadata"]["finalizers"], ["resources-finalizer.argocd.argoproj.io"])

    def test_owned_tls_redis_and_clamav_signature_disposal(self):
        objects = render(fixture())
        deployments = {item["metadata"]["name"]: item for item in objects if item["kind"] == "Deployment"}
        redis = deployments["ai-redis"]["spec"]["template"]["spec"]
        self.assertEqual(redis["containers"][0]["env"][0]["name"], "REDISCLI_AUTH")
        self.assertIn("port 0", redis["initContainers"][0]["command"][-1])
        self.assertIn("tls-port 6379", redis["initContainers"][0]["command"][-1])
        password_copy = redis["initContainers"][0]["command"][-1]
        self.assertIn("[A-Za-z0-9_-]{32,128}", password_copy)
        self.assertIn("requirepass '+password", password_copy)
        for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
            command = redis["containers"][0][probe]["exec"]["command"][-1]
            self.assertIn("-h 127.0.0.1", command)
            self.assertIn("--sni ai-redis.greenguard.svc.cluster.local", command)
        clamav = deployments["clamav"]["spec"]["template"]["spec"]
        self.assertEqual([container["name"] for container in clamav["containers"]], ["clamd", "freshclam"])
        self.assertIn("clamdscan", clamav["containers"][0]["startupProbe"]["exec"]["command"])
        claims = [item for item in objects if item["kind"] == "PersistentVolumeClaim"]
        self.assertEqual(claims[0]["spec"]["storageClassName"], "greenguard-disposable-gp3")
        self.assertEqual(claims[0]["metadata"]["name"], "ai-clamav-signatures")
        scratch = next(volume for volume in clamav["volumes"] if volume["name"] == "scratch")
        self.assertEqual(scratch["emptyDir"]["sizeLimit"], "256Mi")
        self.assertEqual(sum(int(container["resources"]["limits"]["memory"].replace("Gi", "")) for container in clamav["containers"]), 6)

    def test_knowledge_analytics_does_not_mount_unused_kafka_username_secret_file(self):
        deployments = {item["metadata"]["name"]: item for item in render(fixture()) if item["kind"] == "Deployment"}
        analytics = deployments["knowledge-analytics"]["spec"]["template"]["spec"]
        source = next(volume for volume in analytics["volumes"] if volume["name"] == "source")
        projected = source["projected"]["sources"]
        self.assertEqual([entry["secret"]["name"] for entry in projected], ["greenguard-knowledge-worker-runtime"])
        for deployment in deployments.values():
            pod_spec = deployment["spec"]["template"]["spec"]
            source_volume = next((volume for volume in pod_spec["volumes"] if volume["name"] == "source"), None)
            if source_volume and "projected" in source_volume:
                for entry in source_volume["projected"]["sources"]:
                    self.assertTrue(entry["secret"].get("items"), deployment["metadata"]["name"])

    def test_parser_admission_and_mesh_principals(self):
        objects = render(fixture())
        policy = next(item for item in objects if item["kind"] == "ValidatingAdmissionPolicy")
        self.assertEqual(policy["spec"]["failurePolicy"], "Fail")
        self.assertIn(fixture()["images"]["parser"], policy["spec"]["validations"][2]["expression"])
        peer = next(item for item in objects if item["kind"] == "PeerAuthentication")
        self.assertEqual(peer["spec"]["mtls"]["mode"], "STRICT")
        auth = next(item for item in objects if item["kind"] == "AuthorizationPolicy" and item["metadata"]["name"] == "grain-advisor-callers")
        self.assertEqual(auth["spec"]["rules"][0]["from"][0]["source"]["principals"], ["cluster.local/ns/greenguard/sa/bff-greenguard-bff", "cluster.local/ns/greenguard/sa/mcp-gateway"])
        ingress = next(item for item in objects if item["kind"] == "NetworkPolicy" and item["metadata"]["name"] == "knowledge-service-ingress")
        self.assertIn({"podSelector": {"matchLabels": {"app.kubernetes.io/name": "mcp-gateway"}}}, ingress["spec"]["ingress"][0]["from"])

    def test_runtime_egress_policy_does_not_implicitly_change_ingress_boundary(self):
        objects = render(fixture())
        egress = next(item for item in objects if item["kind"] == "NetworkPolicy" and item["metadata"]["name"] == "ai-runtime-egress")
        ingress = next(item for item in objects if item["kind"] == "NetworkPolicy" and item["metadata"]["name"] == "ai-runtime-ingress-deny")
        self.assertEqual(egress["spec"]["policyTypes"], ["Egress"])
        self.assertNotIn("ingress", egress["spec"])
        self.assertEqual(ingress["spec"]["policyTypes"], ["Ingress"])
        self.assertEqual(ingress["spec"]["ingress"], [])

    def test_mcp_gateway_can_reach_only_configured_https_cidrs_for_external_jwks(self):
        policy = next(item for item in render(fixture()) if item["kind"] == "NetworkPolicy" and item["metadata"]["name"] == "mcp-gateway-egress")
        https = [rule for rule in policy["spec"]["egress"] if rule.get("ports") == [{"protocol": "TCP", "port": 443}]]
        self.assertEqual(https, [{"to": [{"ipBlock": {"cidr": "203.0.113.1/32"}}], "ports": [{"protocol": "TCP", "port": 443}]}])


if __name__ == "__main__": unittest.main()
