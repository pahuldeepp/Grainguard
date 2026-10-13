#!/usr/bin/env python3
"""Terraform adapter for bounded public-edge acceptance retries."""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("public_edge_gate", BASE / "check-public-edge.py")
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)
ATTEMPT_TIMEOUT_SECONDS = 120


def run(cell, target_group_arn, dashboard_url, api_url, dashboard_distribution_id,
        api_distribution_id, timeout=600, interval=15, command=subprocess.run,
        sleep=time.sleep, monotonic=time.monotonic):
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 600:
        raise ValueError("public edge acceptance timeout must be between 1 and 600 seconds")
    if not isinstance(interval, int) or isinstance(interval, bool) or not 1 <= interval <= 60:
        raise ValueError("public edge acceptance retry interval must be between 1 and 60 seconds")
    # Reject malformed/foreign inputs before invoking any AWS command.
    GATE.validate_scope(cell, target_group_arn)
    GATE.validate_public_url(dashboard_url, "dashboard")
    GATE.validate_public_url(api_url, "api")
    if not dashboard_distribution_id or not api_distribution_id:
        raise ValueError("both cell CloudFront distribution IDs are required")

    with tempfile.TemporaryDirectory(prefix="greenguard-public-edge-") as temporary:
        cell_path = Path(temporary) / "cell.json"
        cell_path.write_text(json.dumps(cell))
        cell_path.chmod(0o600)
        deadline = monotonic() + timeout
        last_transient = "edge is not ready yet"
        while True:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise ValueError(f"public edge acceptance timed out: {last_transient}")
            try:
                result = command([
                    sys.executable, str(BASE / "check-public-edge.py"),
                    "--cell-file", str(cell_path), "--target-group-arn", target_group_arn,
                    "--dashboard-url", dashboard_url, "--api-url", api_url,
                    "--dashboard-distribution-id", dashboard_distribution_id,
                    "--api-distribution-id", api_distribution_id,
                ], capture_output=True, text=True,
                   timeout=min(ATTEMPT_TIMEOUT_SECONDS, max(1, int(remaining))), check=False)
            except subprocess.TimeoutExpired:
                last_transient = "bounded public-edge probe attempt timed out"
                result = None
            if result is not None:
                if result.returncode == 0:
                    return 0
                message = (result.stderr or "").strip().splitlines()
                safe_detail = message[0] if message and message[0].startswith("BLOCKED:") else "public-edge probe did not pass"
                if result.returncode != 2:
                    raise ValueError(safe_detail)
                last_transient = safe_detail.removeprefix("BLOCKED: ").strip()
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise ValueError(f"public edge acceptance timed out: {last_transient}")
            sleep(min(interval, remaining))


def main() -> int:
    try:
        cell = json.loads(os.environ["GG_PUBLIC_EDGE_CELL_IDENTITY"])
        target_group_arn = os.environ["GG_PUBLIC_EDGE_TARGET_GROUP_ARN"]
        dashboard_url = os.environ["GG_PUBLIC_EDGE_DASHBOARD_URL"]
        api_url = os.environ["GG_PUBLIC_EDGE_API_URL"]
        dashboard_id = os.environ["GG_PUBLIC_EDGE_DASHBOARD_DISTRIBUTION_ID"]
        api_id = os.environ["GG_PUBLIC_EDGE_API_DISTRIBUTION_ID"]
        timeout = int(os.environ.get("GG_PUBLIC_EDGE_TIMEOUT_SECONDS", "600"))
        return run(cell, target_group_arn, dashboard_url, api_url, dashboard_id, api_id, timeout)
    except (KeyError, json.JSONDecodeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"BLOCKED: public edge acceptance failed ({error})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
