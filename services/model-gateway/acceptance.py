#!/usr/bin/env python3
"""Disposable real Redis/Postgres acceptance; credentials stay in child env/stdin."""
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
suffix = secrets.token_hex(5)
database = f"gg_gateway_test_{suffix}"
role = f"gg_gateway_app_{suffix}"
password = secrets.token_hex(24)
redis_name = f"gg-gateway-redis-{suffix}"
postgres = os.environ.get("GATEWAY_ACCEPTANCE_POSTGRES_CONTAINER", "gg-rag-local-1001-postgres-1")
postgres_port = os.environ.get("GATEWAY_ACCEPTANCE_POSTGRES_PORT", "55447")

def sql(text, db="postgres"):
    subprocess.run(["docker", "exec", "-i", postgres, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q"], input=text, text=True, check=True, stdout=subprocess.DEVNULL)

try:
    sql(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{password}'; CREATE DATABASE {database};")
    sql((ROOT / "migrations/001_budget.sql").read_text().replace("model_gateway_app", role), database)
    sql("INSERT INTO ai_platform_budget(period,limit_micros,limit_tokens) VALUES(date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,300000000,100000000);"
        "INSERT INTO ai_budget_accounts(tenant_id,scope,period,limit_micros,limit_tokens) VALUES"
        "('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tenant',date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,100000000,10000000),"
        "('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,10000000,1000000),"
        "('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','tenant',date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,100,1000);", database)
    subprocess.run(["docker", "run", "-d", "--name", redis_name, "-p", "127.0.0.1::6379", "redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499", "redis-server", "--save", "", "--appendonly", "no"], check=True, stdout=subprocess.DEVNULL)
    inspect = json.loads(subprocess.check_output(["docker", "inspect", redis_name]))[0]
    port = inspect["NetworkSettings"]["Ports"]["6379/tcp"][0]["HostPort"]
    env = dict(os.environ, GATEWAY_TEST_REDIS_URL=f"redis://127.0.0.1:{port}", GATEWAY_TEST_BUDGET_DSN=f"postgres://{role}:{quote(password)}@127.0.0.1:{postgres_port}/{database}?sslmode=disable")
    command = ["go", "test", "-race", "-timeout=40s", "-count=1", "-v"]
    if coverage := os.environ.get("GATEWAY_COVER_PROFILE"):
        command += ["-coverprofile=" + coverage]
    subprocess.run(command + ["./..."], cwd=ROOT, env=env, check=True)
    print("PASS: real Redis/Postgres gateway admission, accounting, identity, retries and breaker acceptance")
finally:
    subprocess.run(["docker", "rm", "-f", redis_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sql(f"DROP DATABASE IF EXISTS {database} WITH (FORCE); DROP ROLE IF EXISTS {role};")
