#!/usr/bin/env python3
"""Prepare private, persistent shard credentials without printing secret values.

Pass this JSON's three variables through TF_VAR_* in the protected runner.
The role contract is read from the bootstrap SQL and Terraform profile tables.
Existing credentials are preserved; malformed or stale bundles fail closed.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile

ROOT = Path(__file__).resolve().parent
SHARDS = {"s1", "s2", "s3", "s4"}


def contracts() -> tuple[set[str], dict[str, str]]:
    sql = (ROOT / "../../gitops/disposable/rds-bootstrap-chart/files/init-databases.sql").read_text()
    keys = set(re.findall(r"(?m)^\\getenv\s+\S+\s+(\S+)\s*$", sql))
    runtime = (ROOT / "runtime-secrets.tf").read_text()
    central = re.search(r"runtime_central_only_bootstrap_role_keys\s*=\s*toset\(\[(.*?)\]\)", runtime, re.S)
    if central is None:
        raise ValueError("central bootstrap credential contract missing")
    operational = keys - set(re.findall(r'"([A-Z_]+)"', central[1]))
    shard_source = (ROOT / "shard-secret-values.tf").read_text()
    profile_block = re.search(r"shard_service_profiles\s*=\s*\{(.*?)\n  \}", shard_source, re.S)
    if profile_block is None:
        raise ValueError("shard service profile contract missing")
    profiles = dict(re.findall(r'([a-z][a-z-]+)\s*=\s*\{[^\n]*password_key\s*=\s*"([A-Z_]+)"', profile_block[1]))
    if not operational or not profiles or not set(profiles.values()) <= operational:
        raise ValueError("inconsistent bootstrap and service profile contracts")
    return operational, profiles


def prepare(path: Path) -> None:
    operational, profiles = contracts()
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("credential path must not be a symbolic link")
    if path.exists():
        if not path.is_file() or stat.S_IMODE(path.stat().st_mode) & 0o077:
            raise ValueError("existing credential bundle must be a private regular file")
        bundle = json.loads(path.read_text())
    else:
        bundle = {
            "shard_role_passwords": {shard: {key: secrets.token_urlsafe(48) for key in sorted(operational)} for shard in sorted(SHARDS)},
            "tenant_bootstrap_passwords": {shard: secrets.token_urlsafe(48) for shard in sorted(SHARDS)},
        }
        bundle["shard_registry_passwords"] = {
            service: {shard: bundle["shard_role_passwords"][shard][key] for shard in sorted(SHARDS)}
            for service, key in sorted(profiles.items())
        }
    if set(bundle) != {"shard_role_passwords", "shard_registry_passwords", "tenant_bootstrap_passwords"}:
        raise ValueError("unexpected bundle variables")
    roles, registry, bootstrap = (bundle[k] for k in ("shard_role_passwords", "shard_registry_passwords", "tenant_bootstrap_passwords"))
    if set(roles) != SHARDS or set(bootstrap) != SHARDS or set(registry) != set(profiles):
        raise ValueError("incomplete shard bundle")
    passwords = []
    for shard in SHARDS:
        if set(roles[shard]) != operational:
            raise ValueError("bootstrap role contract changed; explicit credential migration required")
        passwords.extend(roles[shard].values())
        passwords.append(bootstrap[shard])
    if any(not isinstance(p, str) or len(p) < 32 or re.search(r'["\\\r\n]', p) for p in passwords) or len(set(passwords)) != len(passwords):
        raise ValueError("credentials must be independent, strong and PgBouncer compatible")
    for service, key in profiles.items():
        if set(registry[service]) != SHARDS or any(registry[service][shard] != roles[shard][key] for shard in SHARDS):
            raise ValueError("registry credential does not match bootstrap role")
    if path.exists():
        return
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".shard-bundle-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(bundle, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        # Hard linking publishes exclusively: concurrent callers cannot rotate
        # credentials underneath each other by overwriting the destination.
        os.link(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        prepare(args.output.expanduser().absolute())
    except (OSError, ValueError, KeyError, TypeError):
        parser.exit(1, "Shard credential preparation failed; secret details withheld.\n")
    print("Private shard credential bundle validated; values withheld.")
