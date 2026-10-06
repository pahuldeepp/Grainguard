#!/usr/bin/env python3
"""Check disposable secret materialization without printing or persisting values."""

import argparse
import base64
import binascii
import json
import ipaddress
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
SQL = ROOT / "rds-bootstrap-chart/files/init-databases.sql"
CONTRACT = ROOT / "contract.json"
KAFKA_BINARY_KEYS = {"broker.keystore.p12", "broker.truststore.p12", "registry.keystore.p12", "kafka.truststore.p12"}
KAFKA_KEYS = KAFKA_BINARY_KEYS | {
    "broker-jaas", "registry-kafka-jaas", "keystore-password", "key-password",
    "truststore-password", "registry-keystore-password", "registry-key-password",
    "registry-jaas.conf", "registry-users.properties",
}
# These application Secrets are consumed by runtimes that call the control
# plane for placement or membership. Terraform copies the canonical token from
# tenant-control-plane-config into each one before Kubernetes materialization.
CONTROL_LOOKUP_SECRET_CONSUMERS = {
    "bff-config", "gateway-config", "device-service-config", "read-api-config",
    "workflow-alerts-config", "notification-service-config", "telemetry-ingest-config", "billing-service-config",
    "projection-builder-config", "risk-engine-config", "jobs-worker-config",
    "hardware-service-config", "saga-api-config", "saga-worker-config",
    "tenant-control-plane-config", "audit-export-worker-config",
}


def validate_billing_service_secret(source):
    """Validate provider and return-origin inputs without echoing secret values."""
    if not re.fullmatch(r"(?:sk|rk)_test_[A-Za-z0-9]+", source.get("STRIPE_API_KEY", "")):
        raise ValueError("billing-service-config: a Stripe test-mode API key is required")

    webhook_secrets = [value.strip() for value in source.get("STRIPE_WEBHOOK_SECRETS", "").split(",")]
    if not 1 <= len(webhook_secrets) <= 2 or any(
        not re.fullmatch(r"whsec_[A-Za-z0-9]+", value) for value in webhook_secrets
    ):
        raise ValueError("billing-service-config: one or two Stripe webhook signing secrets are required")

    encoded_key = source.get("BILLING_INBOX_ENCRYPTION_KEY", "")
    if not re.fullmatch(r"[A-Za-z0-9+/]{43}=", encoded_key):
        raise ValueError("billing-service-config: a base64 32-byte inbox encryption key is required")
    try:
        decoded_key = base64.b64decode(encoded_key, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("billing-service-config: a base64 32-byte inbox encryption key is required") from error
    if len(decoded_key) != 32:
        raise ValueError("billing-service-config: a base64 32-byte inbox encryption key is required")

    origins = [value.strip() for value in source.get("BILLING_RETURN_ORIGINS", "").split(",")]
    if not origins or any(not value for value in origins):
        raise ValueError("billing-service-config: deployed HTTPS return origins are required")
    for origin in origins:
        parsed = urlparse(origin)
        hostname = parsed.hostname or ""
        try:
            port = parsed.port
        except ValueError as error:
            raise ValueError("billing-service-config: return origins must be deployed HTTPS origins") from error
        try:
            ipaddress.ip_address(hostname)
            is_ip_address = True
        except ValueError:
            is_ip_address = False
        if (
            parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or
            parsed.path or parsed.query or parsed.fragment or origin != f"https://{parsed.netloc}" or
            not re.fullmatch(r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}", hostname) or
            hostname.lower() == "localhost" or is_ip_address or
            (port is not None and not 1 <= port <= 65535)
        ):
            raise ValueError("billing-service-config: return origins must be deployed HTTPS origins")


def secret_bytes(name, data):
    return {key: (base64.b64decode(value, validate=True) if (name == "greenguard-kafka-auth" and key in KAFKA_BINARY_KEYS) or (name == "greenguard-cassandra-tls" and key == "server.p12")
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

    deployment = json.loads(CONTRACT.read_text())
    releases = deployment["releases"]
    runtime_secrets = {}
    application_secrets = {}
    for release in releases:
        if release["name"] == "dashboard":
            continue
        secret = release["secret"]
        application_secrets[secret] = True
        if release.get("kafka", True) is False:
            continue
        principal = release.get("kafkaPrincipal", release["name"])
        if secret in runtime_secrets and runtime_secrets[secret] != principal:
            raise ValueError(f"{secret}: runtime Secret is assigned to conflicting Kafka principals")
        runtime_secrets[secret] = principal
    names = sorted(application_secrets)
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
        *[task["secret"] for task in deployment.get("scheduledTasks", [])],
        *deployment.get("operatorSecrets", []),
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
                if not source.get("KAFKA_BROKERS"):
                    raise ValueError(f"{name}: Kafka bootstrap brokers are required")
                if not source.get("SCHEMA_REGISTRY_USERNAME") or not source.get("SCHEMA_REGISTRY_PASSWORD"):
                    raise ValueError(f"{name}: Schema Registry Basic credentials are required")
                if source.get("SCHEMA_REGISTRY_URL") != "https://schema-registry.greenguard.svc.cluster.local:8081":
                    raise ValueError(f"{name}: Schema Registry URL must use the verified in-cluster HTTPS endpoint")
            if name == "notification-contacts-projector-config":
                expected_keys = {
                    "KAFKA_BROKERS", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD",
                    "SCHEMA_REGISTRY_URL", "SCHEMA_REGISTRY_USERNAME", "SCHEMA_REGISTRY_PASSWORD",
                    "NOTIFICATION_STATE_TABLE", "AWS_REGION",
                }
                if set(source) != expected_keys:
                    raise ValueError(f"{name}: exact least-privilege Kafka, Registry and DynamoDB keys are required")
                if source.get("KAFKA_SASL_USERNAME") != "notification-service":
                    raise ValueError(f"{name}: Kafka identity must remain notification-service")
                if not source.get("NOTIFICATION_STATE_TABLE") or not source.get("AWS_REGION"):
                    raise ValueError(f"{name}: Terraform-derived DynamoDB table and region are required")
            if name == "hardware-service-config":
                if source.get("MQTT_USERNAME") != "greenguard-hardware-worker" or not source.get("MQTT_PASSWORD"):
                    raise ValueError(f"{name}: exact MQTT worker username and password are required")
                if any(key in source for key in ("MQTT_BROKER_URL", "MQTT_CA_FILE", "MQTT_CLIENT_ID")):
                    raise ValueError(f"{name}: MQTT endpoint, CA path, and client identity come from the pinned release")
        if name == "billing-service-config":
            validate_billing_service_secret(source)
        if name == "entitlement-heartbeat-config":
            if set(source) != {"KAFKA_BROKERS", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD"}:
                raise ValueError(f"{name}: only the heartbeat Kafka broker and scoped credentials are allowed")
        if name == "audit-export-worker-config":
            required = {
                "CONTROL_AUDIT_DATABASE_URL", "BILLING_AUDIT_DATABASE_URL", "CONTROL_LOOKUP_TOKEN",
                "AUDIT_EXPORT_PRIVATE_KEY_PEM", "AUDIT_EXPORT_PUBLIC_KEY_PEM", "AUDIT_EXPORT_PUBLIC_KEY_ID",
                "AUDIT_EXPORT_S3_BUCKET", "AUDIT_EXPORT_S3_REGION",
            }
            if set(source) != required:
                raise ValueError(f"{name}: exact least-privilege database, signing, and S3 settings are required")
            if len(source["CONTROL_LOOKUP_TOKEN"].encode()) < 32:
                raise ValueError(f"{name}: control lookup token must contain at least 32 bytes")
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", source["AUDIT_EXPORT_PUBLIC_KEY_ID"]):
                raise ValueError(f"{name}: invalid public signing key id")
            if "PRIVATE KEY" not in source["AUDIT_EXPORT_PRIVATE_KEY_PEM"] or "PUBLIC KEY" not in source["AUDIT_EXPORT_PUBLIC_KEY_PEM"]:
                raise ValueError(f"{name}: signing key material must be PEM")
            if not source["AUDIT_EXPORT_S3_BUCKET"] or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[0-9]+", source["AUDIT_EXPORT_S3_REGION"]):
                raise ValueError(f"{name}: S3 bucket and AWS region are required")
            expected_databases = {
                "CONTROL_AUDIT_DATABASE_URL": ("control_audit_worker", "greenguard_control"),
                "BILLING_AUDIT_DATABASE_URL": ("billing_audit_reader", "greenguard_billing"),
            }
            for key, (role, database) in expected_databases.items():
                parsed = urlparse(source[key])
                if (parsed.scheme != "postgresql" or unquote(parsed.username or "") != role or
                    unquote(parsed.password or "") == "" or parsed.hostname != db_host or
                    parsed.port != 5432 or parsed.path != f"/{database}" or
                    parse_qs(parsed.query) != {"sslmode": ["verify-full"], "sslrootcert": ["/etc/greenguard/rds/ca.pem"]}):
                    raise ValueError(f"{name}: {key} must use the dedicated central role, database, and verified TLS")
        maintenance_match = re.fullmatch(r"greenguard-(s[1-4])-projection-history-maintenance-config", name)
        if maintenance_match:
            if set(source) != {"PROJECTION_MAINTENANCE_URL", "PROJECTION_HISTORY_SCHEMA", "PROJECTION_HISTORY_HOT_WINDOW", "PROJECTION_HISTORY_AHEAD_DAYS"}:
                raise ValueError(f"{name}: exact projection history maintenance configuration required")
            parsed = urlparse(source["PROJECTION_MAINTENANCE_URL"])
            if (parsed.scheme != "postgresql" or unquote(parsed.username or "") != "projection_history_maintainer" or
                    unquote(parsed.password or "") == "" or not re.fullmatch(r"[a-zA-Z0-9.-]+\.rds\.amazonaws\.com", parsed.hostname or "") or
                    parsed.port != 5432 or parsed.path != "/greenguard_read" or
                    parse_qs(parsed.query) != {"sslmode": ["verify-full"], "sslrootcert": ["/rds-ca/ca.pem"]} or
                    source["PROJECTION_HISTORY_SCHEMA"] != "public" or source["PROJECTION_HISTORY_HOT_WINDOW"] != "24h" or source["PROJECTION_HISTORY_AHEAD_DAYS"] != "3"):
                raise ValueError(f"{name}: shard-local dedicated role, database, TLS, and bounded retention configuration required")
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
            try:
                if not base64.b64decode(source["server.p12"], validate=True):
                    raise ValueError("empty")
            except (binascii.Error, ValueError) as error:
                raise ValueError(f"{name}: server.p12 must contain base64 PKCS12 bytes") from error
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
        elif name in {"greenguard-telemetry-archive-config", "greenguard-telemetry-clickhouse-config", "greenguard-telemetry-replay-config"}:
            required = {"KAFKA_BROKERS", "KAFKA_SECURITY_PROTOCOL", "KAFKA_SASL_MECHANISM", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "KAFKA_TLS_CA_FILE"}
            if name in {"greenguard-telemetry-archive-config", "greenguard-telemetry-replay-config"}:
                required |= {"TELEMETRY_ARCHIVE_BUCKET", "AWS_REGION"}
            if name == "greenguard-telemetry-clickhouse-config":
                required |= {"CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD"}
            if set(source) != required:
                raise ValueError(f"{name}: exact telemetry sink keys are missing or unexpected")
            expected_principal = "telemetry-replay" if name == "greenguard-telemetry-replay-config" else "telemetry-sinks"
            if source["KAFKA_SECURITY_PROTOCOL"] != "SASL_SSL" or source["KAFKA_SASL_MECHANISM"] != "PLAIN" or source["KAFKA_SASL_USERNAME"] != expected_principal:
                raise ValueError(f"{name}: Kafka telemetry workload must use its dedicated SASL_SSL principal")
            if len(source["KAFKA_SASL_PASSWORD"]) < 24 or ("CLICKHOUSE_PASSWORD" in source and len(source["CLICKHOUSE_PASSWORD"]) < 24):
                raise ValueError(f"{name}: telemetry sink passwords must contain at least 24 characters")
            if not re.fullmatch(r"kafka\.greenguard\.svc\.cluster\.local:29092", source["KAFKA_BROKERS"]):
                raise ValueError(f"{name}: telemetry sink broker must use the private in-cluster endpoint")
            if name == "greenguard-telemetry-clickhouse-config" and source["CLICKHOUSE_URL"] != "http://greenguard-clickhouse.greenguard.svc.cluster.local:8123":
                raise ValueError(f"{name}: ClickHouse URL must use the private in-cluster service")
            if source["KAFKA_TLS_CA_FILE"] != "/etc/greenguard/kafka/ca.crt" or (name in {"greenguard-telemetry-archive-config", "greenguard-telemetry-replay-config"} and not source["TELEMETRY_ARCHIVE_BUCKET"]):
                raise ValueError(f"{name}: TLS CA path or disposable archive bucket is invalid")
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
            if name == "read-api-config" and len(source.get("READ_HISTORY_CURSOR_SECRET", "").encode()) < 32:
                raise ValueError(f"{name}: READ_HISTORY_CURSOR_SECRET must contain at least 32 bytes")
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
    if "entitlement-heartbeat-config" in expected:
        billing_values = expected.get("billing-service-config", {}).get("data", {})
        heartbeat_values = expected["entitlement-heartbeat-config"]["data"]
        if any(heartbeat_values[key] != billing_values.get(key) for key in heartbeat_values):
            raise ValueError("entitlement-heartbeat-config: scoped Kafka settings must match billing-service-config")
    if "audit-export-worker-config" in application_secrets:
        if "tenant-control-plane-config" not in expected:
            raise ValueError(
                "audit-export-worker-config: tenant-control-plane-config is required for signed download setup"
            )
        api_config = expected["tenant-control-plane-config"]["data"]
        worker_config = expected["audit-export-worker-config"]["data"]
        required = {"AUDIT_EXPORT_S3_BUCKET", "AUDIT_EXPORT_S3_REGION", "AUDIT_EXPORT_PUBLIC_KEY_PEM", "AUDIT_EXPORT_LINK_SECRET", "BILLING_DATABASE_URL"}
        if not required.issubset(api_config) or len(api_config["AUDIT_EXPORT_LINK_SECRET"].encode()) < 32:
            raise ValueError("tenant-control-plane-config: API audit export needs generated S3, public key, billing URL, and 32-byte link secret")
        if api_config["AUDIT_EXPORT_PUBLIC_KEY_PEM"] != worker_config["AUDIT_EXPORT_PUBLIC_KEY_PEM"]:
            raise ValueError("tenant-control-plane-config: API public key does not match the worker signing identity")
        if api_config["AUDIT_EXPORT_S3_BUCKET"] != worker_config["AUDIT_EXPORT_S3_BUCKET"] or api_config["AUDIT_EXPORT_S3_REGION"] != worker_config["AUDIT_EXPORT_S3_REGION"]:
            raise ValueError("tenant-control-plane-config: API and worker must use the same Terraform-owned S3 bucket and region")

    if CONTROL_LOOKUP_SECRET_CONSUMERS & application_secrets.keys():
        control_config = expected.get("tenant-control-plane-config", {}).get("data", {})
        canonical_token = control_config.get("CONTROL_LOOKUP_TOKEN", "")
        if len(canonical_token.encode("utf-8")) < 32:
            raise ValueError("tenant-control-plane-config: canonical CONTROL_LOOKUP_TOKEN must contain at least 32 bytes")
        for name in sorted(CONTROL_LOOKUP_SECRET_CONSUMERS & application_secrets.keys()):
            token = expected.get(name, {}).get("data", {}).get("CONTROL_LOOKUP_TOKEN", "")
            if len(token.encode("utf-8")) < 32:
                raise ValueError(f"{name}: CONTROL_LOOKUP_TOKEN must contain at least 32 bytes")
            if token != canonical_token:
                raise ValueError(f"{name}: CONTROL_LOOKUP_TOKEN differs from the control-plane authority token")

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
    replay = expected.get("greenguard-telemetry-replay-config", {}).get("data", {})
    if replay and f'user_{replay["KAFKA_SASL_USERNAME"]}="{replay["KAFKA_SASL_PASSWORD"]}"' not in broker_jaas:
        raise ValueError("greenguard-telemetry-replay-config: Kafka broker JAAS does not contain its write-only replay credential")
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
