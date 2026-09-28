#!/usr/bin/env python3
"""Check disposable secret materialization without printing or persisting values."""

import argparse
import base64
import binascii
import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SQL = ROOT / "rds-bootstrap-chart/files/init-databases.sql"
CONTRACT = ROOT / "contract.json"
KAFKA_BINARY_KEYS = {"broker.keystore.p12", "broker.truststore.p12", "registry.keystore.p12", "kafka.truststore.p12"}
KAFKA_KEYS = KAFKA_BINARY_KEYS | {
    "broker-jaas", "registry-kafka-jaas", "keystore-password", "key-password",
    "truststore-password", "registry-keystore-password", "registry-key-password",
    "registry-jaas.conf", "registry-users.properties",
}


def secret_bytes(name, data):
    return {key: (base64.b64decode(value, validate=True) if name == "greenguard-kafka-auth" and key in KAFKA_BINARY_KEYS
                  else value.encode("utf-8")) for key, value in data.items()}


def command(*args):
    if args[0] == "aws" and "--output" not in args:
        args = (*args, "--output", "json")
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"command failed: {args[0]} {args[1]} (exit {result.returncode})")
    return json.loads(result.stdout)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--environment", required=True)
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--rds-instance", required=True)
    parser.add_argument("--namespace", default="greenguard")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]{12}", args.account_id):
        parser.error("--account-id must be 12 digits")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.environment):
        parser.error("--environment must be a lowercase DNS label")

    return args


def expected_secrets(args):
    account = command("aws", "sts", "get-caller-identity")["Account"]
    if account != args.account_id:
        raise RuntimeError("AWS account does not match --account-id")
    endpoint = command("aws", "eks", "describe-cluster", "--region", args.region,
                       "--name", args.cluster, "--query", "cluster.endpoint", "--output", "json")
    kubeconfig = command("kubectl", "config", "view", "--minify", "-o", "json")
    servers = [entry["cluster"]["server"] for entry in kubeconfig.get("clusters", [])]
    if servers != [endpoint]:
        raise RuntimeError("kubectl context does not target the requested EKS cluster")
    db = command("aws", "rds", "describe-db-instances", "--region", args.region,
                 "--db-instance-identifier", args.rds_instance)["DBInstances"][0]
    db_host = db["Endpoint"]["Address"]
    master_arn = db["MasterUserSecret"]["SecretArn"]
    master = command("aws", "secretsmanager", "get-secret-value", "--region", args.region,
                     "--secret-id", master_arn, "--version-stage", "AWSCURRENT")
    master_password = json.loads(master["SecretString"])["password"]
    if not isinstance(master_password, str) or not master_password:
        raise RuntimeError("RDS master password is empty")
    if not master.get("VersionId") or "AWSCURRENT" not in master.get("VersionStages", []):
        raise RuntimeError("RDS master AWSCURRENT version is missing")

    releases = json.loads(CONTRACT.read_text())["releases"]
    runtime_secrets = {release["secret"]: release["name"] for release in releases if release["name"] != "dashboard"}
    names = sorted(runtime_secrets)
    role_keys = set(re.findall(r"^\\getenv\s+\S+\s+(\S+)\s*$", SQL.read_text(), re.MULTILINE))
    if not role_keys:
        raise RuntimeError("RDS role password contract is empty")
    names.extend([
        "greenguard-rds-bootstrap", "greenguard-rds-ca", "grafana-admin",
        "greenguard-pgbouncer-auth", "greenguard-cdc-credentials",
        "greenguard-opensearch-admin", "greenguard-opensearch-clients",
        "greenguard-opensearch-tls", "greenguard-opensearch-ca",
        "greenguard-cassandra-auth", "greenguard-cassandra-tls",
        "greenguard-kafka-auth", "greenguard-kafka-ca", "greenguard-kafka-connect-auth",
        "greenguard-kafka-admin-auth",
        "greenguard-mqtt-broker",
    ])
    expected = {}
    for name in names:
        remote_name = f"greenguard/{args.environment}/{name}"
        try:
            response = command("aws", "secretsmanager", "get-secret-value", "--region", args.region,
                               "--secret-id", remote_name, "--version-stage", "AWSCURRENT")
        except RuntimeError as error:
            raise RuntimeError(f"{name}: source unavailable") from error
        if response.get("Name") != remote_name or "AWSCURRENT" not in response.get("VersionStages", []):
            raise ValueError(f"{name}: wrong AWS secret version")
        source = json.loads(response["SecretString"])
        if not isinstance(source, dict) or not source or not all(
            isinstance(k, str) and isinstance(v, str) and v for k, v in source.items()
        ):
            raise ValueError(f"{name}: AWS value must be a nonempty JSON string map")
        if name in runtime_secrets:
            if source.get("KAFKA_SASL_USERNAME") != runtime_secrets[name] or not source.get("KAFKA_SASL_PASSWORD"):
                raise ValueError(f"{name}: scoped Kafka SASL username/password are required")
            if re.search(r'["\\\r\n]', source["KAFKA_SASL_PASSWORD"]):
                raise ValueError(f"{name}: Kafka password contains JAAS syntax characters")
            if name == "notification-service-config":
                if not source.get("SCHEMA_REGISTRY_USERNAME") or not source.get("SCHEMA_REGISTRY_PASSWORD"):
                    raise ValueError(f"{name}: Schema Registry Basic credentials are required")
                if source.get("SCHEMA_REGISTRY_URL") != "https://schema-registry.greenguard.svc.cluster.local:8081":
                    raise ValueError(f"{name}: Schema Registry URL must use the verified in-cluster HTTPS endpoint")
            if name == "hardware-service-config":
                if source.get("MQTT_USERNAME") != "greenguard-hardware-worker" or not source.get("MQTT_PASSWORD"):
                    raise ValueError(f"{name}: exact MQTT worker username and password are required")
                if any(key in source for key in ("MQTT_BROKER_URL", "MQTT_CA_FILE", "MQTT_CLIENT_ID")):
                    raise ValueError(f"{name}: MQTT endpoint, CA path, and client identity come from the pinned release")
        if name == "greenguard-rds-bootstrap":
            if set(source) != role_keys:
                raise ValueError(f"{name}: RDS bootstrap role keys are missing or unexpected")
            source = {**source, "PGHOST": db_host, "PGPASSWORD": master_password}
        elif name == "greenguard-rds-ca":
            if set(source) != {"ca.pem"} or "BEGIN CERTIFICATE" not in source["ca.pem"]:
                raise ValueError(f"{name}: RDS CA must contain ca.pem with a PEM certificate")
        elif name == "grafana-admin":
            if set(source) != {"GF_SECURITY_ADMIN_USER", "GF_SECURITY_ADMIN_PASSWORD"}:
                raise ValueError(f"{name}: Grafana admin keys are missing or unexpected")
        elif name == "greenguard-pgbouncer-auth":
            if set(source) != {"userlist.txt"}:
                raise ValueError(f"{name}: PgBouncer auth keys are missing or unexpected")
        elif name == "greenguard-cdc-credentials":
            if set(source) != {"CDC_DB_PASSWORD"}:
                raise ValueError(f"{name}: CDC credential keys are missing or unexpected")
            if source["CDC_DB_PASSWORD"] != expected["greenguard-rds-bootstrap"]["data"]["CDC_DB_PASSWORD"]:
                raise ValueError(f"{name}: CDC password differs from the RDS bootstrap role")
        elif name == "greenguard-opensearch-admin":
            if set(source) != {"password"}:
                raise ValueError(f"{name}: OpenSearch admin keys are missing or unexpected")
        elif name == "greenguard-opensearch-clients":
            if set(source) != {"writer-password", "reader-password"}:
                raise ValueError(f"{name}: OpenSearch client keys are missing or unexpected")
        elif name == "greenguard-opensearch-tls":
            if set(source) != {"ca.crt", "node.crt", "node.key", "admin.crt", "admin.key"}:
                raise ValueError(f"{name}: OpenSearch TLS keys are missing or unexpected")
        elif name == "greenguard-opensearch-ca":
            if set(source) != {"ca.crt"} or "BEGIN CERTIFICATE" not in source["ca.crt"]:
                raise ValueError(f"{name}: OpenSearch CA must contain ca.crt PEM")
        elif name == "greenguard-cassandra-auth":
            if set(source) != {"admin-password", "reader-password", "writer-password"}:
                raise ValueError(f"{name}: Cassandra auth keys are missing or unexpected")
        elif name == "greenguard-cassandra-tls":
            if set(source) != {"server.p12", "keystore-password", "ca.crt"}:
                raise ValueError(f"{name}: Cassandra TLS keys are missing or unexpected")
        elif name == "greenguard-kafka-auth":
            if set(source) != KAFKA_KEYS:
                raise ValueError(f"{name}: Kafka/Registry auth keys are missing or unexpected")
            for key in KAFKA_BINARY_KEYS:
                try:
                    if not base64.b64decode(source[key], validate=True):
                        raise ValueError("empty")
                except (binascii.Error, ValueError) as error:
                    raise ValueError(f"{name}: {key} must contain base64 PKCS12 bytes") from error
            if "PlainLoginModule required" not in source["broker-jaas"] or "PlainLoginModule required" not in source["registry-kafka-jaas"]:
                raise ValueError(f"{name}: Kafka JAAS entries must use the PLAIN mechanism")
            if "SchemaRegistry-Props" not in source["registry-jaas.conf"] or "PropertyFileLoginModule required" not in source["registry-jaas.conf"]:
                raise ValueError(f"{name}: Registry JAAS realm is invalid")
        elif name == "greenguard-kafka-ca":
            if set(source) != {"ca.crt", "registry-ca.crt"} or any("BEGIN CERTIFICATE" not in value for value in source.values()):
                raise ValueError(f"{name}: exact Kafka and Registry PEM CA keys are required")
        elif name == "greenguard-mqtt-broker":
            if set(source) != {"tls.crt", "tls.key", "ca.crt", "passwords", "acl"}:
                raise ValueError(f"{name}: exact broker TLS, password, and ACL keys are required")
            if any("BEGIN CERTIFICATE" not in source[key] for key in ("tls.crt", "ca.crt")) or "PRIVATE KEY" not in source["tls.key"]:
                raise ValueError(f"{name}: broker TLS material must be PEM")
            if not re.search(r"(?m)^greenguard-hardware-worker:\$7\$", source["passwords"]):
                raise ValueError(f"{name}: hashed worker principal is required")
            if not re.search(r"(?m)^user greenguard-hardware-worker$", source["acl"]):
                raise ValueError(f"{name}: worker ACL principal is required")
        elif name in {"greenguard-kafka-connect-auth", "greenguard-kafka-admin-auth"}:
            keys = {"KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "KAFKA_SASL_JAAS_CONFIG"}
            if name == "greenguard-kafka-connect-auth":
                keys |= {"SCHEMA_REGISTRY_USERNAME", "SCHEMA_REGISTRY_PASSWORD", "SCHEMA_REGISTRY_BASIC_USER_INFO"}
            if set(source) != keys:
                raise ValueError(f"{name}: exact Kafka client credentials are required")
            if not re.fullmatch(r"[A-Za-z0-9._-]+", source["KAFKA_SASL_USERNAME"]) or re.search(r'["\\\r\n]', source["KAFKA_SASL_PASSWORD"]):
                raise ValueError(f"{name}: Kafka credentials cannot contain JAAS syntax characters")
            expected_jaas = ("org.apache.kafka.common.security.plain.PlainLoginModule required "
                             f'username="{source["KAFKA_SASL_USERNAME"]}" '
                             f'password="{source["KAFKA_SASL_PASSWORD"]}";')
            if source["KAFKA_SASL_JAAS_CONFIG"] != expected_jaas:
                raise ValueError(f"{name}: Kafka JAAS must match the scoped username and password")
            if name == "greenguard-kafka-connect-auth":
                if ":" in source["SCHEMA_REGISTRY_USERNAME"] or source["SCHEMA_REGISTRY_BASIC_USER_INFO"] != f'{source["SCHEMA_REGISTRY_USERNAME"]}:{source["SCHEMA_REGISTRY_PASSWORD"]}':
                    raise ValueError(f"{name}: Registry Basic user info must match the username and password")
        elif name in {"read-api-config", "search-indexer-config"}:
            if source.get("ELASTICSEARCH_URL") != "https://greenguard-opensearch.greenguard.svc.cluster.local:9200":
                raise ValueError(f"{name}: OpenSearch URL must use the verified in-cluster HTTPS endpoint")
            if "OPENSEARCH_USERNAME" in source or "OPENSEARCH_PASSWORD" in source:
                raise ValueError(f"{name}: OpenSearch credentials must come from the scoped chart Secret reference")
            if name == "read-api-config" and any(key.startswith("CASSANDRA_") for key in source):
                raise ValueError(f"{name}: Cassandra endpoint and credentials must come from the secured chart profile")
        elif name == "cassandra-writer-config":
            if any(key.startswith("CASSANDRA_") for key in source):
                raise ValueError(f"{name}: Cassandra endpoint and credentials must come from the secured chart profile")
        version = response.get("VersionId", "")
        if not version:
            raise ValueError(f"{name}: AWS version ID is missing")
        expected[name] = {
            "data": source,
            "source": remote_name,
            "version": version,
            "master_version": master.get("VersionId", "") if name == "greenguard-rds-bootstrap" else "",
        }
    broker_jaas = expected["greenguard-kafka-auth"]["data"]["broker-jaas"]
    if not re.search(r'\busername="broker"\s+password="([^"]+)"', broker_jaas):
        raise ValueError("greenguard-kafka-auth: broker JAAS must authenticate the KRaft superuser")
    broker_password = re.search(r'\busername="broker"\s+password="([^"]+)"', broker_jaas).group(1)
    if f'user_broker="{broker_password}"' not in broker_jaas:
        raise ValueError("greenguard-kafka-auth: broker JAAS must provision the KRaft superuser")
    for name in [*runtime_secrets, "greenguard-kafka-connect-auth", "greenguard-kafka-admin-auth"]:
        source = expected[name]["data"]
        if f'user_{source["KAFKA_SASL_USERNAME"]}="{source["KAFKA_SASL_PASSWORD"]}"' not in broker_jaas:
            raise ValueError(f"{name}: Kafka broker JAAS does not contain its scoped client credential")
    return expected


def verify_targets(expected, namespace):
    failures = []
    for name, record in expected.items():
        try:
            secret = command("kubectl", "get", "secret", name, "-n", namespace, "-o", "json")
            if secret.get("type") != "Opaque":
                raise ValueError("Kubernetes Secret must be Opaque")
            try:
                target = {key: base64.b64decode(value, validate=True)
                          for key, value in secret.get("data", {}).items()}
            except binascii.Error as error:
                raise ValueError("Kubernetes Secret contains invalid base64") from error
            if target != secret_bytes(name, record["data"]):
                raise ValueError("Kubernetes keys or values differ from AWS AWSCURRENT")
            annotations = secret.get("metadata", {}).get("annotations", {})
            if annotations.get("greenguard.io/aws-version-id") != record["version"]:
                raise ValueError("Kubernetes Secret has a stale AWS version annotation")
            if name == "greenguard-rds-bootstrap" and annotations.get("greenguard.io/rds-master-version-id") != record["master_version"]:
                raise ValueError("Kubernetes Secret has a stale RDS master version annotation")
        except (KeyError, ValueError, TypeError, RuntimeError, json.JSONDecodeError) as error:
            failures.append(f"{name}: {error}")
    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    print(f"PASS {len(expected)} Secrets match AWS AWSCURRENT in {namespace}; values withheld")
    return 0


def main():
    args = arguments()
    return verify_targets(expected_secrets(args), args.namespace)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyError, ValueError, json.JSONDecodeError, RuntimeError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
