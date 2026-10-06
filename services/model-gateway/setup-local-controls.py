#!/usr/bin/env python3
"""Provision isolated local gateway controls. Never deploys AWS or changes billing."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import quote
from local_controls import initialize_controls

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--execute", action="store_true")
parser.add_argument("--principal", action="append", default=[])
args = parser.parse_args()
if not args.execute:
    parser.error("--execute required")
from uuid import UUID
for principal in args.principal:
    if str(UUID(principal)) != principal:
        parser.error("principal must be canonical UUID")
secret_dir = Path(os.environ.get("GREENGUARD_SECRET_DIR", str(Path.home()/".config/greenguard/secrets")))
secret_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
postgres = os.environ.get("GATEWAY_ACCEPTANCE_POSTGRES_CONTAINER", "gg-rag-local-1001-postgres-1")
port = os.environ.get("GATEWAY_ACCEPTANCE_POSTGRES_PORT", "55447")
database = "greenguard_ai_usage"
role = "model_gateway_app"

def sql(statement, db="postgres", capture=False):
    return subprocess.run(["docker", "exec", "-i", postgres, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-qAt"], input=statement, text=True, check=True, stdout=subprocess.PIPE if capture else subprocess.DEVNULL).stdout

def save(name, value):
    path = secret_dir/name
    fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(value)

password_file = secret_dir/"gateway-budget-password"
password = password_file.read_text().strip() if password_file.exists() else secrets.token_hex(32)
if sql(f"SELECT count(*) FROM pg_roles WHERE rolname='{role}';", capture=True).strip() == "0":
    sql(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{password}';")
    save("gateway-budget-password", password)
elif not password_file.exists():
    raise SystemExit("Existing runtime role has no managed local password; refusing to replace it")
if sql(f"SELECT count(*) FROM pg_database WHERE datname='{database}';", capture=True).strip() == "0":
    sql(f"CREATE DATABASE {database};")
if sql("SELECT to_regclass('public.ai_budget_accounts') IS NOT NULL;", database, True).strip() == "f":
    sql((root/"migrations/001_budget.sql").read_text(), database)
sql("CREATE INDEX IF NOT EXISTS ai_budget_held_reaper ON ai_budget_attempts(tenant_id,created_at) WHERE state='held';", database)
access = json.loads((secret_dir/"gateway-access.json").read_text())
tenants = {str(UUID(caller["tenant_id"])) for caller in access["token_hashes"].values()}
sql("INSERT INTO ai_platform_budget(period,limit_micros,limit_tokens) VALUES(date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,300000000,100000000) ON CONFLICT DO NOTHING;", database)
for tenant in tenants:
    for scope, cap in [("tenant", 30000000)] + [(f"user:{p}", 5000000) for p in args.principal]:
        sql(f"INSERT INTO ai_budget_accounts(tenant_id,scope,period,limit_micros,limit_tokens) VALUES('{tenant}','{scope}',date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,{cap},10000000) ON CONFLICT DO NOTHING;", database)
for caller in access["token_hashes"].values():
    if caller.get("workload") != "indexing" and not caller.get("principal_id"):
        caller["trusted_user_context"] = True
save("gateway-access.json", json.dumps(access, indent=2)+"\n")
redis_name = "gg-rag-gateway-redis"
exists = subprocess.run(["docker", "inspect", redis_name], capture_output=True, text=True)
if exists.returncode != 0:
    subprocess.run(["docker", "run", "-d", "--name", redis_name, "-p", "127.0.0.1:18179:6379", "redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499", "redis-server", "--save", "", "--appendonly", "no"], check=True, stdout=subprocess.DEVNULL)
else:
    info = json.loads(exists.stdout)[0]
    binding = info["HostConfig"]["PortBindings"].get("6379/tcp", [])
    if binding != [{"HostIp":"127.0.0.1", "HostPort":"18179"}]:
        raise SystemExit("Existing gateway Redis has unexpected bindings; refusing to change it")
    subprocess.run(["docker", "start", redis_name], check=True, stdout=subprocess.DEVNULL)
save("gateway-redis-url", "redis://127.0.0.1:18179")
save("gateway-budget-dsn", f"postgres://{role}:{quote(password)}@127.0.0.1:{port}/{database}?sslmode=disable")
initialize_controls(secret_dir/"gateway-controls.json", (root/"controls.example.json").read_text())
print("Local Redis, durable budget database, protected configuration and tenant/user caps provisioned. Existing spend preserved.")
