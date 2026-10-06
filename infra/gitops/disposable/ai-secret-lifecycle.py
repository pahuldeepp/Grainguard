#!/usr/bin/env python3
"""Guarded AWS Secrets Manager -> disposable GreenGuard AI Secret lifecycle.

Guard receives bounded per-field fingerprints and a small Redis TLS subset;
full payload bundles never enter process arguments or environment variables. `sync` copies exact current
AWS versions into the exact disposable EKS namespace. `cleanup` deletes only
Secrets bearing this Terraform owner and scope, with UID/resourceVersion
preconditions. No AWS operations are run by unit tests.
"""

from __future__ import annotations

import base64
import binascii
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


OWNER = "greenguard-ai-secret-sync"
SCOPE_ANNOTATION = "greenguard.io/terraform-scope"
VERSION_ANNOTATION = "greenguard.io/aws-version-id"
SOURCE_ANNOTATION = "greenguard.io/aws-secret-name"
EXPECTED_KEYS = {
    "greenguard-ai-database-roles": {
        "KNOWLEDGE_APP_PASSWORD", "KNOWLEDGE_MIGRATOR_PASSWORD", "KNOWLEDGE_PROVISIONER_PASSWORD",
        "KNOWLEDGE_REVIEWER_PASSWORD", "KNOWLEDGE_WORKER_PASSWORD", "ADVISOR_APP_PASSWORD", "ADVISOR_MIGRATOR_PASSWORD",
        "ADVISOR_CHECKPOINT_APP_PASSWORD", "ADVISOR_CHECKPOINT_MIGRATOR_PASSWORD",
        "MODEL_GATEWAY_APP_PASSWORD", "MODEL_GATEWAY_USAGE_PASSWORD", "MODEL_GATEWAY_MIGRATOR_PASSWORD",
    },
    "greenguard-knowledge-runtime": {
        "database-url", "control-lookup-token", "namespace-hmac-key", "pinecone-api-key", "redis-url",
        "gateway-tokens.json", "relay-tenants.json", "retention-scopes.json", "kafka-username", "kafka-password",
    },
    "greenguard-knowledge-worker-runtime": {"database-url"},
    "greenguard-knowledge-migrator": {"database-url"},
    "greenguard-advisor-runtime": {"database-url", "membership-service-token", "alerts-service-token"},
    "greenguard-advisor-migrator": {"database-url"},
    "greenguard-model-gateway-runtime": {"access.json", "controls.json", "redis-url", "budget-dsn", "voyage-key", "anthropic-key"},
    "greenguard-model-gateway-migrator": {"database-url"},
    "greenguard-model-gateway-budget-bootstrap": {"budget-dsn", "budget-caps.json"},
    "greenguard-model-gateway-usage": {"relay.json", "consume.json"},
    "greenguard-ai-kafka-ca": {"ca.pem"},
    "greenguard-ai-redis": {"password", "server.crt", "server.key", "ca.pem"},
    "greenguard-bff-model-gateway": {"gateway-tokens.json"},
    "greenguard-bff-delegation": {"private-key.pem", "kid"},
}
CELL_HASH = re.compile(r"[a-f0-9]{16}")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def run(argv: list[str], *, payload: str | bytes | None = None, text: bool = True) -> str | bytes:
    result = subprocess.run(argv, input=payload, capture_output=True, text=text, check=False)
    if result.returncode:
        raise RuntimeError(f"{argv[0]} {argv[1]} failed (exit {result.returncode}); secret data withheld")
    return result.stdout


def run_json(*argv: str):
    return json.loads(run(list(argv)))


def scope_from_environment() -> dict:
    raw = os.environ.get("GG_AI_SCOPE", "")
    if not raw or len(raw) > 128_000:
        raise ValueError("AI cell scope is missing or oversized")
    try:
        scope = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("AI cell scope is invalid JSON") from None
    allowed = {"account_id", "region", "environment", "cell", "cluster", "namespace", "sources"}
    allowed_versions = allowed | {"versions"}
    if not isinstance(scope, dict) or set(scope) not in (allowed, allowed_versions):
        raise ValueError("AI cell scope has an unexpected field contract")
    patterns = {
        "account_id": r"[0-9]{12}", "region": r"[a-z]{2}(?:-[a-z]+)+-[0-9]+",
        "environment": r"[a-z][a-z0-9-]{1,15}", "cell": r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}",
        "cluster": r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", "namespace": r"greenguard",
    }
    for key, pattern in patterns.items():
        if not isinstance(scope.get(key), str) or not re.fullmatch(pattern, scope[key]):
            raise ValueError("AI cell scope has an invalid identity")
    if scope["cell"] != scope["cluster"] or scope["environment"].lower() in {"prod", "production"}:
        raise ValueError("AI secrets require the exact disposable non-production cell")
    if not isinstance(scope.get("sources"), dict) or set(scope["sources"]) != set(EXPECTED_KEYS):
        raise ValueError("AI Secret names differ from the fixed contract")
    cell_hash = hashlib.sha256(scope["cluster"].encode()).hexdigest()[:16]
    expected = {
        name: (f"greenguard/{scope['environment']}/cell-{cell_hash}/ai/database-roles"
               if name == "greenguard-ai-database-roles"
               else f"greenguard/{scope['environment']}/cell-{cell_hash}/ai/runtime/{name}")
        for name in EXPECTED_KEYS
    }
    if scope["sources"] != expected:
        raise ValueError("AI Secrets Manager paths are outside the exact cell scope")
    if "versions" in scope:
        if not isinstance(scope["versions"], dict) or set(scope["versions"]) != set(EXPECTED_KEYS):
            raise ValueError("AI Secret version inventory differs from the fixed contract")
        if any(not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", v) for v in scope["versions"].values()):
            raise ValueError("AI Secret version IDs are invalid")
    return scope


def scope_identity(scope: dict) -> str:
    return ":".join(scope[key] for key in ("account_id", "region", "environment", "cell", "cluster"))


def aws_scope(scope: dict) -> dict:
    identity = run_json("aws", "sts", "get-caller-identity", "--output", "json")
    if identity.get("Account") != scope["account_id"]:
        raise RuntimeError("AWS caller account differs from the AI cell scope")
    cluster = run_json("aws", "eks", "describe-cluster", "--region", scope["region"], "--name", scope["cluster"], "--output", "json").get("cluster", {})
    expected_arn = f"arn:aws:eks:{scope['region']}:{scope['account_id']}:cluster/{scope['cluster']}"
    tags = cluster.get("tags", {})
    if cluster.get("arn") != expected_arn or any(tags.get(k) != v for k, v in {
        "Environment": scope["environment"], "Lifecycle": "Disposable", "ManagedBy": "Terraform",
    }.items()):
        raise RuntimeError("EKS ARN/tags differ from the selected AI disposable cell")
    return cluster


def aws_secret_metadata(scope: dict) -> dict[str, dict]:
    cell_hash = hashlib.sha256(scope["cluster"].encode()).hexdigest()[:16]
    records = {}
    for target, source in sorted(scope["sources"].items()):
        record = run_json("aws", "secretsmanager", "describe-secret", "--region", scope["region"], "--secret-id", source, "--output", "json")
        expected_arn_prefix = f"arn:aws:secretsmanager:{scope['region']}:{scope['account_id']}:secret:{source}-"
        tags = {row.get("Key"): row.get("Value") for row in record.get("Tags", [])}
        if record.get("Name") != source or not record.get("ARN", "").startswith(expected_arn_prefix) or any(tags.get(k) != v for k, v in {
            "Environment": scope["environment"], "Cell": scope["cell"], "CellId": cell_hash,
            "Lifecycle": "Disposable", "ManagedBy": "Terraform", "SecretOwner": "greenguard-ai-runtime",
        }.items()):
            raise RuntimeError(f"{target}: AWS Secret path/account/cell ownership mismatch")
        records[target] = record
    return records


def current_secret_data(scope: dict, target: str, expected_version: str | None = None) -> dict | None:
    source = scope["sources"][target]
    stage_info = run_json("aws", "secretsmanager", "describe-secret", "--region", scope["region"], "--secret-id", source, "--output", "json").get("VersionIdsToStages", {})
    currents = [version for version, stages in stage_info.items() if "AWSCURRENT" in stages]
    if not currents:
        if expected_version is not None:
            raise RuntimeError(f"{target}: the Terraform-owned current version is absent")
        return None
    if len(currents) != 1 or (expected_version is not None and currents[0] != expected_version):
        raise RuntimeError(f"{target}: AWS current version differs from exact Terraform cell scope")
    response = run_json("aws", "secretsmanager", "get-secret-value", "--region", scope["region"], "--secret-id", source, "--version-id", currents[0], "--output", "json")
    if response.get("Name") != source or response.get("VersionId") != currents[0] or "AWSCURRENT" not in response.get("VersionStages", []):
        raise RuntimeError(f"{target}: AWS Secret current version metadata is inconsistent")
    try:
        data = json.loads(response["SecretString"])
    except (KeyError, json.JSONDecodeError):
        raise RuntimeError(f"{target}: AWS Secret payload is not a JSON byte map") from None
    validate_payload_map(target, data)
    return data


def validate_payload_map(target: str, data: dict) -> None:
    if not isinstance(data, dict) or set(data) != EXPECTED_KEYS[target]:
        raise ValueError(f"{target}: payload keys differ from the exact Kubernetes Secret contract")
    for value in data.values():
        if not isinstance(value, str) or not value or len(value) > 2_000_000:
            raise ValueError(f"{target}: Secret byte map contains an empty or oversized value")
        try:
            decoded = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError):
            raise ValueError(f"{target}: Secret byte map is not canonical base64") from None
        if not decoded:
            raise ValueError(f"{target}: empty Secret material is forbidden")


def expected_payload_bundle() -> dict[str, dict]:
    raw = os.environ.get("GG_AI_EXPECTED_FINGERPRINTS", "")
    if not raw or len(raw) > 32_000:
        raise ValueError("AI fingerprint bundle is missing or oversized")
    try:
        payloads = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("AI fingerprint bundle is invalid JSON") from None
    if not isinstance(payloads, dict) or set(payloads) != set(EXPECTED_KEYS):
        raise ValueError("AI fingerprint bundle differs from fixed Secret names")
    for name, payload in payloads.items():
        if not isinstance(payload, dict) or set(payload) != EXPECTED_KEYS[name]:
            raise ValueError(f"{name}: fingerprint keys differ from fixed contract")
        if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in payload.values()):
            raise ValueError("AI fingerprint must be SHA256")
    return payloads


def expected_redis_tls(fingerprints: dict[str, dict]) -> dict:
    raw = os.environ.get("GG_AI_REDIS_TLS", "")
    if not raw or len(raw) > 64_000:
        raise ValueError("AI Redis TLS subset is missing or oversized")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("AI Redis TLS subset is invalid JSON") from None
    if not isinstance(value, dict) or set(value) != {"server.crt", "server.key", "ca.pem"}:
        raise ValueError("AI Redis TLS subset keys differ")
    for key, encoded in value.items():
        if not isinstance(encoded, str) or not encoded or not hmac.compare_digest(
                hashlib.sha256(encoded.encode("utf-8")).hexdigest(), fingerprints["greenguard-ai-redis"][key]):
            raise ValueError("AI Redis TLS subset differs from expected fingerprints")
    return value


def _openssl(*args: str, input_bytes: bytes | None = None) -> bytes:
    result = subprocess.run(["openssl", *args], input=input_bytes, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError("AI Redis TLS material failed cryptographic validation")
    return result.stdout


def validate_redis_tls(payload: dict) -> None:
    """Validate CA chain, DNS SAN, serverAuth EKU, and the private key match."""
    try:
        cert = base64.b64decode(payload["server.crt"], validate=True)
        key = base64.b64decode(payload["server.key"], validate=True)
        ca = base64.b64decode(payload["ca.pem"], validate=True)
        with tempfile.TemporaryDirectory(prefix="greenguard-ai-tls-") as directory:
            root = Path(directory)
            for name, value in (("server.crt", cert), ("server.key", key), ("ca.pem", ca)):
                (root / name).write_bytes(value)
                (root / name).chmod(0o600)
            _openssl("verify", "-CAfile", str(root / "ca.pem"), "-verify_hostname", "ai-redis.greenguard.svc.cluster.local", str(root / "server.crt"))
            ext = _openssl("x509", "-in", str(root / "server.crt"), "-noout", "-ext", "extendedKeyUsage").decode("ascii", "replace")
            san = _openssl("x509", "-in", str(root / "server.crt"), "-noout", "-ext", "subjectAltName").decode("ascii", "replace")
            if "TLS Web Server Authentication" not in ext or not all(f"DNS:{host}" in san for host in (
                "ai-redis.greenguard.svc.cluster.local", "ai-redis.greenguard.svc", "ai-redis",
            )):
                raise RuntimeError("AI Redis certificate must include serverAuth and the exact service DNS SAN set")
            cert_key = _openssl("x509", "-in", str(root / "server.crt"), "-pubkey", "-noout")
            key_pub = _openssl("pkey", "-in", str(root / "server.key"), "-pubout")
            if not hmac.compare_digest(cert_key, key_pub):
                raise RuntimeError("AI Redis TLS private key does not match its certificate")
    except (KeyError, binascii.Error, ValueError, UnicodeError, OSError):
        raise RuntimeError("AI Redis TLS bundle is malformed") from None


def guard(scope: dict) -> None:
    aws_scope(scope)
    metadata = aws_secret_metadata(scope)
    expected = expected_payload_bundle()
    current = {name: current_secret_data(scope, name) for name in EXPECTED_KEYS}
    present = [name for name, payload in current.items() if payload is not None]
    if present and len(present) != len(EXPECTED_KEYS):
        raise RuntimeError("AI AWS Secret bundle is only partially materialized; refusing mixed first-apply state")
    if present:
        for name in EXPECTED_KEYS:
            wanted, stored = expected[name], current[name]
            if set(wanted) != set(stored) or any(
                not hmac.compare_digest(wanted[key], hashlib.sha256(stored[key].encode("ascii")).hexdigest()) for key in wanted
            ):
                raise RuntimeError("ephemeral AI bundle differs from current exact-cell AWS Secret values; refusing mixed credentials")
    validate_redis_tls(expected_redis_tls(expected))
    print("PASS AI ephemeral Secret bundle matches exact cell ownership; values withheld")


@contextmanager
def temporary_kubeconfig(scope: dict, cluster: dict):
    prior = os.environ.get("KUBECONFIG")
    with tempfile.TemporaryDirectory(prefix="greenguard-ai-kube-") as directory:
        path = Path(directory) / "config"
        config = run(["aws", "eks", "update-kubeconfig", "--region", scope["region"], "--name", scope["cluster"], "--kubeconfig", str(path), "--dry-run"])
        path.write_text(config, encoding="utf-8")
        path.chmod(0o600)
        selected = run_json("kubectl", "--kubeconfig", str(path), "config", "view", "--minify", "--raw", "-o", "json").get("clusters", [])
        if len(selected) != 1 or selected[0].get("cluster", {}).get("server") != cluster.get("endpoint") or selected[0].get("cluster", {}).get("certificate-authority-data") != cluster.get("certificateAuthority", {}).get("data"):
            raise RuntimeError("temporary kubeconfig does not match the selected EKS endpoint and CA")
        os.environ["KUBECONFIG"] = str(path)
        try:
            yield
        finally:
            if prior is None:
                os.environ.pop("KUBECONFIG", None)
            else:
                os.environ["KUBECONFIG"] = prior


def aws_secret_records(scope: dict) -> dict[str, dict]:
    records = {}
    for name, source in sorted(scope["sources"].items()):
        version = scope["versions"].get(name) if "versions" in scope else None
        data = current_secret_data(scope, name, version)
        if data is None:
            raise RuntimeError(f"{name}: required AWSCURRENT Secret version is missing")
        records[name] = {"source": source, "version": version, "data": data}
    return records


def current_k8s_secret(name: str, namespace: str) -> dict | None:
    result = subprocess.run(["kubectl", "get", "secret", name, "-n", namespace, "-o", "json", "--ignore-not-found"], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"{name}: Kubernetes Secret read failed (exit {result.returncode})")
    return json.loads(result.stdout) if result.stdout.strip() else None


def desired_secret(name: str, scope: dict, record: dict, existing: dict | None = None) -> dict:
    metadata = {
        "name": name,
        "namespace": scope["namespace"],
        "labels": {"app.kubernetes.io/managed-by": OWNER, "greenguard.io/cell": scope["cell"]},
        "annotations": {
            SCOPE_ANNOTATION: scope_identity(scope), SOURCE_ANNOTATION: record["source"],
            VERSION_ANNOTATION: record["version"],
        },
    }
    if existing:
        old = existing.get("metadata", {})
        if (existing.get("type") != "Opaque" or old.get("labels", {}).get("app.kubernetes.io/managed-by") != OWNER
                or old.get("labels", {}).get("greenguard.io/cell") != scope["cell"]
                or old.get("annotations", {}).get(SCOPE_ANNOTATION) != scope_identity(scope)
                or old.get("annotations", {}).get(SOURCE_ANNOTATION) != record["source"]):
            raise RuntimeError(f"{name}: refusing to overwrite a foreign or differently scoped Kubernetes Secret")
        metadata["resourceVersion"] = old.get("resourceVersion")
    return {"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": metadata, "data": record["data"]}


def apply_json(operation: str, value: dict) -> None:
    result = subprocess.run(["kubectl", operation, "-f", "-", "-o", "name"], input=json.dumps(value), capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"Kubernetes {operation} failed (exit {result.returncode}); Secret data withheld")


def sync(scope: dict) -> None:
    cluster = aws_scope(scope)
    aws_secret_metadata(scope)
    with temporary_kubeconfig(scope, cluster):
        records = aws_secret_records(scope)
        planned = []
        for name, record in records.items():
            existing = current_k8s_secret(name, scope["namespace"])
            desired = desired_secret(name, scope, record, existing)
            if existing is None or existing.get("type") != "Opaque" or existing.get("data", {}) != record["data"] or any(
                existing.get("metadata", {}).get("annotations", {}).get(key) != value
                for key, value in desired["metadata"]["annotations"].items()
            ):
                planned.append((desired, existing is not None))
        # Read/validate the whole bundle and all existing ownership before the
        # first mutation; no partial sync follows an ownership conflict.
        for desired, replace in planned:
            apply_json("replace" if replace else "create", desired)
    print(f"PASS synchronized {len(EXPECTED_KEYS)} exact-cell AI Secrets; values withheld")


def cleanup(scope: dict) -> None:
    cluster = aws_scope(scope)
    metadata = aws_secret_metadata(scope)
    with temporary_kubeconfig(scope, cluster):
        planned = []
        for name in sorted(EXPECTED_KEYS):
            existing = current_k8s_secret(name, scope["namespace"])
            if existing is None:
                continue
            record = current_secret_data(scope, name, scope["versions"].get(name))
            if record is None:
                raise RuntimeError(f"{name}: AWS current version absent; refusing to delete a Kubernetes Secret")
            secret_meta = existing.get("metadata", {})
            annotations = secret_meta.get("annotations", {})
            labels = secret_meta.get("labels", {})
            if (existing.get("type") != "Opaque" or labels.get("app.kubernetes.io/managed-by") != OWNER
                    or labels.get("greenguard.io/cell") != scope["cell"]
                    or annotations.get(SCOPE_ANNOTATION) != scope_identity(scope)
                    or annotations.get(SOURCE_ANNOTATION) != scope["sources"][name]
                    or annotations.get(VERSION_ANNOTATION) != scope["versions"][name]
                    or existing.get("data", {}) != record):
                raise RuntimeError(f"{name}: refusing to delete a foreign, drifted or rotated Secret")
            if not secret_meta.get("uid") or not secret_meta.get("resourceVersion"):
                raise RuntimeError(f"{name}: deletion requires UID and resourceVersion preconditions")
            planned.append((name, secret_meta))
        for name, meta in planned:
            path = f"/api/v1/namespaces/{scope['namespace']}/secrets/{name}"
            options = {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": meta["uid"], "resourceVersion": meta["resourceVersion"]}}
            run(["kubectl", "delete", "--raw", path, "-f", "-"], payload=json.dumps(options))
    print(f"PASS removed {len(planned)} Terraform-owned AI Secrets; values withheld")


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"guard", "sync", "cleanup"}:
        raise SystemExit("usage: ai-secret-lifecycle.py guard|sync|cleanup")
    scope = scope_from_environment()
    if sys.argv[1] == "guard":
        guard(scope)
    elif sys.argv[1] == "sync":
        sync(scope)
    else:
        cleanup(scope)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Error messages are controlled and never include payload values; don't
        # print exception reprs from AWS/provider SDKs, which may contain URLs.
        print(f"AI_SECRET_LIFECYCLE_FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
