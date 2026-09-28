"""Offline contract checks for the disposable secret preflight."""

import base64
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).with_name("check-secrets-ready.py")
SPEC = importlib.util.spec_from_file_location("check_secrets_ready", MODULE_PATH)
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.contract = root / "contract.json"
        self.contract.write_text(json.dumps({"releases": [
            {"name": "dashboard", "secret": "dashboard-public-config"},
            {"name": "bff", "secret": "bff-config"},
            {"name": "read-api", "secret": "read-api-config"},
            {"name": "search-indexer", "secret": "search-indexer-config"},
            {"name": "cassandra-writer", "secret": "cassandra-writer-config"},
            {"name": "notification-service", "secret": "notification-service-config"},
        ]}))
        self.sql = root / "init.sql"
        self.sql.write_text("\\getenv role_password ROLE_PASSWORD\n\\getenv other_password OTHER_PASSWORD\n\\getenv cdc_password CDC_DB_PASSWORD\n")
        self.values = {
            "bff-config": {"BFF_TOKEN": "dummy-token", "KAFKA_SASL_USERNAME": "bff", "KAFKA_SASL_PASSWORD": "dummy"},
            "read-api-config": {"ELASTICSEARCH_URL": "https://greenguard-opensearch.greenguard.svc.cluster.local:9200", "KAFKA_SASL_USERNAME": "read-api", "KAFKA_SASL_PASSWORD": "dummy"},
            "search-indexer-config": {"ELASTICSEARCH_URL": "https://greenguard-opensearch.greenguard.svc.cluster.local:9200", "KAFKA_SASL_USERNAME": "search-indexer", "KAFKA_SASL_PASSWORD": "dummy"},
            "cassandra-writer-config": {"KAFKA_BROKERS": "kafka:29092", "KAFKA_SASL_USERNAME": "cassandra-writer", "KAFKA_SASL_PASSWORD": "dummy"},
            "notification-service-config": {"KAFKA_SASL_USERNAME": "notification-service", "KAFKA_SASL_PASSWORD": "dummy", "SCHEMA_REGISTRY_URL": "https://schema-registry.greenguard.svc.cluster.local:8081", "SCHEMA_REGISTRY_USERNAME": "registry", "SCHEMA_REGISTRY_PASSWORD": "dummy"},
            "greenguard-rds-bootstrap": {
                "ROLE_PASSWORD": "dummy-role-password",
                "OTHER_PASSWORD": "dummy-other-password",
                "CDC_DB_PASSWORD": "dummy-cdc-password",
            },
            "greenguard-rds-ca": {"ca.pem": "-----BEGIN CERTIFICATE-----\ndummy\n-----END CERTIFICATE-----"},
            "grafana-admin": {"GF_SECURITY_ADMIN_USER": "test-admin", "GF_SECURITY_ADMIN_PASSWORD": "dummy-grafana-password"},
            "greenguard-pgbouncer-auth": {"userlist.txt": "\"inventory_app\" \"dummy-hash\""},
            "greenguard-cdc-credentials": {"CDC_DB_PASSWORD": "dummy-cdc-password"},
            "greenguard-opensearch-admin": {"password": "dummy-search-admin"},
            "greenguard-opensearch-clients": {"writer-password": "dummy-search-writer", "reader-password": "dummy-search-reader"},
            "greenguard-opensearch-tls": {"ca.crt": "dummy-ca", "node.crt": "dummy-node-cert", "node.key": "dummy-node-key", "admin.crt": "dummy-admin-cert", "admin.key": "dummy-admin-key"},
            "greenguard-opensearch-ca": {"ca.crt": "-----BEGIN CERTIFICATE-----\ndummy\n-----END CERTIFICATE-----"},
            "greenguard-cassandra-auth": {"admin-password": "dummy-admin", "reader-password": "dummy-reader", "writer-password": "dummy-writer"},
            "greenguard-cassandra-tls": {"server.p12": "dummy-p12", "keystore-password": "dummy-keystore", "ca.crt": "dummy-ca"},
            "greenguard-kafka-auth": {
                **{key: base64.b64encode(b"dummy-p12").decode() for key in preflight.KAFKA_BINARY_KEYS},
                "broker-jaas": "org.apache.kafka.common.security.plain.PlainLoginModule required username=\"broker\" password=\"dummy\" user_broker=\"dummy\";",
                "registry-kafka-jaas": "org.apache.kafka.common.security.plain.PlainLoginModule required username=\"registry\" password=\"dummy\";",
                "keystore-password": "dummy", "key-password": "dummy", "truststore-password": "dummy",
                "registry-keystore-password": "dummy", "registry-key-password": "dummy",
                "registry-jaas.conf": "SchemaRegistry-Props { org.eclipse.jetty.security.jaas.spi.PropertyFileLoginModule required file=\"/etc/greenguard/registry/registry-users.properties\"; };",
                "registry-users.properties": "registry: hashed,registry-user",
            },
            "greenguard-kafka-ca": {"ca.crt": "-----BEGIN CERTIFICATE-----dummy", "registry-ca.crt": "-----BEGIN CERTIFICATE-----dummy"},
            "greenguard-kafka-connect-auth": {"KAFKA_SASL_USERNAME": "connect", "KAFKA_SASL_PASSWORD": "dummy", "KAFKA_SASL_JAAS_CONFIG": 'org.apache.kafka.common.security.plain.PlainLoginModule required username="connect" password="dummy";', "SCHEMA_REGISTRY_USERNAME": "registry", "SCHEMA_REGISTRY_PASSWORD": "dummy", "SCHEMA_REGISTRY_BASIC_USER_INFO": "registry:dummy"},
            "greenguard-kafka-admin-auth": {"KAFKA_SASL_USERNAME": "admin", "KAFKA_SASL_PASSWORD": "dummy", "KAFKA_SASL_JAAS_CONFIG": 'org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password="dummy";'},
            "greenguard-mqtt-broker": {"tls.crt": "-----BEGIN CERTIFICATE-----dummy", "tls.key": "-----BEGIN PRIVATE KEY-----dummy", "ca.crt": "-----BEGIN CERTIFICATE-----dummy", "passwords": "greenguard-hardware-worker:$7$dummy-hash", "acl": "user greenguard-hardware-worker\ntopic write greenguard/+/+/command\ntopic read greenguard/+/+/ack"},
        }
        clients = ("bff", "read-api", "search-indexer", "cassandra-writer", "notification-service", "connect", "admin")
        self.values["greenguard-kafka-auth"]["broker-jaas"] += " " + " ".join(
            f'user_{name}="dummy"' for name in clients
        )
        self.missing = set()
        self.kubernetes_overrides = {}
        self.account = "123456789012"

    def stub_command(self, *args):
        if args[:3] == ("aws", "sts", "get-caller-identity"):
            return {"Account": self.account}
        if args[:3] == ("aws", "eks", "describe-cluster"):
            return "https://eks.example"
        if args[:3] == ("kubectl", "config", "view"):
            return {"clusters": [{"cluster": {"server": "https://eks.example"}}]}
        if args[:3] == ("aws", "rds", "describe-db-instances"):
            return {"DBInstances": [{"Endpoint": {"Address": "db.example.rds.amazonaws.com"},
                                      "MasterUserSecret": {"SecretArn": "arn:master"}}]}
        if args[:3] == ("aws", "secretsmanager", "get-secret-value"):
            secret_id = args[args.index("--secret-id") + 1]
            if secret_id == "arn:master":
                return {"SecretString": json.dumps({"password": "dummy-master-password"}),
                        "VersionId": "master-v1", "VersionStages": ["AWSCURRENT"]}
            name = secret_id.rsplit("/", 1)[-1]
            if name in self.missing:
                raise RuntimeError("secret unavailable")
            return {"Name": secret_id, "VersionStages": ["AWSCURRENT"], "VersionId": "source-v1",
                    "SecretString": json.dumps(self.values[name])}
        if args[:3] == ("kubectl", "get", "secret"):
            name = args[3]
            values = self.kubernetes_overrides.get(name, self.values[name])
            if name == "greenguard-rds-bootstrap" and name not in self.kubernetes_overrides:
                values = {**values, "PGHOST": "db.example.rds.amazonaws.com",
                          "PGPASSWORD": "dummy-master-password"}
            annotations = {"greenguard.io/aws-version-id": "source-v1"}
            if name == "greenguard-rds-bootstrap":
                annotations["greenguard.io/rds-master-version-id"] = "master-v1"
            return {"type": "Opaque", "metadata": {"annotations": annotations}, "data": {
                key: base64.b64encode(preflight.secret_bytes(name, {key: value})[key]).decode() for key, value in values.items()
            }}
        raise AssertionError(f"unexpected command: {args}")

    def run_preflight(self):
        argv = ["check-secrets-ready.py", "--account-id", "123456789012",
                "--region", "ca-central-1", "--environment", "disposable",
                "--cluster", "test-cluster", "--rds-instance", "test-db"]
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(preflight, "CONTRACT", self.contract), \
             patch.object(preflight, "SQL", self.sql), \
             patch.object(preflight, "command", self.stub_command), \
             patch.object(sys, "argv", argv), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                status = preflight.main()
            except (RuntimeError, ValueError) as error:
                status = 1
                print(f"FAIL {error}", file=sys.stderr)
        output = stdout.getvalue() + stderr.getvalue()
        for value in ("dummy-token", "dummy-master-password", "dummy-role-password", "dummy-other-password", "dummy-cdc-password", "dummy-grafana-password", "dummy-search-admin", "dummy-search-writer", "dummy-search-reader"):
            self.assertNotIn(value, output)
        return status, output

    def test_complete_secrets_pass(self):
        status, output = self.run_preflight()
        self.assertEqual(status, 0)
        self.assertIn("PASS 21 Secrets", output)

    def test_mqtt_broker_secret_keys_must_be_exact(self):
        del self.values["greenguard-mqtt-broker"]["tls.key"]
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("exact broker TLS", output)

    def test_notification_registry_url_must_use_internal_https(self):
        self.values["notification-service-config"]["SCHEMA_REGISTRY_URL"] = "http://schema-registry:8081"
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("verified in-cluster HTTPS", output)

    def test_connect_jaas_must_match_scoped_password(self):
        self.values["greenguard-kafka-connect-auth"]["KAFKA_SASL_PASSWORD"] = "different"
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("Kafka JAAS must match", output)

    def test_runtime_kafka_credentials_must_be_scoped(self):
        self.values["bff-config"]["KAFKA_SASL_USERNAME"] = "shared-admin"
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("scoped Kafka SASL username/password", output)

    def test_runtime_kafka_password_is_required(self):
        del self.values["read-api-config"]["KAFKA_SASL_PASSWORD"]
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("scoped Kafka SASL username/password", output)

    def test_broker_jaas_must_match_runtime_client(self):
        self.values["greenguard-kafka-auth"]["broker-jaas"] = self.values["greenguard-kafka-auth"]["broker-jaas"].replace('user_read-api="dummy"', 'user_read-api="wrong"')
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("broker JAAS does not contain", output)

    def test_cassandra_tls_keys_must_be_exact(self):
        del self.values["greenguard-cassandra-tls"]["server.p12"]
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("Cassandra TLS keys", output)

    def test_runtime_cannot_override_secured_cassandra_profile(self):
        self.values["read-api-config"]["CASSANDRA_REQUIRE_SECURE"] = "0"
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("secured chart profile", output)

    def test_search_url_must_be_internal_https(self):
        self.values["read-api-config"]["ELASTICSEARCH_URL"] = "http://greenguard-opensearch:9200"
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("verified in-cluster HTTPS", output)

    def test_cdc_password_must_match_bootstrap_role(self):
        self.values["greenguard-cdc-credentials"]["CDC_DB_PASSWORD"] = "different-cdc-password"
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("CDC password differs", output)

    def test_pgbouncer_auth_key_must_be_exact(self):
        self.values["greenguard-pgbouncer-auth"] = {"wrong": "dummy-hash"}
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("PgBouncer auth keys", output)

    def test_opensearch_tls_keys_must_be_exact(self):
        del self.values["greenguard-opensearch-tls"]["node.key"]
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("OpenSearch TLS keys", output)

    def test_wrong_account_fails(self):
        self.account = "999999999999"
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("AWS account does not match", output)

    def test_missing_role_key_fails(self):
        del self.values["greenguard-rds-bootstrap"]["ROLE_PASSWORD"]
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("role keys are missing", output)

    def test_empty_runtime_value_fails(self):
        self.values["bff-config"]["BFF_TOKEN"] = ""
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("nonempty JSON string map", output)

    def test_mismatched_kubernetes_secret_fails(self):
        self.kubernetes_overrides["bff-config"] = {"BFF_TOKEN": "stale-token"}
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("differ from AWS AWSCURRENT", output)

    def test_absent_ca_fails(self):
        self.missing.add("greenguard-rds-ca")
        status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("greenguard-rds-ca: source unavailable", output)

    def test_malformed_kubernetes_base64_fails_without_value(self):
        original = self.stub_command

        def malformed(*args):
            result = original(*args)
            if args[:4] == ("kubectl", "get", "secret", "bff-config"):
                result["data"]["BFF_TOKEN"] = "invalid-base64@@"
            return result

        with patch.object(self, "stub_command", malformed):
            status, output = self.run_preflight()
        self.assertEqual(status, 1)
        self.assertIn("invalid base64", output)
        self.assertNotIn("invalid-base64@@", output)

    def test_aws_reads_force_json_output(self):
        result = Mock(returncode=0, stdout='{"Account":"123456789012"}')
        with patch.object(preflight.subprocess, "run", return_value=result) as run:
            self.assertEqual(preflight.command("aws", "sts", "get-caller-identity"),
                             {"Account": "123456789012"})
        self.assertEqual(run.call_args.args[0][-2:], ("--output", "json"))


if __name__ == "__main__":
    unittest.main()
