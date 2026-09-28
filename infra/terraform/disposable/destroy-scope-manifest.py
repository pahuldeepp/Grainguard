#!/usr/bin/env python3
"""Persist the minimal 0600 scope/secret inventory needed to retry teardown."""
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path


def validate_document(document):
    if not isinstance(document, dict) or set(document) != {
        "schema", "region", "environment", "cluster_name", "account_id",
        "master_secret_arn", "shard_master_secret_arns",
    } or document.get("schema") != 1:
        raise ValueError("cleanup manifest schema is invalid")
    region, environment, cluster, account = (document.get(key) for key in
                                            ("region", "environment", "cluster_name", "account_id"))
    if (not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}-[a-z]+-[0-9]+", region)
            or not isinstance(environment, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,15}", environment)
            or environment.lower() in {"prod", "production"}
            or not isinstance(cluster, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", cluster)
            or not isinstance(account, str) or not re.fullmatch(r"[0-9]{12}", account)):
        raise ValueError("cleanup manifest cell scope is invalid")
    secrets = document.get("shard_master_secret_arns")
    if (not isinstance(secrets, list) or len(secrets) > 4
            or any(not isinstance(arn, str) for arn in secrets)
            or len(set(secrets)) != len(secrets)):
        raise ValueError("cleanup manifest shard secret inventory is invalid")
    arns = list(secrets)
    master = document.get("master_secret_arn")
    if not isinstance(master, str):
        raise ValueError("cleanup manifest primary secret ARN is invalid")
    if master:
        arns.append(master)
    if any(not isinstance(arn, str) or not re.fullmatch(
            rf"arn:aws[a-z-]*:secretsmanager:{re.escape(region)}:{account}:secret:.+", arn)
            for arn in arns):
        raise ValueError("cleanup manifest secret ARN scope is invalid")
    return document


def read_manifest(path):
    target = Path(path)
    descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("cleanup manifest must be an owner-owned mode-0600 regular file")
        with os.fdopen(descriptor, "r") as stream:
            descriptor = -1
            document = json.load(stream)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    return validate_document(document)


def save(path, document):
    document = validate_document(document)
    target = Path(path)
    if target.exists() or target.is_symlink():
        previous = read_manifest(target)
        identity_keys = ("region", "environment", "cluster_name", "account_id")
        if any(previous[key] != document[key] for key in identity_keys):
            raise ValueError("existing cleanup manifest belongs to a different cell or inventory")
        if (previous["master_secret_arn"] and document["master_secret_arn"]
                and previous["master_secret_arn"] != document["master_secret_arn"]):
            raise ValueError("existing cleanup manifest has a different primary secret ARN")
        document["master_secret_arn"] = previous["master_secret_arn"] or document["master_secret_arn"]
        document["shard_master_secret_arns"] = list(dict.fromkeys(
            previous["shard_master_secret_arns"] + document["shard_master_secret_arns"]))
        validate_document(document)
    descriptor, temporary = tempfile.mkstemp(prefix=".destroy-scope-", dir=target.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(document, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        directory = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv):
    if len(argv) < 3:
        raise ValueError("usage: destroy-scope-manifest.py save|read|remove <path> [scope arguments]")
    action, path = argv[1:3]
    if action == "save" and len(argv) == 9:
        _, _, _, region, environment, cluster, account, master, secrets_path = argv
        secrets = [line for line in Path(secrets_path).read_text().splitlines() if line]
        save(path, {
            "schema": 1, "region": region, "environment": environment,
            "cluster_name": cluster, "account_id": account,
            "master_secret_arn": master, "shard_master_secret_arns": secrets,
        })
    elif action == "read" and len(argv) == 3:
        print(json.dumps(read_manifest(path), sort_keys=True, separators=(",", ":")))
    elif action == "remove" and len(argv) == 3:
        if Path(path).exists() or Path(path).is_symlink():
            read_manifest(path)
            Path(path).unlink()
    else:
        raise ValueError("invalid cleanup manifest arguments")


if __name__ == "__main__":
    try:
        main(sys.argv)
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"destroy-scope-manifest: {error}", file=sys.stderr)
        raise SystemExit(1)
