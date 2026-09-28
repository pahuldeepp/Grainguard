#!/usr/bin/env python3
"""Guarded one-shot AWS Secrets Manager to Kubernetes Secret synchronization."""

import argparse
import base64
import importlib.util
import json
import subprocess
import sys
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("secret_preflight", Path(__file__).with_name("check-secrets-ready.py"))
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)
OWNER = "greenguard-disposable-secret-sync"


def existing_secret(name, namespace):
    result = subprocess.run(
        ["kubectl", "get", "secret", name, "-n", namespace, "-o", "json", "--ignore-not-found"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"{name}: Kubernetes read failed (exit {result.returncode})")
    return json.loads(result.stdout) if result.stdout.strip() else None


def desired_secret(name, namespace, record, existing):
    annotations = {
        "greenguard.io/aws-secret-name": record["source"],
        "greenguard.io/aws-version-id": record["version"],
    }
    if record["master_version"]:
        annotations["greenguard.io/rds-master-version-id"] = record["master_version"]
    metadata = {
        "name": name,
        "namespace": namespace,
        "labels": {"app.kubernetes.io/managed-by": OWNER},
        "annotations": annotations,
    }
    if existing:
        if existing.get("type") != "Opaque":
            raise RuntimeError(f"{name}: refusing to replace a non-Opaque Secret")
        if existing.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/managed-by") != OWNER:
            raise RuntimeError(f"{name}: refusing to replace an unowned Secret")
        if existing.get("metadata", {}).get("annotations", {}).get("greenguard.io/aws-secret-name") != record["source"]:
            raise RuntimeError(f"{name}: source annotation differs from expected AWS secret")
        metadata["resourceVersion"] = existing["metadata"]["resourceVersion"]
    desired = {"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": metadata}
    if name == "greenguard-kafka-auth":
        desired["data"] = {key: base64.b64encode(value).decode("ascii")
                           for key, value in preflight.secret_bytes(name, record["data"]).items()}
    else:
        desired["stringData"] = record["data"]
    return desired


def same_secret(existing, desired):
    if existing is None or existing.get("type") != "Opaque":
        return False
    metadata = existing.get("metadata", {})
    if any(metadata.get("annotations", {}).get(key) != value
           for key, value in desired["metadata"]["annotations"].items()):
        return False
    encoded = desired.get("data") or {key: base64.b64encode(value.encode("utf-8")).decode("ascii")
                                      for key, value in desired["stringData"].items()}
    return existing.get("data", {}) == encoded


def write_secret(desired, replace):
    operation = "replace" if replace else "create"
    result = subprocess.run(
        ["kubectl", operation, "-f", "-", "-o", "name"],
        input=json.dumps(desired), capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"{desired['metadata']['name']}: Kubernetes {operation} failed (exit {result.returncode})")


def main():
    # Parse the same scope flags as the preflight; --apply is the sole mutation switch.
    apply = "--apply" in sys.argv[1:]
    if apply:
        sys.argv = [arg for arg in sys.argv if arg != "--apply"]
    args = preflight.arguments()
    expected = preflight.expected_secrets(args)
    planned = []
    for name, record in expected.items():
        current = existing_secret(name, args.namespace)
        desired = desired_secret(name, args.namespace, record, current)
        if not same_secret(current, desired):
            planned.append((desired, current is not None))
    if not apply:
        print(f"PLAN {len(planned)} Secret create/replace operations; use --apply to sync; values withheld")
        return 1 if planned else preflight.verify_targets(expected, args.namespace)
    for desired, replace in planned:
        write_secret(desired, replace)
    return preflight.verify_targets(expected, args.namespace)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
