#!/usr/bin/env python3
"""Guarded Secrets Manager -> isolated synthetic-ML Kubernetes Secret sync.

The Terraform inputs and AWS SecretString values contain base64-encoded bytes.
This process keeps payloads in memory/stdin only, never prints them, and only
touches the exact disposable EKS cell and `ml-synthetic` namespace.
"""

from __future__ import annotations

import base64
import binascii
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


OWNER = "greenguard-ml-synthetic-secret-sync"
SCOPE_ANNOTATION = "greenguard.io/terraform-scope"
EXPECTED_NAMES = {
    "ml-synthetic-postgres-auth": {"bootstrap-password", "migrator-password", "runtime-password", "server.crt", "server.key", "ca.crt"},
    "ml-synthetic-kafka-auth": {"admin-password", "scorer-password", "fixture-password", "broker-jaas", "inter-broker-jaas"},
    "ml-synthetic-kafka-tls": {"broker.keystore.p12", "broker.truststore.p12", "keystore-password", "key-password", "truststore-password", "ca.crt"},
    "ml-scoring-runtime": {"database-url", "kafka-username", "kafka-password", "operations-token"},
    "ml-scoring-migrator": {"database-url"},
    "ml-scoring-fixture": {"kafka-username", "kafka-password"},
}


def run(argv: list[str], *, payload: str | None = None, text: bool = True):
    result = subprocess.run(argv, input=payload, capture_output=True, text=text, check=False)
    if result.returncode:
        raise RuntimeError(f"{argv[0]} {argv[1]} failed (exit {result.returncode}); secret data withheld")
    return result.stdout


def run_json(*argv: str):
    return json.loads(run(list(argv)))


def scope_from_environment():
    raw = os.environ.get("GG_ML_SYNTHETIC_SCOPE", "")
    if not raw or len(raw) > 32_000:
        raise ValueError("ML synthetic scope is missing or exceeds its size limit")
    scope = json.loads(raw)
    if set(scope) not in (
        {"account_id", "region", "environment", "cell", "cluster", "namespace", "versions", "sources"},
        {"account_id", "region", "environment", "cell", "cluster", "namespace"},
    ):
        raise ValueError("Unexpected ML synthetic scope contract")
    for key, pattern in {
        "account_id": r"[0-9]{12}",
        "region": r"[a-z]{2}(?:-[a-z]+)+-[0-9]+",
        "environment": r"[a-z][a-z0-9-]{1,15}",
        "cell": r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}",
        "cluster": r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}",
        "namespace": r"ml-synthetic",
    }.items():
        if not isinstance(scope.get(key), str) or not re.fullmatch(pattern, scope[key]):
            raise ValueError("Invalid ML synthetic scope")
    if scope["cell"] != scope["cluster"] or scope["environment"].lower() in {"prod", "production"}:
        raise ValueError("ML synthetic requires a non-production cell identity")
    if "versions" in scope:
        versions = scope["versions"]
        sources = scope["sources"]
        if not isinstance(versions, dict) or set(versions) != set(EXPECTED_NAMES):
            raise ValueError("ML synthetic Secret version names differ from the fixed contract")
        if not isinstance(sources, dict) or set(sources) != set(EXPECTED_NAMES):
            raise ValueError("ML synthetic Secret source names differ from the fixed contract")
        for name in EXPECTED_NAMES:
            if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", str(versions[name])):
                raise ValueError("Invalid ML synthetic Secret version id")
            cell = hashlib.sha256(scope["cluster"].encode("utf-8")).hexdigest()[:16]
            expected = f"greenguard/{scope['environment']}/cell-{cell}/ml-synthetic/{name}"
            if sources[name] != expected:
                raise ValueError("ML synthetic Secret source is outside its exact environment path")
    return scope


def scope_identity(scope):
    return ":".join(scope[key] for key in ("account_id", "region", "environment", "cell", "cluster"))


def aws_scope(scope):
    identity = run_json("aws", "sts", "get-caller-identity", "--output", "json")
    if identity.get("Account") != scope["account_id"]:
        raise RuntimeError("AWS caller account differs from the ML synthetic cell")
    cluster = run_json("aws", "eks", "describe-cluster", "--region", scope["region"], "--name", scope["cluster"], "--output", "json").get("cluster", {})
    arn = f"arn:aws:eks:{scope['region']}:{scope['account_id']}:cluster/{scope['cluster']}"
    tags = cluster.get("tags", {})
    if cluster.get("arn") != arn or any(tags.get(key) != value for key, value in {
        "Environment": scope["environment"], "Lifecycle": "Disposable", "ManagedBy": "Terraform",
    }.items()):
        raise RuntimeError("EKS cluster ARN/tags differ from the disposable ML synthetic scope")
    return cluster


@contextmanager
def make_kubeconfig(scope, cluster):
    previous = os.environ.get("KUBECONFIG")
    with tempfile.TemporaryDirectory(prefix="greenguard-ml-synthetic-kube-") as directory:
        config_path = Path(directory) / "config"
        config = run(["aws", "eks", "update-kubeconfig", "--region", scope["region"], "--name", scope["cluster"],
                      "--kubeconfig", str(config_path), "--dry-run"])
        config_path.write_text(config, encoding="utf-8")
        config_path.chmod(0o600)
        current = run_json("kubectl", "--kubeconfig", str(config_path), "config", "view", "--minify", "--raw", "-o", "json")
        clusters = current.get("clusters", [])
        if len(clusters) != 1:
            raise RuntimeError("Temporary kubeconfig does not contain exactly one cluster")
        selected = clusters[0].get("cluster", {})
        ca_data = cluster.get("certificateAuthority", {}).get("data")
        if selected.get("server") != cluster.get("endpoint") or selected.get("certificate-authority-data") != ca_data:
            raise RuntimeError("Temporary kubeconfig endpoint/CA does not match the selected EKS cell")
        os.environ["KUBECONFIG"] = str(config_path)
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop("KUBECONFIG", None)
            else:
                os.environ["KUBECONFIG"] = previous

def expected_namespace(scope):
    return {
        "apiVersion": "v1", "kind": "Namespace",
        "metadata": {
            "name": "ml-synthetic",
            "labels": {
                "greenguard.io/cell": scope["cell"],
                "greenguard.io/isolation": "synthetic-only",
                "istio-injection": "disabled",
            },
            "annotations": {SCOPE_ANNOTATION: scope_identity(scope)},
        },
    }


def ensure_namespace(scope):
    desired = expected_namespace(scope)
    result = subprocess.run(["kubectl", "get", "namespace", "ml-synthetic", "-o", "json", "--ignore-not-found"],
                           capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"kubectl get namespace failed (exit {result.returncode})")
    existing = json.loads(result.stdout) if result.stdout.strip() else None
    if existing:
        metadata = existing.get("metadata", {})
        labels = metadata.get("labels", {})
        annotations = metadata.get("annotations", {})
        if any(labels.get(key) != value for key, value in desired["metadata"]["labels"].items()) or annotations.get(SCOPE_ANNOTATION) != scope_identity(scope):
            raise RuntimeError("ml-synthetic namespace already exists outside this exact cell/isolation scope")
        return
    apply_json("create", desired)


def secret_payloads(scope):
    payloads = {}
    for name in sorted(EXPECTED_NAMES):
        response = run_json("aws", "secretsmanager", "get-secret-value", "--region", scope["region"],
                            "--secret-id", scope["sources"][name], "--version-stage", "AWSCURRENT", "--output", "json")
        if response.get("Name") != scope["sources"][name] or response.get("VersionId") != scope["versions"][name] or "AWSCURRENT" not in response.get("VersionStages", []):
            raise RuntimeError(f"{name}: AWS Secrets Manager name/current-version differs from Terraform")
        try:
            data = json.loads(response["SecretString"])
        except (KeyError, json.JSONDecodeError):
            raise RuntimeError(f"{name}: AWS secret payload is not a JSON byte map") from None
        if not isinstance(data, dict) or set(data) != EXPECTED_NAMES[name]:
            raise RuntimeError(f"{name}: AWS secret payload keys differ from the fixed Kubernetes contract")
        for key, encoded in data.items():
            if not isinstance(encoded, str) or len(encoded) > 50_000:
                raise RuntimeError(f"{name}: invalid encoded value")
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                raise RuntimeError(f"{name}: value is not canonical base64") from None
            if not raw:
                raise RuntimeError(f"{name}: empty Secret values are forbidden")
            # K8s .data accepts the exact base64 bytes from Secrets Manager.
        payloads[name] = {"source": scope["sources"][name], "version": scope["versions"][name], "data": data}
    return payloads


def expected_payloads_from_environment():
    raw = os.environ.get("GG_ML_SYNTHETIC_EXPECTED_FINGERPRINTS", "")
    if not raw or len(raw) > 32_000:
        raise ValueError("synthetic fingerprint bundle is missing or oversized")
    try:
        payloads = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("synthetic fingerprint bundle is invalid JSON") from None
    if not isinstance(payloads, dict) or set(payloads) != set(EXPECTED_NAMES):
        raise ValueError("synthetic fingerprint names differ from the fixed contract")
    for name, required_keys in EXPECTED_NAMES.items():
        data = payloads[name]
        if not isinstance(data, dict) or set(data) != required_keys:
            raise ValueError(f"{name}: fingerprint keys differ from the fixed contract")
        if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in data.values()):
            raise ValueError("synthetic fingerprint must be SHA256")
    return payloads


def guard_ephemeral_bundle(scope):
    """Compare the current exact-cell AWS bundle with ephemeral inputs in memory."""
    aws_secret_scope(scope)
    expected = expected_payloads_from_environment()
    for name in sorted(EXPECTED_NAMES):
        response = run_json("aws", "secretsmanager", "get-secret-value", "--region", scope["region"],
                            "--secret-id", scope["sources"][name], "--version-id", scope["versions"][name],
                            "--output", "json")
        if (response.get("Name") != scope["sources"][name]
                or response.get("VersionId") != scope["versions"][name]):
            raise RuntimeError(f"{name}: AWS Secret version differs from exact disposable cell scope")
        try:
            current = json.loads(response["SecretString"])
        except (KeyError, json.JSONDecodeError):
            raise RuntimeError(f"{name}: stored AWS Secret is not a valid byte map") from None
        wanted = expected[name]
        if (not isinstance(current, dict) or set(current) != set(wanted)
                or any(not isinstance(current.get(key), str)
                       or not current[key] or len(current[key]) > 50_000
                       or not re.fullmatch(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", current[key])
                       or not hmac.compare_digest(hashlib.sha256(current[key].encode("ascii")).hexdigest(), wanted[key])
                       for key in wanted)):
            raise RuntimeError("ephemeral synthetic bundle differs from the exact cell's stored AWS Secrets; refusing to continue with mixed credentials")
    print("PASS ephemeral synthetic inputs match the current exact-cell AWS Secret versions; payloads withheld")


def current_secret(name):
    result = subprocess.run(["kubectl", "get", "secret", name, "-n", "ml-synthetic", "-o", "json", "--ignore-not-found"],
                           capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"{name}: Kubernetes Secret read failed (exit {result.returncode})")
    return json.loads(result.stdout) if result.stdout.strip() else None


def desired_secret(name, scope, record, existing=None):
    desired = {
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": {
            "name": name, "namespace": "ml-synthetic",
            "labels": {"app.kubernetes.io/managed-by": OWNER, "greenguard.io/cell": scope["cell"]},
            "annotations": {
                SCOPE_ANNOTATION: scope_identity(scope),
                "greenguard.io/aws-secret-name": record["source"],
                "greenguard.io/aws-version-id": record["version"],
            },
        },
        "data": record["data"],
    }
    if existing:
        metadata = existing.get("metadata", {})
        annotations = metadata.get("annotations", {})
        if existing.get("type") != "Opaque" or metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != OWNER or annotations.get(SCOPE_ANNOTATION) != scope_identity(scope) or annotations.get("greenguard.io/aws-secret-name") != record["source"]:
            raise RuntimeError(f"{name}: refusing to replace a foreign Kubernetes Secret")
        desired["metadata"]["resourceVersion"] = metadata.get("resourceVersion")
    return desired


def apply_json(operation, value):
    result = subprocess.run(["kubectl", operation, "-f", "-", "-o", "name"], input=json.dumps(value),
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"kubectl {operation} failed (exit {result.returncode}); secret values withheld")


def sync(scope):
    cluster = aws_scope(scope)
    with make_kubeconfig(scope, cluster):
        payloads = secret_payloads(scope)  # Validate the complete AWS contract before first K8s write.
        ensure_namespace(scope)
        planned = []
        for name, record in payloads.items():
            existing = current_secret(name)
            desired = desired_secret(name, scope, record, existing)
            if existing is None or existing.get("type") != "Opaque" or existing.get("data", {}) != desired["data"] or any(
                existing.get("metadata", {}).get("annotations", {}).get(key) != value
                for key, value in desired["metadata"]["annotations"].items()
            ):
                planned.append((desired, existing is not None))
        for desired, replace in planned:
            apply_json("replace" if replace else "create", desired)
    print(f"PASS synchronized {len(EXPECTED_NAMES)} disposable synthetic Secrets; values withheld")


def aws_secret_scope(scope):
    cluster = aws_scope(scope)
    for name in sorted(EXPECTED_NAMES):
        source = scope["sources"][name]
        secret = run_json("aws", "secretsmanager", "describe-secret", "--region", scope["region"], "--secret-id", source, "--output", "json")
        tags = {row.get("Key"): row.get("Value") for row in secret.get("Tags", [])}
        expected_arn = f"arn:aws:secretsmanager:{scope['region']}:{scope['account_id']}:secret:{source}-"
        if secret.get("Name") != source or not secret.get("ARN", "").startswith(expected_arn) or any(tags.get(key) != value for key, value in {
            "Environment": scope["environment"], "Cell": scope["cell"], "Lifecycle": "Disposable", "ManagedBy": "Terraform",
        }.items()):
            raise RuntimeError(f"{name}: AWS secret account/cell ownership mismatch")
        if scope["versions"][name] not in secret.get("VersionIdsToStages", {}):
            raise RuntimeError(f"{name}: Terraform-owned AWS Secret version is absent")
    return cluster


def delete_owned_secrets(scope, cluster):
    # Validate all current objects before the first delete; no partial teardown
    # may remove a subset if any object has drifted to a different owner.
    planned = []
    for name in sorted(EXPECTED_NAMES):
        current = current_secret(name)
        if not current:
            continue
        metadata = current.get("metadata", {})
        annotations = metadata.get("annotations", {})
        if current.get("type") != "Opaque" or metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != OWNER or metadata.get("labels", {}).get("greenguard.io/cell") != scope["cell"] or annotations.get(SCOPE_ANNOTATION) != scope_identity(scope) or annotations.get("greenguard.io/aws-secret-name") != scope["sources"][name] or annotations.get("greenguard.io/aws-version-id") != scope["versions"][name]:
            raise RuntimeError(f"{name}: refusing to delete a foreign or rotated Kubernetes Secret")
        if not metadata.get("uid") or not metadata.get("resourceVersion"):
            raise RuntimeError(f"{name}: delete requires UID/resourceVersion")
        planned.append((name, metadata))
    for name, metadata in planned:
        path = f"/api/v1/namespaces/ml-synthetic/secrets/{name}"
        options = {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"]}}
        run(["kubectl", "delete", "--raw", path, "-f", "-"], payload=json.dumps(options))
    print(f"PASS removed {len(planned)} Terraform-owned synthetic Secrets; namespace retained")


def cleanup(scope):
    cluster = aws_secret_scope(scope)
    with make_kubeconfig(scope, cluster):
        namespace = subprocess.run(["kubectl", "get", "namespace", "ml-synthetic", "-o", "json", "--ignore-not-found"], capture_output=True, text=True, check=False)
        if namespace.returncode:
            raise RuntimeError("Could not inspect synthetic namespace before Secret cleanup")
        if not namespace.stdout.strip():
            print("PASS synthetic namespace already absent; owned Secrets were removed with its namespace")
            return
        delete_owned_secrets(scope, cluster)


def allowed_namespace_bootstrap(item, cluster_ca):
    """Recognize only exact controller-owned Kubernetes namespace defaults."""
    kind = item.get("kind")
    metadata = item.get("metadata", {})
    name = metadata.get("name")
    managers = {row.get("manager") for row in metadata.get("managedFields", []) if isinstance(row, dict)}
    labels = metadata.get("labels", {})
    controller_managed = bool(managers) and managers <= {
        "kube-controller-manager", "root-ca-cert-publisher", "service-account-controller",
    }
    default_labels = ({}, {"kubernetes.io/metadata.name": "ml-synthetic"})
    if kind == "ConfigMap" and name == "kube-root-ca.crt":
        annotations = metadata.get("annotations", {})
        return (controller_managed and item.get("data") == {"ca.crt": cluster_ca}
                and not item.get("binaryData") and labels in default_labels
                and set(annotations) <= {"kubernetes.io/description"}
                and not metadata.get("ownerReferences") and not metadata.get("finalizers"))
    if kind == "ServiceAccount" and name == "default":
        return (controller_managed and not item.get("secrets") and not item.get("imagePullSecrets")
                and item.get("automountServiceAccountToken") is None
                and labels in default_labels and not metadata.get("annotations")
                and not metadata.get("ownerReferences") and not metadata.get("finalizers"))
    return False


def namespace_inventory():
    return run_json("kubectl", "get", "all,pvc,configmap,secret,serviceaccount,role,rolebinding,networkpolicy,ingress,resourcequota,limitrange",
                    "-n", "ml-synthetic", "-o", "json", "--show-managed-fields=true")


def namespace_destroy(scope):
    cluster = aws_scope(scope)
    with make_kubeconfig(scope, cluster):
        result = subprocess.run(["kubectl", "get", "namespace", "ml-synthetic", "-o", "json", "--ignore-not-found"], capture_output=True, text=True, check=False)
        if result.returncode:
            raise RuntimeError("Could not inspect synthetic namespace before teardown")
        if not result.stdout.strip():
            print("PASS synthetic namespace already absent")
            return
        namespace = json.loads(result.stdout)
        metadata = namespace.get("metadata", {})
        if metadata.get("labels", {}).get("greenguard.io/cell") != scope["cell"] or metadata.get("labels", {}).get("greenguard.io/isolation") != "synthetic-only" or metadata.get("labels", {}).get("istio-injection") != "disabled" or metadata.get("annotations", {}).get(SCOPE_ANNOTATION) != scope_identity(scope):
            raise RuntimeError("Refusing to remove a namespace outside the exact cell/synthetic-only scope")
        aws_secret_scope(scope)
        # Remove the two child Applications gracefully while Argo is still
        # available. Their resources-finalizer performs a normal prune; this
        # script never strips a finalizer or deletes an unowned application.
        for app_name in ("greenguard-ml-synthetic-scorer", "greenguard-ml-synthetic-data"):
            app_result = subprocess.run(["kubectl", "get", "application.argoproj.io", app_name, "-n", "argocd", "-o", "json", "--ignore-not-found"], capture_output=True, text=True, check=False)
            if app_result.returncode:
                raise RuntimeError("Could not inspect the scoped synthetic Argo Application before teardown")
            if not app_result.stdout.strip():
                continue
            app = json.loads(app_result.stdout)
            app_meta = app.get("metadata", {})
            if app_meta.get("labels", {}).get("greenguard.io/cell") != scope["cell"] or app.get("spec", {}).get("destination", {}).get("namespace") != "ml-synthetic":
                raise RuntimeError(f"Refusing to delete foreign Argo Application {app_name}")
            run(["kubectl", "delete", "application.argoproj.io", app_name, "-n", "argocd", "--wait=true", "--timeout=600s"])
        # Namespace cleanup runs before the separate Secret cleanup resource
        # on destroy. Verify exact AWS versions and delete only our six Secrets
        # here so they do not block the namespace inventory/cascade.
        delete_owned_secrets(scope, cluster)
        # Argo may leave the normal namespace bootstrap objects behind. All
        # workload resources, PVCs and unknown objects must be gone before
        # Terraform requests namespace deletion.
        listing = namespace_inventory()
        remaining = []
        cluster_ca = base64.b64decode(cluster.get("certificateAuthority", {}).get("data", ""), validate=True).decode("ascii")
        for item in listing.get("items", []):
            # Ignore only byte-exact, controller-managed namespace bootstrap
            # objects. User-applied fields/managers or metadata fail closed.
            if allowed_namespace_bootstrap(item, cluster_ca):
                continue
            remaining.append(item)
        if remaining:
            kinds = sorted({f"{item.get('kind', 'unknown')}/{item.get('metadata', {}).get('name', '?')}" for item in remaining})
            raise RuntimeError("Refusing namespace deletion; resources/PVCs remain after Argo prune: " + ", ".join(kinds))
        if not metadata.get("uid") or not metadata.get("resourceVersion"):
            raise RuntimeError("Namespace teardown requires UID/resourceVersion")
        pvs = run_json("kubectl", "get", "persistentvolumes", "-o", "json").get("items", [])
        volume_handles = {
            pv.get("spec", {}).get("csi", {}).get("volumeHandle")
            for pv in pvs
            if pv.get("spec", {}).get("claimRef", {}).get("namespace") == "ml-synthetic"
            and pv.get("spec", {}).get("csi", {}).get("driver") == "ebs.csi.aws.com"
        }
        options = {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"]}}
        run(["kubectl", "delete", "--raw", "/api/v1/namespaces/ml-synthetic", "-f", "-"], payload=json.dumps(options))
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            current = subprocess.run(["kubectl", "get", "namespace", "ml-synthetic", "-o", "json", "--ignore-not-found"], capture_output=True, text=True, check=False)
            if current.returncode:
                raise RuntimeError("Could not verify synthetic namespace/PVC teardown")
            if not current.stdout.strip():
                remaining_pvs = run_json("kubectl", "get", "persistentvolumes", "-o", "json").get("items", [])
                remaining_handles = {
                    pv.get("spec", {}).get("csi", {}).get("volumeHandle")
                    for pv in remaining_pvs
                    if pv.get("spec", {}).get("csi", {}).get("driver") == "ebs.csi.aws.com"
                }
                if volume_handles.intersection(remaining_handles):
                    time.sleep(5)
                    continue
                print("PASS deleted Terraform-owned ml-synthetic namespace; PVC/PV finalizers completed")
                return
            time.sleep(5)
        raise RuntimeError("Timed out waiting for ml-synthetic namespace and its PVC/PV cleanup; no finalizers were removed")


def main():
    if sys.argv[1:] not in (["apply"], ["guard"], ["cleanup"], ["namespace-destroy"]):
        raise ValueError("Expected apply, guard, cleanup, or namespace-destroy")
    scope = scope_from_environment()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    {"apply": sync, "guard": guard_ephemeral_bundle, "cleanup": cleanup, "namespace-destroy": namespace_destroy}[sys.argv[1]](scope)


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
