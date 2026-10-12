#!/usr/bin/env python3
"""Prepare cell-bound ephemeral BFF signer and tenant gateway tokens.

Tenant UUIDs must come from the trusted tenant bootstrap/membership owner. This
helper never discovers or invents tenant membership and never prints secrets.
The emitted tfvars file is private local input; all Terraform variables it
contains are ephemeral and all AWS secret versions are write-only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import tempfile
import uuid

DATABASE_PASSWORD_KEYS = (
    "KNOWLEDGE_APP_PASSWORD", "KNOWLEDGE_WORKER_PASSWORD", "KNOWLEDGE_MIGRATOR_PASSWORD",
    "KNOWLEDGE_PROVISIONER_PASSWORD", "KNOWLEDGE_REVIEWER_PASSWORD", "ADVISOR_APP_PASSWORD",
    "ADVISOR_MIGRATOR_PASSWORD", "ADVISOR_CHECKPOINT_APP_PASSWORD",
    "ADVISOR_CHECKPOINT_MIGRATOR_PASSWORD", "MODEL_GATEWAY_APP_PASSWORD",
    "MODEL_GATEWAY_USAGE_PASSWORD", "MODEL_GATEWAY_MIGRATOR_PASSWORD",
)


def cell_id(environment: str, cluster: str, region: str, account: str) -> str:
    identity = "\0".join((environment, cluster, region, account)).encode()
    return hashlib.sha256(identity).hexdigest()[:20]


def _run(*args: str, input_bytes: bytes | None = None) -> bytes:
    result = subprocess.run(args, input=input_bytes, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=False)
    if result.returncode:
        raise RuntimeError("OpenSSL key operation failed; secret output withheld")
    return result.stdout


def _private_material(directory: Path) -> tuple[str, bytes]:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".delegated-key-", dir=directory)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        os.chmod(temporary, 0o600)
        result = subprocess.run(
            ["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", str(temporary)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if result.returncode:
            raise RuntimeError("OpenSSL RSA key generation failed; secret output withheld")
        os.chmod(temporary, 0o600)
        _run("openssl", "pkey", "-in", str(temporary), "-check", "-noout")
        private = temporary.read_text(encoding="ascii")
        if not private.startswith("-----BEGIN PRIVATE KEY-----") or "-----END PRIVATE KEY-----" not in private:
            raise RuntimeError("OpenSSL did not return an unencrypted PKCS#8 key")
        public_der = _run("openssl", "pkey", "-in", str(temporary), "-pubout", "-outform", "DER")
        return private, public_der
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, temporary_name = tempfile.mkstemp(prefix=".ai-bundle-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _scope_argument(value: str) -> tuple[str, str]:
    parts = value.split(":")
    if len(parts) != 2:
        raise ValueError("retention scopes must be TENANT_UUID:USER_UUID pairs")
    return parts[0], parts[1]


def _pairs_without_duplicates(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("budget cap JSON has duplicate keys")
        result[key] = value
    return result


def _load_owner_receipt(path: Path, expected_issuer: str) -> tuple[str, str]:
    """Import an operator-produced enrollment receipt; never verify a raw JWT here."""
    path = path.expanduser().absolute()
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077
            or info.st_uid != os.getuid() or info.st_size > 16384):
        raise ValueError("owner receipt must be an owner-only bounded regular file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_pairs_without_duplicates)
    except (ValueError, UnicodeDecodeError):
        raise ValueError("owner receipt is invalid JSON") from None
    fields = {"version", "tenant_id", "user_id", "issuer", "role", "state", "enrollment"}
    if (not isinstance(value, dict) or set(value) != fields
            or type(value["version"]) is not int or value["version"] != 1
            or any(not isinstance(value[key], str) for key in fields - {"version"})
            or not expected_issuer.startswith("https://") or value["issuer"] != expected_issuer
            or value["role"] != "admin" or value["state"] != "active"
            or value["enrollment"] not in {"provisioning", "existing"}):
        raise ValueError("owner receipt does not match the expected ACTIVE admin/issuer")
    try:
        tenant, user = uuid.UUID(value["tenant_id"]), uuid.UUID(value["user_id"])
    except ValueError:
        raise ValueError("owner receipt identity fields are invalid") from None
    if (str(tenant) != value["tenant_id"] or tenant.version not in range(1, 9)
            or str(user) != value["user_id"] or user.version != 5):
        raise ValueError("owner receipt requires canonical tenant and control-plane identity UUIDs")
    return str(tenant), str(user)


def _load_budget_caps(path: Path | None, expected_tenants: set[str]) -> dict | None:
    if path is None:
        return None
    path = path.expanduser().absolute()
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077
            or info.st_uid != os.getuid() or info.st_size < 1 or info.st_size > 1 << 20):
        raise ValueError("budget caps input must be an owner-only bounded regular file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_pairs_without_duplicates)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError("budget caps input is invalid JSON") from None
    if not isinstance(value, dict) or set(value) != {"platform", "tenants"}:
        raise ValueError("budget caps must define exactly platform and tenants")

    def validate_limit(limit: object) -> None:
        if not isinstance(limit, dict) or set(limit) != {"limit_micros", "limit_tokens"}:
            raise ValueError("each budget cap must define exact money and token limits")
        for cap in limit.values():
            if type(cap) is not int or not 0 <= cap <= 1_000_000_000_000_000:
                raise ValueError("budget caps must be bounded nonnegative integers")

    validate_limit(value["platform"])
    tenants = value["tenants"]
    if not isinstance(tenants, list) or not 1 <= len(tenants) <= 5000:
        raise ValueError("budget caps require 1-5000 explicit tenants")
    tenant_ids: set[str] = set()
    users_total = 0
    for tenant in tenants:
        if not isinstance(tenant, dict) or set(tenant) - {"tenant_id", "limit", "users"} or not {"tenant_id", "limit"} <= set(tenant):
            raise ValueError("tenant cap entries have an unexpected field contract")
        tenant_id = tenant["tenant_id"]
        try:
            if not isinstance(tenant_id, str) or str(uuid.UUID(tenant_id)) != tenant_id:
                raise ValueError
        except ValueError:
            raise ValueError("budget tenant IDs must be canonical UUIDs") from None
        if tenant_id in tenant_ids:
            raise ValueError("budget cap entries contain duplicate tenants")
        tenant_ids.add(tenant_id)
        validate_limit(tenant["limit"])
        users = tenant.get("users", [])
        if not isinstance(users, list):
            raise ValueError("user budget caps must be an array")
        user_ids: set[str] = set()
        for user in users:
            users_total += 1
            if (users_total > 25000 or not isinstance(user, dict)
                    or set(user) != {"principal_id", "limit"}):
                raise ValueError("user cap entries have an invalid size or field contract")
            principal = user["principal_id"]
            try:
                if not isinstance(principal, str) or str(uuid.UUID(principal)) != principal:
                    raise ValueError
            except ValueError:
                raise ValueError("budget principal IDs must be canonical UUIDs") from None
            if principal in user_ids:
                raise ValueError("tenant budget contains duplicate principal IDs")
            user_ids.add(principal)
            validate_limit(user["limit"])
    if tenant_ids != expected_tenants:
        raise ValueError("budget tenant caps must exactly match the explicit Gateway tenant set")
    return value


def prepare(*, environment: str, cluster: str, region: str, account: str,
            tenant_ids: list[str], output: Path, rotate_signing_key: bool = False,
            remove_tenant_ids: list[str] | None = None,
            retention_scopes: list[tuple[str, str]] | None = None,
            remove_retention_scopes: list[tuple[str, str]] | None = None,
            budget_caps: dict | None = None) -> Path:
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,15}", environment) or environment in {"prod", "production"}:
        raise ValueError("a disposable non-production environment is required")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", cluster):
        raise ValueError("invalid cluster/cell name")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[0-9]+", region) or not re.fullmatch(r"[0-9]{12}", account):
        raise ValueError("valid AWS region and 12-digit account are required")
    if not tenant_ids:
        raise ValueError("at least one owner-approved tenant UUID is required")
    all_ids = tenant_ids + (remove_tenant_ids or []) + [
        value for scope in (retention_scopes or []) + (remove_retention_scopes or []) for value in scope
    ]
    for tenant_id in all_ids:
        try:
            parsed = uuid.UUID(tenant_id)
        except (ValueError, TypeError, AttributeError):
            raise ValueError("tenant IDs must be canonical UUIDs") from None
        if str(parsed) != tenant_id:
            raise ValueError("tenant IDs must be canonical UUIDs")
    if len(set(tenant_ids)) != len(tenant_ids) or len(set(remove_tenant_ids or [])) != len(remove_tenant_ids or []):
        raise ValueError("duplicate tenant UUIDs are not allowed")
    if set(tenant_ids) & set(remove_tenant_ids or []):
        raise ValueError("a tenant cannot be added and removed in one operation")
    for scopes in (retention_scopes or [], remove_retention_scopes or []):
        if len(set(scopes)) != len(scopes):
            raise ValueError("duplicate conversation retention scopes are not allowed")
    if set(retention_scopes or []) & set(remove_retention_scopes or []):
        raise ValueError("a retention scope cannot be added and removed in one operation")

    identity = {"environment": environment, "cluster": cluster, "region": region,
                "account_id": account, "cell_id": cell_id(environment, cluster, region, account)}
    output = output.expanduser().absolute()
    scope_path = output.with_name(output.name + ".scope.json")
    if output.exists() or output.is_symlink():
        info = output.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError("existing bundle must be a regular owner-only file")
        if not scope_path.is_file() or scope_path.is_symlink() or stat.S_IMODE(scope_path.stat().st_mode) & 0o077:
            raise ValueError("existing bundle requires an owner-only cell scope marker")
        recorded_scope = json.loads(scope_path.read_text(encoding="utf-8"))
        if recorded_scope.get("cell") != identity:
            raise ValueError("bundle belongs to a different disposable cell")
        existing = json.loads(output.read_text(encoding="utf-8"))
    else:
        if scope_path.exists() or scope_path.is_symlink():
            raise ValueError("orphaned bundle scope marker; inspect and recover explicitly")
        existing = {"ai_delegated_signing_material": {}, "ai_gateway_tenant_tokens": {},
                    "ai_database_role_passwords": {},
                    "ai_conversation_retention_scopes": []}

    role_passwords = dict(existing.get("ai_database_role_passwords", {}))
    unknown_passwords = set(role_passwords) - set(DATABASE_PASSWORD_KEYS)
    if unknown_passwords:
        raise ValueError("existing database role password map has unknown roles")
    for key in DATABASE_PASSWORD_KEYS:
        role_passwords.setdefault(key, secrets.token_urlsafe(48))
    if (set(role_passwords) != set(DATABASE_PASSWORD_KEYS)
            or any(not isinstance(value, str) or len(value) < 32 for value in role_passwords.values())
            or len(set(role_passwords.values())) != len(role_passwords)):
        raise ValueError("database role password bundle is incomplete or not independently generated")

    signer = existing["ai_delegated_signing_material"]
    if rotate_signing_key or not signer:
        output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        pem, public_der = _private_material(output.parent)
        kid = "bff-delegated-" + hashlib.sha256(public_der).hexdigest()[:20]
        signer = {"BFF_DELEGATED_PRIVATE_KEY_PEM": pem, "BFF_DELEGATED_KID": kid}

    token_map = dict(existing.get("ai_gateway_tenant_tokens", {}))
    requested = set(tenant_ids)
    for tenant_id in requested:
        token_map.setdefault(tenant_id, secrets.token_urlsafe(48))
    for tenant_id in remove_tenant_ids or []:
        if tenant_id not in token_map:
            raise ValueError("requested tenant token removal is absent")
        del token_map[tenant_id]
    if not token_map:
        raise ValueError("refusing to write an empty tenant gateway token map")

    scopes = {(scope["tenant_id"], scope["user_id"]) for scope in existing.get("ai_conversation_retention_scopes", [])}
    for tenant_id, user_id in retention_scopes or []:
        if tenant_id not in token_map:
            raise ValueError("retention scope tenant has no Gateway token")
        scopes.add((tenant_id, user_id))
    for scope in remove_retention_scopes or []:
        if scope not in scopes:
            raise ValueError("requested retention scope removal is absent")
        scopes.remove(scope)
    if not scopes:
        raise ValueError("refusing to write empty conversation retention scopes")
    if any(tenant not in token_map for tenant, _ in scopes):
        raise ValueError("remove every conversation scope before removing its tenant Gateway token")

    caps = budget_caps if budget_caps is not None else existing.get("ai_model_gateway_budget_caps")
    if caps is not None:
        # Validate caller-provided structured data through the same strict input
        # contract used for the protected CLI file.
        temporary_caps = output.with_name("." + output.name + ".budget-validation")
        _atomic_json(temporary_caps, caps)
        try:
            caps = _load_budget_caps(temporary_caps, set(token_map))
        finally:
            temporary_caps.unlink(missing_ok=True)

    payload = {"ai_database_role_passwords": role_passwords,
               "ai_delegated_signing_material": signer,
               "ai_gateway_tenant_tokens": token_map,
               "ai_conversation_retention_scopes": [
                   {"tenant_id": tenant, "user_id": user} for tenant, user in sorted(scopes)
               ]}
    if caps is not None:
        payload["ai_model_gateway_budget_caps"] = caps
    _atomic_json(output, payload)
    _atomic_json(scope_path, {"cell": identity})
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", required=True)
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--tenant-id", action="append", default=[],
                        help="owner-approved canonical tenant UUID; repeat once per tenant")
    parser.add_argument("--remove-tenant-id", action="append", default=[],
                        help="explicitly remove a previously provisioned tenant token")
    parser.add_argument("--retention-scope", action="append", default=[], metavar="TENANT_UUID:USER_UUID",
                        help="explicit owner-approved tenant/user conversation retention pair")
    parser.add_argument("--remove-retention-scope", action="append", default=[], metavar="TENANT_UUID:USER_UUID",
                        help="explicitly remove a previously provisioned retention pair")
    parser.add_argument("--budget-caps-file", type=Path,
                        help="owner-only JSON with explicit platform/tenant/user caps; tenant IDs must match --tenant-id")
    parser.add_argument("--owner-receipt", type=Path,
                        help="private JSON receipt emitted by verified first-admin enrollment")
    parser.add_argument("--expected-issuer", default="",
                        help="exact issuer from this cell's Terraform OIDC output; required with --owner-receipt")
    parser.add_argument("--rotate-signing-key", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    fingerprint = cell_id(args.environment, args.cluster, args.region, args.account_id)
    output = args.output or Path(__file__).parent / ".terraform" / "ai-runtime" / fingerprint / "ephemeral.auto.tfvars.json"
    try:
        if bool(args.owner_receipt) != bool(args.expected_issuer):
            raise ValueError("owner receipt and expected issuer must be supplied together")
        if args.owner_receipt:
            tenant, user = _load_owner_receipt(args.owner_receipt, args.expected_issuer)
            if tenant not in args.tenant_id:
                args.tenant_id.append(tenant)
            scope = tenant + ":" + user
            if scope not in args.retention_scope:
                args.retention_scope.append(scope)
        destination = prepare(environment=args.environment, cluster=args.cluster,
                              region=args.region, account=args.account_id,
                              tenant_ids=args.tenant_id, output=output,
                              rotate_signing_key=args.rotate_signing_key,
                              remove_tenant_ids=args.remove_tenant_id,
                              retention_scopes=[_scope_argument(raw) for raw in args.retention_scope],
                              remove_retention_scopes=[_scope_argument(raw) for raw in args.remove_retention_scope],
                              budget_caps=_load_budget_caps(args.budget_caps_file, set(args.tenant_id)) if args.budget_caps_file else None)
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"AI runtime bundle not prepared: {exc}", file=__import__("sys").stderr)
        return 2
    print(f"Prepared owner-only ephemeral AI inputs for cell {fingerprint}: {destination}")
    print("Use this file only as a local Terraform -var-file; do not copy it into source control or share it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
