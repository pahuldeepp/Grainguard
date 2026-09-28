#!/usr/bin/env python3
"""Terraform runtime Secret lifecycle; never prints values or retains kubeconfig."""
import importlib.util
import base64
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import urlparse, unquote, parse_qs
from pathlib import Path
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location("runtime_sync", Path(__file__).with_name("sync-secrets.py"))
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)
OWNER_KEY = "greenguard.io/terraform-scope"


def scope_from_environment():
    scope = json.loads(os.environ["GG_RUNTIME_SECRET_SCOPE"])
    if set(scope) != {"account_id", "region", "environment", "cluster", "rds_instance", "namespace", "versions", "master_version", "sources", "shard_bootstraps"}:
        raise ValueError("Unexpected Terraform secret scope contract")
    patterns = {"account_id": r"[0-9]{12}", "region": r"[a-z]{2}(?:-[a-z]+)+-[0-9]+",
                "environment": r"[a-z][a-z0-9-]{1,15}", "cluster": r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}",
                "rds_instance": r"[a-z][a-z0-9-]{0,62}", "namespace": r"greenguard"}
    if any(not isinstance(scope[k], str) or not re.fullmatch(p, scope[k]) for k, p in patterns.items()):
        raise ValueError("Invalid Terraform secret scope")
    if scope["environment"] in {"prod", "production"}:
        raise ValueError("Disposable secret lifecycle forbids production")
    if not isinstance(scope["master_version"], str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", scope["master_version"]):
        raise ValueError("Terraform RDS master version is required")
    if not isinstance(scope["versions"], dict) or not scope["versions"] or any(
        not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,120}", name) or
        not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", version)
        for name, version in scope["versions"].items()
    ):
        raise ValueError("Terraform-owned secret versions are required")
    if not isinstance(scope["sources"], dict) or set(scope["sources"]) != set(scope["versions"]):
        raise ValueError("Source/version contract differs")
    if any(not source.startswith(f"greenguard/{scope['environment']}/") or not re.fullmatch(r"[a-z0-9/_-]+", source) for source in scope["sources"].values()):
        raise ValueError("Source environment scope differs")
    shard_bootstraps = scope["shard_bootstraps"]
    if not isinstance(shard_bootstraps, dict):
        raise ValueError("Shard bootstrap scope must be a map")
    expected_shards = {f"greenguard-s{number}-rds-bootstrap" for number in range(1, 5)}
    bootstrap_names = {name for name in scope["versions"] if re.fullmatch(r"greenguard-s[1-4]-rds-bootstrap", name)}
    if set(shard_bootstraps) != bootstrap_names or (bootstrap_names and bootstrap_names != expected_shards):
        raise ValueError("Shard bootstrap names must match the complete four-shard runtime contract")
    for name, bootstrap in shard_bootstraps.items():
        shard_id = name.removeprefix("greenguard-").removesuffix("-rds-bootstrap")
        expected_source = f"greenguard/{scope['environment']}/shards/{shard_id}/bootstrap"
        if scope["sources"].get(name) != expected_source:
            raise ValueError(f"{name}: shard bootstrap source scope differs")
        if not isinstance(bootstrap, dict) or set(bootstrap) != {
            "instance", "host", "master_arn", "master_version", "incarnation", "replica_hosts"
        }:
            raise ValueError(f"{name}: shard physical scope contract is incomplete or unexpected")
        if not isinstance(bootstrap["instance"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", bootstrap["instance"]):
            raise ValueError(f"{name}: invalid RDS instance identifier")
        host = bootstrap["host"]
        if not isinstance(host, str) or len(host) > 253 or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in host.split(".")
        ):
            raise ValueError(f"{name}: invalid RDS endpoint host")
        master_prefix = f"arn:aws:secretsmanager:{scope['region']}:{scope['account_id']}:secret:"
        if not isinstance(bootstrap["master_arn"], str) or not bootstrap["master_arn"].startswith(master_prefix) or not re.fullmatch(
            r"arn:aws:secretsmanager:[a-z]{2}(?:-[a-z]+)+-[0-9]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}",
            bootstrap["master_arn"],
        ):
            raise ValueError(f"{name}: shard master secret ARN is outside the Terraform account/region")
        if not isinstance(bootstrap["master_version"], str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", bootstrap["master_version"]):
            raise ValueError(f"{name}: shard master version is required")
        try:
            uuid.UUID(bootstrap["incarnation"])
        except (ValueError, TypeError, AttributeError):
            raise ValueError(f"{name}: invalid immutable RDS incarnation") from None
        replicas = bootstrap["replica_hosts"]
        if not isinstance(replicas, list) or any(
            not isinstance(replica, str) or len(replica) > 253 or any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in replica.split(".")
            ) for replica in replicas
        ) or len(set(replicas)) != len(replicas) or host in replicas:
            raise ValueError(f"{name}: invalid or duplicate read replica endpoint hosts")
    return scope


def scope_identity(scope):
    return ":".join(scope[k] for k in ("account_id", "region", "environment", "cluster"))


def guarded_sources(scope):
    command = sync.preflight.command
    if command("aws", "sts", "get-caller-identity")["Account"] != scope["account_id"]:
        raise RuntimeError("AWS account differs from Terraform scope")
    cluster = command("aws", "eks", "describe-cluster", "--region", scope["region"], "--name", scope["cluster"])["cluster"]
    prefix = f"arn:aws:eks:{scope['region']}:{scope['account_id']}:cluster/"
    if cluster.get("arn") != prefix + scope["cluster"] or cluster.get("tags", {}).get("Environment") != scope["environment"] or cluster.get("tags", {}).get("Lifecycle") != "Disposable":
        raise RuntimeError("EKS cluster scope/ownership mismatch")
    db = command("aws", "rds", "describe-db-instances", "--region", scope["region"],
                 "--db-instance-identifier", scope["rds_instance"])["DBInstances"]
    expected_arn = f"arn:aws:rds:{scope['region']}:{scope['account_id']}:db:{scope['rds_instance']}"
    if len(db) != 1 or db[0].get("DBInstanceArn") != expected_arn:
        raise RuntimeError("RDS instance scope mismatch")
    tags = {tag["Key"]: tag["Value"] for tag in db[0].get("TagList", [])}
    if any(tags.get(k) != v for k, v in {"Environment": scope["environment"], "Lifecycle": "Disposable", "ManagedBy": "Terraform"}.items()):
        raise RuntimeError("RDS instance ownership mismatch")
    if not db[0].get("MasterUserSecret", {}).get("SecretArn", "").startswith(f"arn:aws:secretsmanager:{scope['region']}:{scope['account_id']}:secret:"):
        raise RuntimeError("RDS master secret scope mismatch")
    for bootstrap in scope["shard_bootstraps"].values():
        shard = command("aws", "rds", "describe-db-instances", "--region", scope["region"], "--db-instance-identifier", bootstrap["instance"])["DBInstances"]
        arn = f"arn:aws:rds:{scope['region']}:{scope['account_id']}:db:{bootstrap['instance']}"
        if len(shard) != 1 or shard[0].get("DBInstanceArn") != arn or shard[0].get("Endpoint", {}).get("Address") != bootstrap["host"] or shard[0].get("MasterUserSecret", {}).get("SecretArn") != bootstrap["master_arn"]:
            raise RuntimeError("Shard physical resource scope mismatch")
        resource_id = shard[0].get("DbiResourceId")
        expected_incarnation = str(uuid.uuid5(uuid.NAMESPACE_URL, f"arn:aws:rds:{scope['region']}:{scope['account_id']}:db-resource:{resource_id}"))
        if not resource_id or bootstrap["incarnation"] != expected_incarnation:
            raise RuntimeError("Shard immutable resource incarnation mismatch")
        tags = {tag["Key"]: tag["Value"] for tag in shard[0].get("TagList", [])}
        if any(tags.get(k) != v for k, v in {"Environment": scope["environment"], "Cell": scope["cluster"], "ManagedBy": "Terraform", "Lifecycle": "Disposable"}.items()):
            raise RuntimeError("Shard resource ownership mismatch")
    for name, version in scope["versions"].items():
        source = scope["sources"][name]
        record = command("aws", "secretsmanager", "describe-secret", "--region", scope["region"], "--secret-id", source)
        tags = {tag["Key"]: tag["Value"] for tag in record.get("Tags", [])}
        arn_prefix = f"arn:aws:secretsmanager:{scope['region']}:{scope['account_id']}:secret:{source}-"
        if record.get("Name") != source or not record.get("ARN", "").startswith(arn_prefix) or record.get("DeletedDate") or any(
            tags.get(k) != v for k, v in {"Environment": scope["environment"], "Cell": scope["cluster"],
                                       "Lifecycle": "Disposable", "ManagedBy": "Terraform"}.items()
        ):
            raise RuntimeError(f"{name}: AWS source scope/ownership mismatch")
        if version not in record.get("VersionIdsToStages", {}):
            raise RuntimeError(f"{name}: Terraform-owned source version is absent")
    return cluster


def run_checked(argv, payload=None):
    result = subprocess.run(argv, input=payload, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"{argv[0]} {argv[1]} failed (exit {result.returncode}); values withheld")
    return result.stdout


def annotate_desired(name, scope, record, existing):
    identity = scope_identity(scope)
    if existing and existing.get("metadata", {}).get("annotations", {}).get(OWNER_KEY) != identity:
        raise RuntimeError(f"{name}: Terraform scope ownership mismatch")
    desired = sync.desired_secret(name, scope["namespace"], record, existing)
    desired["metadata"]["annotations"][OWNER_KEY] = identity
    return desired


def cleanup(scope):
    # Validate every object before the first deletion. A failed partial apply can
    # leave a subset; absence is safe, foreign or newer objects are never removed.
    planned = []
    for name, version in scope["versions"].items():
        current = sync.existing_secret(name, scope["namespace"])
        if not current:
            continue
        metadata = current.get("metadata", {})
        annotations = metadata.get("annotations", {})
        if current.get("type") != "Opaque" or metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != sync.OWNER or annotations.get(OWNER_KEY) != scope_identity(scope) or annotations.get("greenguard.io/aws-secret-name") != scope["sources"][name] or annotations.get("greenguard.io/aws-version-id") != version:
            raise RuntimeError(f"{name}: refusing teardown of foreign or changed Secret")
        if name in scope["shard_bootstraps"] and annotations.get("greenguard.io/rds-master-version-id") != scope["shard_bootstraps"][name]["master_version"]:
            raise RuntimeError(f"{name}: refusing teardown of changed shard master")
        if name == "greenguard-rds-bootstrap" and annotations.get("greenguard.io/rds-master-version-id") != scope["master_version"]:
            raise RuntimeError(f"{name}: refusing teardown of changed master version")
        if not metadata.get("uid") or not metadata.get("resourceVersion"):
            raise RuntimeError(f"{name}: teardown requires UID/resourceVersion")
        planned.append((name, metadata))
    for name, metadata in planned:
        path = f"/api/v1/namespaces/{scope['namespace']}/secrets/{name}"
        options = {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {
            "uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"]}}
        run_checked(["kubectl", "delete", "--raw", path, "-f", "-"], json.dumps(options))
    print(f"PASS removed {len(planned)} Terraform-owned Secrets; namespace retained")



def validate_profiles(expected):
    """Validate cryptographic parsing and role URL equality before any writes."""
    bootstrap = expected["greenguard-rds-bootstrap"]["data"]
    role_profiles = {
        "INVENTORY_DATABASE_URL": ("inventory_app", "greenguard_inventory", "INVENTORY_DB_PASSWORD"),
        "TELEMETRY_DATABASE_URL": ("telemetry_app", "greenguard_telemetry", "TELEMETRY_DB_PASSWORD"),
        "PROJECTION_DATABASE_URL": ("projection_app", "greenguard_read", "PROJECTION_DB_PASSWORD"),
        "READ_QUERY_DATABASE_URL": ("read_query", "greenguard_read", "READ_QUERY_DB_PASSWORD"),
        "RISK_DATABASE_URL": ("risk_app", "greenguard_risk", "RISK_DB_PASSWORD"),
        "JOBS_DATABASE_URL": ("jobs_app", "greenguard_jobs", "JOBS_DB_PASSWORD"),
        "NOTIFICATIONS_DATABASE_URL": ("notifications_app", "greenguard_notifications", "NOTIFICATIONS_DB_PASSWORD"),
        "ALERTS_DATABASE_URL": ("alerts_app", "greenguard_alerts", "ALERTS_DB_PASSWORD"),
        "SAGA_DATABASE_URL": ("saga_app", "greenguard_sagas", "SAGA_DB_PASSWORD"),
        "HARDWARE_DATABASE_URL": ("hardware_app", "greenguard_hardware", "HARDWARE_DB_PASSWORD"),
        "CONTROL_DATABASE_URL": ("control_app", "greenguard_control", "CONTROL_DB_PASSWORD"),
        "CONTROL_ENTITLEMENT_PROJECTOR_URL": ("control_entitlement_projector", "greenguard_control", "CONTROL_ENTITLEMENT_PROJECTOR_PASSWORD"),
        "BILLING_DATABASE_URL": ("billing_app", "greenguard_billing", "BILLING_DB_PASSWORD"),
    }
    for name, record in expected.items():
        for key, value in record["data"].items():
            if key in role_profiles:
                role, database, password_key = role_profiles[key]
                parsed = urlparse(value)
                if parsed.scheme not in {"postgres", "postgresql"} or unquote(parsed.username or "") != role or unquote(parsed.password or "") != bootstrap[password_key] or parsed.path != "/" + database or parsed.hostname != bootstrap["PGHOST"] or parsed.port != 5432 or parse_qs(parsed.query) != {"sslmode": ["verify-full"], "sslrootcert": ["/etc/greenguard/rds/ca.pem"]}:
                    raise RuntimeError(f"{name}: database role profile mismatch")
            if key.endswith((".crt", ".pem")):
                # OpenSSL parses ASN.1, rejects expired certificates and checks CA
                # constraints; marker-only strings are insufficient for apply.
                run_checked(["openssl", "x509", "-checkend", "0", "-noout"], value)
                if key in {"ca.crt", "ca.pem", "registry-ca.crt"}:
                    details = run_checked(["openssl", "x509", "-text", "-noout"], value)
                    if "CA:TRUE" not in details:
                        raise RuntimeError(f"{name}: CA certificate lacks CA constraint")
            elif key.endswith(".key"):
                run_checked(["openssl", "pkey", "-noout", "-passin", "pass:"], value)
        for certificate_key, private_key in (("tls.crt", "tls.key"), ("node.crt", "node.key"), ("admin.crt", "admin.key")):
            if certificate_key in record["data"] and private_key in record["data"]:
                certificate_public = run_checked(["openssl", "x509", "-pubkey", "-noout"], record["data"][certificate_key])
                key_public = run_checked(["openssl", "pkey", "-pubout", "-passin", "pass:"], record["data"][private_key])
                if certificate_public != key_public:
                    raise RuntimeError(f"{name}: certificate/private key mismatch")
        for key, password_key in {"broker.keystore.p12": "keystore-password", "broker.truststore.p12": "truststore-password",
                                  "registry.keystore.p12": "registry-keystore-password", "kafka.truststore.p12": "truststore-password",
                                  "server.p12": "keystore-password"}.items():
            if key in record["data"]:
                environment = {**os.environ, "GG_PKCS12_PASSWORD": record["data"][password_key]}
                result = subprocess.run(["openssl", "pkcs12", "-info", "-noout", "-passin", "env:GG_PKCS12_PASSWORD"],
                                        input=base64.b64decode(record["data"][key], validate=True),
                                        capture_output=True, check=False, env=environment)
                if result.returncode:
                    raise RuntimeError(f"{name}: invalid PKCS12 material or password")



def extend_expected(scope, expected):
    """Read only immutable Terraform-owned supplemental versions."""
    for name in set(scope["versions"]) - set(expected):
        source = scope["sources"][name]
        response = sync.preflight.command("aws", "secretsmanager", "get-secret-value", "--region", scope["region"],
                                          "--secret-id", source, "--version-stage", "AWSCURRENT")
        if response.get("Name") != source or response.get("VersionId") != scope["versions"][name] or "AWSCURRENT" not in response.get("VersionStages", []):
            raise RuntimeError(f"{name}: supplemental source/version mismatch")
        data = json.loads(response["SecretString"])
        if not isinstance(data, dict) or not data or not all(isinstance(k, str) and isinstance(v, str) and v for k, v in data.items()):
            raise RuntimeError(f"{name}: supplemental source must be a nonempty string map")
        master_version = ""
        if name in scope["shard_bootstraps"]:
            bootstrap = scope["shard_bootstraps"][name]
            role_keys = set(re.findall(r"^\\getenv\s+\S+\s+(\S+)\s*$", sync.preflight.SQL.read_text(), re.MULTILINE))
            if set(data) != role_keys:
                raise RuntimeError(f"{name}: incomplete bootstrap role profile")
            master = sync.preflight.command("aws", "secretsmanager", "get-secret-value", "--region", scope["region"],
                                           "--secret-id", bootstrap["master_arn"], "--version-stage", "AWSCURRENT")
            master_version = master.get("VersionId")
            if master_version != bootstrap["master_version"] or "AWSCURRENT" not in master.get("VersionStages", []):
                raise RuntimeError(f"{name}: shard master rotated beyond Terraform scope")
            password = json.loads(master["SecretString"])["password"]
            if not isinstance(password, str) or not password:
                raise RuntimeError(f"{name}: master password missing")
            data = {**data, "PGHOST": bootstrap["host"], "PGPASSWORD": password}
        expected[name] = {"source": source, "version": response["VersionId"], "master_version": master_version, "data": data}



def validate_supplemental_profiles(scope, expected):
    template = Path(__file__).with_name("applications-chart") / "templates" / "_owner-migrations.tpl"
    owners = {row["name"]: row for row in json.loads(re.search(r"fromJsonArray `([^`]+)`", template.read_text()).group(1))}
    service_owners = {"device-service": "inventory", "telemetry-ingest": "telemetry", "projection-builder": "projection",
                      "risk-engine": "risk", "workflow-alerts": "alerts", "jobs-worker": "jobs", "notification-service": "notifications",
                      "saga-orchestrator": "saga", "hardware-service": "hardware", "read-api": "projection"}
    for name, record in expected.items():
        match = re.fullmatch(r"greenguard-(?:(s[1-4])-)?([a-z]+)-migration", name)
        if match:
            shard_id, owner = match.groups()
            if owner not in owners or bool(shard_id) == owners[owner]["central"]:
                raise RuntimeError(f"{name}: migration authority scope mismatch")
            profile = owners[owner]
            if set(record["data"]) != {profile["key"]}:
                raise RuntimeError(f"{name}: migration key contract mismatch")
            bootstrap_name = f"greenguard-{shard_id}-rds-bootstrap" if shard_id else "greenguard-rds-bootstrap"
            bootstrap = expected[bootstrap_name]["data"]
            parsed = urlparse(record["data"][profile["key"]])
            if parsed.scheme != "postgresql" or unquote(parsed.username or "") != profile["migrator"] or unquote(parsed.password or "") != bootstrap[owner.upper() + "_MIGRATOR_PASSWORD"] or parsed.hostname != bootstrap["PGHOST"] or parsed.port != 5432 or parsed.path != "/" + profile["database"] or parse_qs(parsed.query) != {"sslmode": ["verify-full"], "sslrootcert": ["/rds-ca/ca.pem"]}:
                raise RuntimeError(f"{name}: migration role/endpoint/TLS profile mismatch")
        elif re.fullmatch(r"greenguard-s[1-4]-(?:pgbouncer-auth|cdc-credentials)", name):
            shard_id = name.split("-")[1]
            bootstrap = expected[f"greenguard-{shard_id}-rds-bootstrap"]["data"]
            if name.endswith("cdc-credentials"):
                if record["data"] != {"CDC_DB_PASSWORD": bootstrap["CDC_DB_PASSWORD"]}:
                    raise RuntimeError(f"{name}: CDC role password mismatch")
            else:
                roles = {row["role"]: owner.upper() + "_DB_PASSWORD" for owner, row in owners.items() if not row["central"]}
                roles.update({"read_query": "READ_QUERY_DB_PASSWORD", "inventory_projector": "INVENTORY_PROJECTOR_PASSWORD",
                              "telemetry_entitlement_projector": "TELEMETRY_ENTITLEMENT_PROJECTOR_PASSWORD", "read_entitlement_projector": "READ_ENTITLEMENT_PROJECTOR_PASSWORD"})
                if set(record["data"]) != {"userlist.txt"}:
                    raise RuntimeError(f"{name}: PgBouncer key contract mismatch")
                lines = record["data"]["userlist.txt"].splitlines()
                parsed = [re.fullmatch(r'"([a-z_]+)" "([^"\\\r\n]+)"', line) for line in lines]
                if not all(parsed) or len(parsed) != len(roles) or {row.group(1) for row in parsed} != set(roles) or any(row.group(2) != bootstrap[roles[row.group(1)]] for row in parsed):
                    raise RuntimeError(f"{name}: PgBouncer role/password profile mismatch")
        elif name.startswith("greenguard-shard-routing-"):
            service = name.removeprefix("greenguard-shard-routing-")
            special_profiles = {"read-entitlement-projector": ("read-api", "projection", "read_entitlement_projector", "READ_ENTITLEMENT_PROJECTOR_PASSWORD"),
                                "inventory-projector": ("device-service", "inventory", "inventory_projector", "INVENTORY_PROJECTOR_PASSWORD"),
                                "telemetry-entitlement-projector": ("telemetry-ingest", "telemetry", "telemetry_entitlement_projector", "TELEMETRY_ENTITLEMENT_PROJECTOR_PASSWORD"),
                                "audit-export-worker": ("audit-export-worker", "inventory", "inventory_audit_reader", "INVENTORY_AUDIT_READER_PASSWORD")}
            if service not in set(service_owners) | set(special_profiles) or set(record["data"]) != {"registry.json"}:
                raise RuntimeError(f"{name}: registry service/key contract mismatch")
            actual_service = special_profiles[service][0] if service in special_profiles else service
            owner = special_profiles[service][1] if service in special_profiles else service_owners[service]
            profile = owners[owner]
            role = "read_query" if service == "read-api" else profile["role"]
            password_key = "READ_QUERY_DB_PASSWORD" if service == "read-api" else owner.upper() + "_DB_PASSWORD"
            if service in special_profiles:
                role, password_key = special_profiles[service][2:]
            manifest = json.loads(record["data"]["registry.json"])
            if set(manifest) != {"formatVersion", "service", "database", "shards"} or manifest["formatVersion"] != 1 or manifest["service"] != actual_service or manifest["database"] != profile["database"] or set(manifest["shards"]) != {"s1", "s2", "s3", "s4"}:
                raise RuntimeError(f"{name}: complete registry contract mismatch")
            for shard_id, entry in manifest["shards"].items():
                bootstrap_name = f"greenguard-{shard_id}-rds-bootstrap"
                physical = scope["shard_bootstraps"][bootstrap_name]
                bootstrap = expected[bootstrap_name]["data"]
                if set(entry) != {"incarnation", "primaryUrl", "replicaUrls"} or entry["incarnation"] != physical["incarnation"] or not isinstance(entry["replicaUrls"], list):
                    raise RuntimeError(f"{name}: physical shard incarnation mismatch")
                urls = [entry["primaryUrl"], *entry["replicaUrls"]]
                hosts = [physical["host"], *physical["replica_hosts"]]
                if len(urls) != len(hosts) or len(set(hosts)) != len(hosts):
                    raise RuntimeError(f"{name}: physical endpoint cardinality mismatch")
                for raw, host in zip(urls, hosts):
                    parsed = urlparse(raw)
                    if parsed.scheme != "postgresql" or parsed.hostname != host or parsed.port != 5432 or unquote(parsed.username or "") != role or unquote(parsed.password or "") != bootstrap[password_key] or parsed.path != "/" + profile["database"] or parse_qs(parsed.query) != {"sslmode": ["verify-full"], "sslrootcert": ["/etc/greenguard/rds/ca.pem"]}:
                        raise RuntimeError(f"{name}: shard role/endpoint/TLS profile mismatch")


def apply(scope):
    args = SimpleNamespace(**{k: v for k, v in scope.items() if k not in {"versions", "master_version", "sources", "shard_bootstraps"}})
    expected = sync.preflight.expected_secrets(args)
    extend_expected(scope, expected)
    if set(expected) != set(scope["versions"]):
        raise RuntimeError("Terraform version names differ from required runtime contract")
    if expected["greenguard-rds-bootstrap"]["master_version"] != scope["master_version"]:
        raise RuntimeError("RDS AWSCURRENT master version differs from Terraform scope")
    validate_profiles(expected)
    validate_supplemental_profiles(scope, expected)
    planned = []
    for name, record in expected.items():
        if record["version"] != scope["versions"][name]:
            raise RuntimeError(f"{name}: AWSCURRENT differs from Terraform-owned version")
        current = sync.existing_secret(name, scope["namespace"])
        desired = annotate_desired(name, scope, record, current)
        if not sync.same_secret(current, desired):
            planned.append((desired, current is not None))
    # Namespaces are owned by the application's Terraform bootstrap lifecycle.
    # Requiring one prevents orphan namespace creation on a failed secret apply.
    run_checked(["kubectl", "get", "namespace", scope["namespace"], "-o", "name"])
    for desired, replace in planned:
        sync.write_secret(desired, replace)
    if sync.preflight.verify_targets(expected, scope["namespace"]):
        raise RuntimeError("Runtime Secret verification failed")
    print(f"PASS synchronized {len(expected)} Terraform-owned Secrets; values withheld")


def main():
    if sys.argv[1:] not in (["apply"], ["destroy"]):
        raise ValueError("Expected apply or destroy")
    scope = scope_from_environment()
    guarded_sources(scope)
    # --dry-run avoids modifying ~/.kube/config. TemporaryDirectory removes the
    # scoped credential configuration on success, exceptions and termination.
    # Termination must unwind the temporary credential directory as well.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    previous = os.environ.get("KUBECONFIG")
    with tempfile.TemporaryDirectory(prefix="greenguard-runtime-sync-") as directory:
        path = Path(directory) / "config"
        config = run_checked(["aws", "eks", "update-kubeconfig", "--region", scope["region"],
                              "--name", scope["cluster"], "--kubeconfig", str(path), "--dry-run"])
        path.write_text(config)
        path.chmod(0o600)
        os.environ["KUBECONFIG"] = str(path)
        try:
            (apply if sys.argv[1] == "apply" else cleanup)(scope)
        finally:
            if previous is None:
                os.environ.pop("KUBECONFIG", None)
            else:
                os.environ["KUBECONFIG"] = previous
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
