#!/usr/bin/env python3
"""Terraform local-exec adapter for the exact-cell, read-only workload gate."""
import json
import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("deployed_workload_gate", BASE / "check-deployed-workloads.py")
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


def run(cell, release, timeout=900, command=subprocess.run):
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 1800:
        raise ValueError("readiness timeout must be between 1 and 1800 seconds")
    # Reuse the complete gate contract before AWS CLI discovery or kubeconfig creation.
    try:
        contract = json.loads((BASE / "contract.json").read_text())
        GATE.inputs(cell, release, contract)
    except (TypeError, KeyError) as error:
        raise ValueError("invalid cell or release scope") from error
    with tempfile.TemporaryDirectory(prefix="greenguard-acceptance-") as temporary:
        directory = Path(temporary)
        cell_path = directory / "cell-identity.json"
        release_path = directory / "release-inputs.json"
        kubeconfig_path = directory / "kubeconfig"
        cell_path.write_text(json.dumps(cell))
        release_path.write_text(json.dumps(release))
        cell_path.chmod(0o600)
        release_path.chmod(0o600)
        completed = command([
            "aws", "eks", "update-kubeconfig", "--region", cell["region"],
            "--name", cell["cluster_name"], "--kubeconfig", str(kubeconfig_path),
        ], capture_output=True, text=True, timeout=60, check=False)
        if completed.returncode != 0 or not kubeconfig_path.is_file():
            raise ValueError("temporary kubeconfig could not be created for this EKS cell")
        kubeconfig_path.chmod(0o600)
        return command([
            sys.executable, str(BASE / "check-deployed-workloads.py"),
            str(cell_path), str(release_path), str(kubeconfig_path),
            "--timeout", str(timeout),
        ], check=False, timeout=timeout + 120).returncode


def main():
    try:
        cell = json.loads(os.environ["GG_DISPOSABLE_CELL_IDENTITY"])
        release = json.loads(os.environ["GG_DISPOSABLE_RELEASE_INPUTS"])
        result = run(cell, release)
        return result
    except (KeyError, json.JSONDecodeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"BLOCKED: post-deployment health check failed ({type(error).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
