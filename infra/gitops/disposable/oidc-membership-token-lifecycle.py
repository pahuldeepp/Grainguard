#!/usr/bin/env python3
"""Provision a one-time verified-OIDC token for live membership acceptance.

The token is read from stdin (never argv or environment), delivered to a
Kubernetes Secret over stdin, and never printed. Cleanup is allowed only after
the exact disposable cell/revision's membership Job has succeeded.
"""

import base64
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

OWNER = "greenguard-oidc-membership-acceptance"
SECRET = "greenguard-acceptance-oidc-token"
NAMESPACE = "greenguard"
PROBE = "tenant-membership-readback"


def run(args, *, input_text=None):
    result = subprocess.run(args, input=input_text, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} failed (exit {result.returncode})")
    return result.stdout


def get_scope():
    scope = json.loads(os.environ["GG_OIDC_MEMBERSHIP_SCOPE"])
    expected = {"account_id", "region", "environment", "cluster", "revision"}
    if not isinstance(scope, dict) or set(scope) != expected:
        raise ValueError("Unexpected OIDC membership acceptance scope")
    patterns = {
        "account_id": r"[0-9]{12}",
        "region": r"[a-z]{2}(?:-[a-z]+)+-[0-9]+",
        "environment": r"[a-z][a-z0-9-]{1,15}",
        "cluster": r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}",
        "revision": r"[a-f0-9]{40}",
    }
    if any(not isinstance(scope[key], str) or not re.fullmatch(pattern, scope[key]) for key, pattern in patterns.items()):
        raise ValueError("Invalid OIDC membership acceptance scope")
    if scope["environment"] in {"prod", "production"}:
        raise ValueError("OIDC membership acceptance is restricted to disposable environments")
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
    previous = os.environ.get("KUBECONFIG")
    try:
        with tempfile.TemporaryDirectory(prefix="gg-oidc-acceptance-") as directory:
            path = Path(directory) / "kubeconfig"
            config = run(["aws", "eks", "update-kubeconfig", "--region", scope["region"], "--name", scope["cluster"], "--kubeconfig", str(path), "--dry-run"])
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


def parse_token(token):
    token = token.strip()
    parts = token.split(".")
    if len(parts) != 3 or len(token) > 16384:
        raise ValueError("Expected a short-lived OIDC JWT on stdin")
    try:
        header = json.loads(base64.urlsafe_b64decode(parts[0] + "=="))
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=="))
    except (ValueError, json.JSONDecodeError) as error:
        raise ValueError("OIDC token header or claims are malformed") from error
    # Cryptographic signature, issuer, audience and time validation are done
    # again by the in-cluster probe against Dex JWKS before deriving sub.
    if header.get("alg") != "RS256" or not isinstance(claims.get("exp"), int) or claims["exp"] <= int(time.time()):
        raise ValueError("Supply a non-expired RS256 access token from managed Dex")
    return token, claims["exp"]


def existing_secret():
    output = run(["kubectl", "get", "secret", SECRET, "-n", NAMESPACE, "-o", "json", "--ignore-not-found"])
    return json.loads(output) if output.strip() else None


def provision(scope, token, expiration):
    current = existing_secret()
    if current:
        metadata = current.get("metadata", {})
        if current.get("type") != "Opaque" or metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != OWNER or metadata.get("annotations", {}).get("greenguard.io/cell") != scope["cluster"] or metadata.get("annotations", {}).get("greenguard.io/revision") != scope["revision"]:
            raise RuntimeError("Refusing to replace an unowned or differently scoped acceptance token Secret")
        raise RuntimeError("A scoped token Secret already exists; run the acceptance probe or discard that owned Secret first")
    secret = {
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": {
            "name": SECRET, "namespace": NAMESPACE,
            "labels": {"app.kubernetes.io/managed-by": OWNER, "greenguard.io/cell": scope["cluster"]},
            "annotations": {"greenguard.io/revision": scope["revision"], "greenguard.io/token-exp": str(expiration)},
        },
        "stringData": {"access-token": token},
    }
    run(["kubectl", "create", "-f", "-", "-o", "name"], input_text=json.dumps(secret))
    print("PASS created the short-lived operator-token Secret; token withheld")


def membership_jobs(scope):
    output = run(["kubectl", "get", "jobs", "-n", NAMESPACE, "-l", f"greenguard.io/cell={scope['cluster']},greenguard.io/acceptance-probe={PROBE},greenguard.io/acceptance-revision={scope['revision']}", "-o", "json"])
    return json.loads(output).get("items", [])


def require_successful_probe(scope):
    jobs = membership_jobs(scope)
    if len(jobs) != 1:
        raise RuntimeError("Expected exactly one membership acceptance Job for this cell and revision")
    job = jobs[0]
    if job.get("status", {}).get("succeeded") != 1 or job.get("status", {}).get("failed", 0) > 0:
        raise RuntimeError("Membership acceptance Job has not succeeded; token Secret retained for investigation")


def delete_secret(scope, *, require_probe_success):
    current = existing_secret()
    if not current:
        print("PASS no OIDC acceptance token Secret remains")
        return
    metadata = current.get("metadata", {})
    if current.get("type") != "Opaque" or metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != OWNER or metadata.get("labels", {}).get("greenguard.io/cell") != scope["cluster"] or metadata.get("annotations", {}).get("greenguard.io/revision") != scope["revision"]:
        raise RuntimeError("Refusing to delete a foreign or differently scoped OIDC acceptance token Secret")
    expiration = metadata.get("annotations", {}).get("greenguard.io/token-exp", "")
    if not expiration.isdigit():
        raise RuntimeError("Acceptance token Secret lacks a valid expiry marker")
    if require_probe_success:
        require_successful_probe(scope)
    if not metadata.get("uid") or not metadata.get("resourceVersion"):
        raise RuntimeError("OIDC acceptance token Secret lacks UID/resourceVersion delete guards")
    options = {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"]}}
    run(["kubectl", "delete", "--raw", f"/api/v1/namespaces/{NAMESPACE}/secrets/{SECRET}", "-f", "-"], input_text=json.dumps(options))
    print("PASS removed the scoped one-time OIDC token Secret; token withheld")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"provision", "cleanup", "discard"}:
        raise ValueError("usage: oidc-membership-token-lifecycle.py provision|cleanup|discard")
    scope = get_scope()
    with temporary_kubeconfig(scope):
        verify_scope(scope)
        if sys.argv[1] == "provision":
            token, expiration = parse_token(sys.stdin.read())
            provision(scope, token, expiration)
        else:
            delete_secret(scope, require_probe_success=sys.argv[1] == "cleanup")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
