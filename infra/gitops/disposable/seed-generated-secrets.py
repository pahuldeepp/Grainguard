#!/usr/bin/env python3
"""Create only missing AWSCURRENT versions for disposable generated credentials.

No credential is passed as a process argument or printed. This helper never
rotates an existing source. It is intentionally narrower than secret sync.
"""

import argparse
import json
import re
import secrets
import subprocess
import sys
from pathlib import Path


SQL = Path(__file__).with_name("rds-bootstrap-chart") / "files/init-databases.sql"
NAMES = (
    "greenguard-rds-bootstrap", "grafana-admin", "greenguard-cdc-credentials",
    "greenguard-opensearch-admin", "greenguard-opensearch-clients",
)


def aws(*args, payload=None):
    command = ["aws", *args, "--output", "json"]
    result = subprocess.run(command, input=payload, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"AWS {args[0]} {args[1]} failed (exit {result.returncode})")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("AWS returned malformed JSON") from exc


def role_keys():
    keys = re.findall(r"^\\getenv\s+\S+\s+(\S+)\s*$", SQL.read_text(), re.MULTILINE)
    if len(keys) < 10 or len(keys) != len(set(keys)):
        raise RuntimeError("RDS bootstrap role-key contract is missing or duplicated")
    return sorted(keys)


def source(account, region, environment, name):
    remote_name = f"greenguard/{environment}/{name}"
    response = aws("secretsmanager", "describe-secret", "--region", region, "--secret-id", remote_name)
    arn = response.get("ARN", "")
    if response.get("Name") != remote_name or not arn.startswith(f"arn:aws:secretsmanager:{region}:{account}:secret:"):
        raise RuntimeError(f"{name}: source is outside expected account/region/name")
    if response.get("DeletedDate"):
        raise RuntimeError(f"{name}: source is scheduled for deletion")
    versions = response.get("VersionIdsToStages", {})
    if not isinstance(versions, dict):
        raise RuntimeError(f"{name}: version metadata is malformed")
    if any("AWSCURRENT" in stages for stages in versions.values()):
        return arn, False
    if versions:
        raise RuntimeError(f"{name}: versions exist without AWSCURRENT; manual review required")
    return arn, True


def generated(name):
    if name == "greenguard-rds-bootstrap":
        return {key: secrets.token_urlsafe(36) for key in role_keys()}
    if name == "grafana-admin":
        return {"GF_SECURITY_ADMIN_USER": "greenguard-admin",
                "GF_SECURITY_ADMIN_PASSWORD": secrets.token_urlsafe(36)}
    if name == "greenguard-opensearch-admin":
        return {"password": secrets.token_urlsafe(36)}
    if name == "greenguard-opensearch-clients":
        return {"writer-password": secrets.token_urlsafe(36),
                "reader-password": secrets.token_urlsafe(36),
                "acceptance-writer-password": secrets.token_urlsafe(36),
                "acceptance-reader-password": secrets.token_urlsafe(36)}
    raise RuntimeError("unapproved generated source")


def current_data(region, environment, name, arn, keys):
    response = aws("secretsmanager", "get-secret-value", "--region", region,
                   "--secret-id", arn, "--version-stage", "AWSCURRENT")
    if response.get("Name") != f"greenguard/{environment}/{name}" or not response.get("VersionId") or "AWSCURRENT" not in response.get("VersionStages", []):
        raise RuntimeError(f"{name}: current version identity is invalid")
    try:
        data = json.loads(response["SecretString"])
    except (KeyError, ValueError, TypeError) as exc:
        raise RuntimeError(f"{name}: current version is malformed") from exc
    if not isinstance(data, dict) or set(data) != set(keys) or not all(isinstance(v, str) and v for v in data.values()):
        raise RuntimeError(f"{name}: current version has invalid keys or values")
    return data


def put(region, arn, data):
    aws("secretsmanager", "put-secret-value", "--region", region,
        "--secret-id", arn, "--secret-string", "file:///dev/stdin",
        payload=json.dumps(data, separators=(",", ":")))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--environment", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[0-9]{12}", args.account_id):
        parser.error("--account-id must be 12 digits")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.environment):
        parser.error("--environment must be a lowercase DNS label")
    if not re.fullmatch(r"[a-z]{2}(-[a-z]+)+-[0-9]", args.region):
        parser.error("--region must be an AWS region")
    if aws("sts", "get-caller-identity").get("Account") != args.account_id:
        raise RuntimeError("AWS account does not match --account-id")
    pending = []
    sources = {}
    for name in NAMES:
        arn, needed = source(args.account_id, args.region, args.environment, name)
        sources[name] = (arn, needed)
        if needed:
            pending.append((name, arn))
    bootstrap_arn, bootstrap_missing = sources["greenguard-rds-bootstrap"]
    cdc_arn, cdc_missing = sources["greenguard-cdc-credentials"]
    if bootstrap_missing and not cdc_missing:
        raise RuntimeError("CDC source exists but bootstrap source is missing; manual review required")
    bootstrap = None
    if not bootstrap_missing:
        bootstrap = current_data(args.region, args.environment, "greenguard-rds-bootstrap",
                                 bootstrap_arn, role_keys())
    if not cdc_missing:
        cdc = current_data(args.region, args.environment, "greenguard-cdc-credentials",
                           cdc_arn, {"CDC_DB_PASSWORD"})
        if cdc["CDC_DB_PASSWORD"] != bootstrap["CDC_DB_PASSWORD"]:
            raise RuntimeError("CDC source differs from bootstrap role password; manual review required")
    for name, keys in (
        ("grafana-admin", {"GF_SECURITY_ADMIN_USER", "GF_SECURITY_ADMIN_PASSWORD"}),
        ("greenguard-opensearch-admin", {"password"}),
        ("greenguard-opensearch-clients", {"writer-password", "reader-password", "acceptance-writer-password", "acceptance-reader-password"}),
    ):
        arn, missing = sources[name]
        if not missing:
            current_data(args.region, args.environment, name, arn, keys)
    if not args.apply:
        print(f"PLAN {len(pending)} generated source version(s); no values shown")
        return 1 if pending else 0
    for name, arn in pending:
        if name == "greenguard-rds-bootstrap":
            put(args.region, arn, generated(name))
            bootstrap = current_data(args.region, args.environment, name, arn, role_keys())
        elif name == "greenguard-cdc-credentials":
            # A concurrent bootstrap rotation between these writes is caught
            # by the next read; the CDC version always uses the observed current.
            bootstrap = current_data(args.region, args.environment,
                                     "greenguard-rds-bootstrap", bootstrap_arn, role_keys())
            put(args.region, arn, {"CDC_DB_PASSWORD": bootstrap["CDC_DB_PASSWORD"]})
        else:
            put(args.region, arn, generated(name))
    print(f"PASS created {len(pending)} generated source version(s); no values shown")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
