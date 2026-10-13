#!/usr/bin/env python3
"""Fail-closed inventory of disposable live acceptance evidence; no cloud calls."""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / "evidence"
REQUIRED = (
    # Per-system probes prove more than pod readiness or the PostgreSQL
    # migration gate. Keep these separate so a healthy deployment cannot
    # silently stand in for data-plane behavior.
    "postgres-shard-read-write-replica-freshness",
    "pgbouncer-transaction-pool",
    "kafka-produce-consume",
    "kafka-connect-connector-status",
    "schema-registry-subject-compatibility",
    "rabbitmq-publish-consume",
    "redis-tenant-cache-roundtrip",
    "cassandra-tenant-partition-roundtrip",
    "opensearch-index-search",
    # ClickHouse is a separate analytics store. A Ready StatefulSet does not
    # prove that the ingestion identity can write rows or that they can be
    # queried back, so require an explicit insert/select receipt.
    "clickhouse-roundtrip",
    "mqtt-tls-auth-publish-subscribe",
    "object-storage-audit-export-roundtrip",
    "oauth-discovery-jwks",
    # Issuer login alone is not tenant onboarding. Require authoritative
    # control-plane membership read-back before accepting the app as usable.
    "tenant-membership-readback",
    "web-login", "api-auth", "tenant-isolation", "alert-create",
    "alert-live-update", "alert-ack", "iphone-physical-login",
    "iphone-alert-ack", "iphone-signout-offline",
    "telemetry-projection", "recovery", "teardown",
)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("timestamp must be a string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp needs an offset")
    return parsed.astimezone(timezone.utc)


def verify(manifest):
    if not isinstance(manifest, dict):
        return ["manifest must be an object"]
    failures = []
    if manifest.get("schemaVersion") != 1:
        failures.append("schemaVersion must be 1")
    scope = manifest.get("scope", {})
    if not isinstance(scope, dict):
        return failures + ["scope must be an object"]
    scope_patterns = (
        ("accountId", r"[0-9]{12}", "scope.accountId must be a 12-digit AWS account"),
        ("region", r"[a-z]{2}-[a-z]+-[0-9]", "scope.region is invalid"),
        ("cluster", r"[a-z0-9][a-z0-9-]{2,99}", "scope.cluster is invalid"),
        ("gitRevision", r"[a-f0-9]{40}", "scope.gitRevision must be an exact commit"),
    )
    for field, pattern, message in scope_patterns:
        value = scope.get(field)
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            failures.append(message)
    try:
        start, end = timestamp(scope["startedAt"]), timestamp(scope["endedAt"])
        if start >= end:
            failures.append("scope time range is reversed")
    except (KeyError, TypeError, ValueError):
        failures.append("scope needs valid startedAt and endedAt")
        start = end = None

    checks = manifest.get("checks", [])
    if not isinstance(checks, list):
        return failures + ["checks must be a list"]
    ids = [item.get("id") for item in checks if isinstance(item, dict)]
    if any(not isinstance(ident, str) for ident in ids):
        failures.append("check ids must be strings")
        ids = [ident for ident in ids if isinstance(ident, str)]
    if len(ids) != len(checks) or len(ids) != len(set(ids)):
        failures.append("checks need unique ids")
    for required in REQUIRED:
        if required not in ids:
            failures.append(f"missing live check: {required}")
    for item in checks:
        if not isinstance(item, dict):
            continue
        ident = item.get("id", "unknown")
        if item.get("status") != "PASS":
            failures.append(f"{ident}: live status is not PASS")
        if any(not isinstance(item.get(field), str) or not item[field].strip()
               for field in ("observation", "expected")):
            failures.append(f"{ident}: expected and observed results required")
        if not isinstance(item.get("operator"), str) or not item["operator"].strip():
            failures.append(f"{ident}: operator required")
        try:
            observed = timestamp(item["observedAt"])
            if start and end and not start <= observed <= end:
                failures.append(f"{ident}: observation outside run window")
        except (KeyError, TypeError, ValueError):
            failures.append(f"{ident}: observedAt invalid")
        artifacts = item.get("artifacts", [])
        if not isinstance(artifacts, list) or not artifacts:
            failures.append(f"{ident}: at least one evidence artifact required")
            continue
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                failures.append(f"{ident}: invalid artifact")
                continue
            relative = artifact.get("path", "")
            digest = artifact.get("sha256", "")
            if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                failures.append(f"{ident}: artifact needs SHA-256")
                continue
            if not isinstance(relative, str):
                failures.append(f"{ident}: artifact path must be a string")
                continue
            try:
                path = (ROOT / relative).resolve(strict=True)
                if not path.is_relative_to(EVIDENCE.resolve()) or not path.is_file():
                    raise ValueError("outside evidence directory")
                if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    raise ValueError("hash mismatch")
            except (OSError, ValueError):
                failures.append(f"{ident}: artifact missing, outside evidence, or hash mismatch")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", nargs="?", help="operator-reviewed evidence manifest JSON")
    args = parser.parse_args()
    if not args.manifest:
        print("BLOCKED: no live acceptance evidence manifest supplied")
        return 1
    try:
        manifest = json.loads(Path(args.manifest).read_text())
        failures = verify(manifest)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(f"BLOCKED: invalid evidence manifest ({type(error).__name__})", file=sys.stderr)
        return 1
    if failures:
        for failure in failures:
            print(f"BLOCKED: {failure}", file=sys.stderr)
        return 1
    print(
        "BLOCKED: evidence inventory is structurally complete, but this checker "
        "does not certify live acceptance; an authorized reviewer must inspect "
        "the artifacts and record approval separately."
    )
    # A valid evidence inventory is not an acceptance PASS. Use a distinct
    # non-zero status so automation cannot mistake structural validation for
    # completed live acceptance.
    return 2


if __name__ == "__main__":
    sys.exit(main())
