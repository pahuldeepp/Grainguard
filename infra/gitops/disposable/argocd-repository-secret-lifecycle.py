#!/usr/bin/env python3
"""Synchronize one repo-scoped SSH deploy key into Argo CD without logging it."""

import base64
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from contextlib import contextmanager

OWNER = "greenguard-argocd-repository-sync"
SECRET = "greenguard-gitops-repository"
NAMESPACE = "argocd"
REPO_URL = "ssh://git@github.com/pahuldeepp/Grainguard.git"


def run(args, *, input_text=None):
    result = subprocess.run(args, input=input_text, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} failed (exit {result.returncode})")
    return result.stdout


def scope_from_environment():
    scope = json.loads(os.environ["GG_ARGOCD_REPOSITORY_SCOPE"])
    expected = {"account_id", "region", "environment", "cluster", "repository", "secret_arn", "secret_name", "secret_version"}
    if not isinstance(scope, dict) or set(scope) != expected:
        raise ValueError("Unexpected private-repository Secret scope")
    patterns = {
        "account_id": r"[0-9]{12}",
        "region": r"[a-z]{2}(?:-[a-z]+)+-[0-9]+",
        "environment": r"[a-z][a-z0-9-]{1,15}",
        "cluster": r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}",
        "secret_version": r"[A-Za-z0-9-]{1,64}",
    }
    if any(not isinstance(scope[key], str) or not re.fullmatch(pattern, scope[key]) for key, pattern in patterns.items()):
        raise ValueError("Invalid private-repository Secret scope")
    if scope["environment"] in {"prod", "production"}:
        raise ValueError("GitOps key lifecycle is restricted to disposable environments")
    expected_name = f"greenguard/{scope['environment']}/argocd-repository"
    if scope["repository"] != REPO_URL or scope["secret_name"] != expected_name:
        raise ValueError("Repository URL or Secret name is outside the fixed GreenGuard contract")
    arn = f"arn:aws:secretsmanager:{scope['region']}:{scope['account_id']}:secret:{expected_name}"
    if not isinstance(scope["secret_arn"], str) or not scope["secret_arn"].startswith(arn):
        raise ValueError("Repository Secret ARN is outside the disposable AWS cell")
    return scope


def verify_scope(scope):
    account = json.loads(run(["aws", "sts", "get-caller-identity", "--output", "json"]))["Account"]
    if account != scope["account_id"]:
        raise RuntimeError("AWS account differs from selected disposable cell")
    cluster = json.loads(run(["aws", "eks", "describe-cluster", "--region", scope["region"], "--name", scope["cluster"], "--output", "json"]))["cluster"]
    if cluster.get("arn") != f"arn:aws:eks:{scope['region']}:{scope['account_id']}:cluster/{scope['cluster']}" or cluster.get("tags", {}).get("Environment") != scope["environment"] or cluster.get("tags", {}).get("Lifecycle") != "Disposable":
        raise RuntimeError("EKS cluster is not the exact Terraform-owned disposable cell")
    kubeconfig = json.loads(run(["kubectl", "config", "view", "--minify", "-o", "json"]))
    servers = [entry["cluster"]["server"] for entry in kubeconfig.get("clusters", [])]
    if servers != [cluster["endpoint"]]:
        raise RuntimeError("kubectl context does not target the selected EKS cluster")


@contextmanager
def temporary_kubeconfig(scope):
    """Build and remove an exact-cell kubeconfig without touching user config."""
    previous = os.environ.get("KUBECONFIG")
    try:
        with tempfile.TemporaryDirectory(prefix="gg-argocd-sync-") as directory:
            path = Path(directory) / "kubeconfig"
            config = run([
                "aws", "eks", "update-kubeconfig", "--region", scope["region"],
                "--name", scope["cluster"], "--kubeconfig", str(path), "--dry-run",
            ])
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
            with os.fdopen(descriptor, "w") as handle:
                handle.write(config)
            os.chmod(path, 0o600)
            os.environ["KUBECONFIG"] = str(path)
            yield
    finally:
        if previous is None:
            os.environ.pop("KUBECONFIG", None)
        else:
            os.environ["KUBECONFIG"] = previous


def fetch_key(scope):
    response = json.loads(run([
        "aws", "secretsmanager", "get-secret-value", "--region", scope["region"],
        "--secret-id", scope["secret_arn"], "--version-id", scope["secret_version"], "--output", "json",
    ]))
    if response.get("Name") != scope["secret_name"] or response.get("VersionId") != scope["secret_version"]:
        raise RuntimeError("Private-repository Secret name/version differs from Terraform")
    payload = json.loads(response["SecretString"])
    if not isinstance(payload, dict) or set(payload) != {"SSH_PRIVATE_KEY"}:
        raise RuntimeError("Private-repository Secret payload has an unexpected contract")
    key = payload["SSH_PRIVATE_KEY"]
    if not isinstance(key, str) or not key.startswith("-----BEGIN OPENSSH PRIVATE KEY-----\n"):
        raise RuntimeError("Private-repository Secret must contain an OpenSSH private key")
    # Validate key type without printing or persisting it beyond a mode-0600
    # temporary file. `ssh-keygen -y` writes only the public half to captured RAM.
    with tempfile.TemporaryDirectory(prefix="gg-argocd-key-") as directory:
        path = Path(directory) / "deploy-key"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(key)
        public = run(["ssh-keygen", "-y", "-P", "", "-f", str(path)]).strip().split()
    if len(public) < 2 or public[0] != "ssh-ed25519":
        raise RuntimeError("Private-repository key must be Ed25519")
    return key


def existing_secret():
    output = run(["kubectl", "get", "secret", SECRET, "-n", NAMESPACE, "-o", "json", "--ignore-not-found"])
    return json.loads(output) if output.strip() else None


def desired_secret(scope, key, current=None):
    metadata = {
        "name": SECRET,
        "namespace": NAMESPACE,
        "labels": {
            "app.kubernetes.io/managed-by": OWNER,
            "argocd.argoproj.io/secret-type": "repository",
            "greenguard.io/cell": scope["cluster"],
        },
        "annotations": {
            "greenguard.io/aws-secret-name": scope["secret_name"],
            "greenguard.io/aws-version-id": scope["secret_version"],
            "greenguard.io/repository-url": scope["repository"],
        },
    }
    if current:
        current_meta = current.get("metadata", {})
        if current.get("type") != "Opaque" or current_meta.get("labels", {}).get("app.kubernetes.io/managed-by") != OWNER:
            raise RuntimeError("Refusing to replace an unowned Argo repository Secret")
        if current_meta.get("annotations", {}).get("greenguard.io/aws-secret-name") != scope["secret_name"]:
            raise RuntimeError("Argo repository Secret belongs to another AWS source")
        metadata["resourceVersion"] = current_meta.get("resourceVersion", "")
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "type": "Opaque",
        "metadata": metadata,
        "stringData": {"type": "git", "url": scope["repository"], "sshPrivateKey": key},
    }


def same_secret(current, desired):
    if not current or current.get("type") != "Opaque":
        return False
    data = current.get("data", {})
    expected = {name: base64.b64encode(value.encode()).decode() for name, value in desired["stringData"].items()}
    metadata = current.get("metadata", {})
    return data == expected and all(metadata.get("labels", {}).get(k) == v for k, v in desired["metadata"]["labels"].items()) and all(metadata.get("annotations", {}).get(k) == v for k, v in desired["metadata"]["annotations"].items())


def apply(scope):
    key = fetch_key(scope)
    current = existing_secret()
    desired = desired_secret(scope, key, current)
    if not same_secret(current, desired):
        operation = "replace" if current else "create"
        run(["kubectl", operation, "-f", "-", "-o", "name"], input_text=json.dumps(desired))
    print("PASS synchronized the repo-scoped read-only GitOps key; credential withheld")


def destroy(scope):
    current = existing_secret()
    if not current:
        print("PASS no Terraform-owned Argo repository Secret remains")
        return
    metadata = current.get("metadata", {})
    if current.get("type") != "Opaque" or metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != OWNER or metadata.get("annotations", {}).get("greenguard.io/aws-secret-name") != scope["secret_name"] or metadata.get("annotations", {}).get("greenguard.io/aws-version-id") != scope["secret_version"] or metadata.get("annotations", {}).get("greenguard.io/repository-url") != scope["repository"]:
        raise RuntimeError("Refusing to delete a foreign, manually rotated, or changed Argo repository Secret")
    if not metadata.get("uid") or not metadata.get("resourceVersion"):
        raise RuntimeError("Argo repository Secret lacks UID/resourceVersion delete guards")
    options = {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"]}}
    run(["kubectl", "delete", "--raw", f"/api/v1/namespaces/{NAMESPACE}/secrets/{SECRET}", "-f", "-"], input_text=json.dumps(options))
    print("PASS removed the Terraform-owned Argo repository Secret; credential withheld")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"apply", "destroy"}:
        raise ValueError("usage: argocd-repository-secret-lifecycle.py apply|destroy")
    scope = scope_from_environment()
    with temporary_kubeconfig(scope):
        verify_scope(scope)
        apply(scope) if sys.argv[1] == "apply" else destroy(scope)


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
