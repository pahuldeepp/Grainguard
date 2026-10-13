#!/usr/bin/env python3
"""Fail before Terraform's first Helm mutation if its runner cannot use EKS."""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def run(command, *, timeout, capture_output=True, text=True, check=False, env=None):
    return subprocess.run(command, timeout=timeout, capture_output=capture_output,
                          text=text, check=check, env=env)


def validate_inputs(account, region, environment, cluster):
    if not re.fullmatch(r"[0-9]{12}", account):
        raise ValueError("invalid disposable AWS account")
    if not re.fullmatch(r"[a-z]{2}-[a-z]+-[0-9]+", region):
        raise ValueError("invalid AWS region")
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,15}", environment) or environment.lower() in {"prod", "production"}:
        raise ValueError("invalid or production environment")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", cluster):
        raise ValueError("invalid EKS cluster name")


def check(account, region, environment, cluster, command=run):
    validate_inputs(account, region, environment, cluster)
    base_env = dict(os.environ, AWS_REGION=region, AWS_DEFAULT_REGION=region, AWS_PAGER="")
    identity = command(["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"],
                       timeout=30, env=base_env)
    if identity.returncode != 0 or identity.stdout.strip() != account:
        raise ValueError("AWS caller account does not match the disposable cell")

    describe = command(["aws", "eks", "describe-cluster", "--region", region,
                        "--name", cluster, "--query",
                        "cluster.{arn:arn,status:status,endpoint:endpoint}", "--output", "json"],
                       timeout=45, env=base_env)
    if describe.returncode != 0:
        raise ValueError("EKS cluster could not be described")
    try:
        info = json.loads(describe.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("EKS cluster description is invalid") from error
    expected_arn = f"arn:aws:eks:{region}:{account}:cluster/{cluster}"
    if (not isinstance(info, dict) or info.get("arn") != expected_arn
            or info.get("status") != "ACTIVE"
            or not isinstance(info.get("endpoint"), str)
            or not info["endpoint"].startswith("https://")):
        raise ValueError("EKS cluster identity or status does not match the disposable cell")

    with tempfile.TemporaryDirectory(prefix="greenguard-eks-api-") as temporary:
        kubeconfig = Path(temporary) / "config"
        created = command(["aws", "eks", "update-kubeconfig", "--region", region,
                           "--name", cluster, "--kubeconfig", str(kubeconfig)],
                          timeout=60, env=base_env)
        if created.returncode != 0 or not kubeconfig.is_file():
            raise ValueError("temporary EKS kubeconfig could not be created")
        kubeconfig.chmod(0o600)
        raw = ["kubectl", "--kubeconfig", str(kubeconfig), "--request-timeout=20s", "get", "--raw=/readyz"]
        ready = command(raw, timeout=30, env=base_env)
        if ready.returncode != 0 or ready.stdout.strip() != "ok":
            raise ValueError("EKS API is not reachable and ready from this Terraform runner")
        auth = command(["kubectl", "--kubeconfig", str(kubeconfig), "--request-timeout=20s",
                        "auth", "can-i", "get", "pods", "--namespace", "kube-system"],
                       timeout=30, env=base_env)
        if auth.returncode != 0 or auth.stdout.strip() != "yes":
            raise ValueError("Terraform runner lacks Kubernetes read access")


def main():
    try:
        check(os.environ["GG_EKS_ACCOUNT_ID"], os.environ["GG_EKS_REGION"],
              os.environ["GG_EKS_ENVIRONMENT"], os.environ["GG_EKS_CLUSTER_NAME"])
        print("EKS API reachability and read authorization verified")
        return 0
    except (KeyError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"BLOCKED: EKS API preflight failed ({type(error).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
