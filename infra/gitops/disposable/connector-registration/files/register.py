#!/usr/bin/env python3
"""Bounded, repeatable registration of the checked-in Debezium connectors."""
import json
import hashlib
import os
import pathlib
import re
import sys
import shutil
import subprocess
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
EXPECTED = {
    "alerts-outbox", "billing-outbox", "control-outbox", "inventory-outbox",
    "notification-contacts", "projection-notifications-outbox",
    "risk-outbox", "telemetry-outbox",
}


def request(method, url, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return {} if response.status == 204 else json.load(response)
    except urllib.error.HTTPError as exc:
        if method == "GET" and url.endswith("/config") and exc.code == 404:
            return None
        if method == "DELETE" and exc.code == 404:
            return {}
        body = exc.read(2048).decode(errors="replace")
        raise RuntimeError(f"{method} {url}: HTTP {exc.code}: {body}") from exc


def load_configs(host):
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", host) or "." not in host:
        raise ValueError("RDS_HOST must be a DNS hostname")
    files = {p.stem: p for p in (ROOT / "connectors").glob("*.json")}
    if files.keys() != EXPECTED:
        raise ValueError(f"connector inventory mismatch: {sorted(files)}")
    configs = {}
    slots = set()
    for name, path in sorted(files.items()):
        config = json.loads(path.read_text())
        if config.get("connector.class") != "io.debezium.connector.postgresql.PostgresConnector":
            raise ValueError(f"{name}: unexpected connector class")
        if config.get("database.hostname") != "postgres":
            raise ValueError(f"{name}: source no longer targets Compose postgres")
        if config.get("database.password") != "${env:CDC_DB_PASSWORD}":
            raise ValueError(f"{name}: database password must use Connect env provider")
        slot = config.get("slot.name")
        if not slot or slot in slots:
            raise ValueError(f"{name}: missing or duplicate replication slot")
        slots.add(slot)
        config["database.hostname"] = host
        config["database.sslmode"] = "verify-full"
        config["database.sslrootcert"] = "/rds-ca/ca.pem"
        if name == "notification-contacts":
            if config.get("value.converter") != "io.confluent.connect.avro.AvroConverter" or config.get("value.converter.schema.registry.url") != "${env:SCHEMA_REGISTRY_URL}":
                raise ValueError("notification-contacts: secure Registry converter contract drifted")
            config["value.converter.basic.auth.credentials.source"] = "USER_INFO"
            config["value.converter.basic.auth.user.info"] = "${env:SCHEMA_REGISTRY_BASIC_USER_INFO}"
            config["value.converter.schema.registry.ssl.truststore.type"] = "PEM"
            config["value.converter.schema.registry.ssl.truststore.location"] = "/etc/greenguard/kafka/registry-ca.crt"
        configs[name] = config
    return configs



def load_shard_configs(central_host, shard_hosts):
    if not isinstance(shard_hosts, dict) or set(shard_hosts) != {"s1", "s2", "s3", "s4"}:
        raise ValueError("SHARD_HOSTS_JSON must contain exactly s1-s4")
    if any(not isinstance(host, str) or not re.fullmatch(r"[a-zA-Z0-9.-]+", host) or "." not in host for host in shard_hosts.values()):
        raise ValueError("every shard host must be a DNS hostname")
    if len({host.lower() for host in shard_hosts.values()} | {central_host.lower()}) != 5:
        raise ValueError("central and shard endpoints must be physically distinct")
    central = load_configs(central_host)
    configs = {name: central[name] for name in ("control-outbox", "billing-outbox", "notification-contacts")}
    for shard_id, host in sorted(shard_hosts.items()):
        for name, config in load_configs(host).items():
            if name in {"control-outbox", "billing-outbox", "notification-contacts"}:
                continue
            prefix = config["topic.prefix"]
            config["topic.prefix"] = f"{prefix}_{shard_id}"
            config["slot.name"] = f"{shard_id}_{config['slot.name']}"
            config["database.password"] = "${env:CDC_DB_PASSWORD_" + shard_id.upper() + "}"
            for key in list(config):
                if key.startswith("transforms.") and key.endswith(".regex"):
                    config[key] = config[key].replace(prefix, config["topic.prefix"])
            configs[f"{name}-{shard_id}"] = config
    return configs


def assert_no_existing_shard_connectors(base):
    names = request("GET", f"{base.rstrip('/')}/connectors")
    if not isinstance(names, list):
        raise ValueError("Connect connector inventory must be a list")
    operational = EXPECTED - {"control-outbox", "billing-outbox", "notification-contacts"}
    if any(name in names for owner in operational for name in (f"{owner}-s{i}" for i in range(1, 5))):
        raise ValueError("cannot drop the shard registry while shard sources exist; perform an approved migration or disposable teardown")


def validate_central_retirement(receipt_file, central_host, expected_digest):
    raw = pathlib.Path(receipt_file).read_bytes()
    if not re.fullmatch(r"[a-f0-9]{64}", expected_digest) or hashlib.sha256(raw).hexdigest() != expected_digest:
        raise ValueError("central retirement receipt revision does not match its exact content")
    receipt = json.loads(raw)
    if (not isinstance(receipt, dict) or receipt.get("source") != "legacy-central"
            or receipt.get("sourceHost") != central_host
            or receipt.get("writesFenced") is not True
            or receipt.get("transferVerified") is not True
            or type(receipt.get("remainingTenants")) is not int
            or receipt["remainingTenants"] != 0):
        raise ValueError("central connector retirement needs a verified, fenced, empty-source cutover receipt")


def retirement_environment(central_host):
    # Retirement is optional. Its registration image must contain psql; credentials
    # stay in the environment and never enter command arguments or diagnostics.
    if shutil.which("psql") is None:
        raise ValueError("central retirement requires a registration image containing psql")
    if not pathlib.Path("/rds-ca/ca.pem").is_file():
        raise ValueError("central retirement requires the mounted RDS CA")
    password = os.environ.get("CDC_DB_PASSWORD")
    if not password:
        raise ValueError("central retirement requires central CDC credentials")
    environment = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    environment.update(PGHOST=central_host, PGPORT="5432", PGDATABASE="postgres", PGUSER="cdc_reader",
                       PGPASSWORD=password, PGSSLMODE="verify-full", PGSSLROOTCERT="/rds-ca/ca.pem",
                       PGCONNECT_TIMEOUT="5", PGOPTIONS="-c statement_timeout=5000 -c lock_timeout=1000")
    return environment


def retirement_sql(sql, environment):
    result = subprocess.run(["psql", "-X", "--no-password", "--quiet", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1"],
                            input=sql, env=environment, capture_output=True, text=True, timeout=12, check=False)
    if result.returncode:
        raise RuntimeError("central retirement SQL failed; credentials and diagnostics withheld")
    return result.stdout.strip()


def retirement_slots(targets, environment):
    names = ",".join("'" + config["slot.name"] + "'" for config in targets.values())
    raw = retirement_sql("SELECT json_build_object('user',current_user,'database',current_database(),'slots',"
                         "(SELECT COALESCE(json_agg(s),'[]'::json) FROM "
                         "(SELECT slot_name,database,plugin,active FROM pg_replication_slots WHERE slot_name IN (" + names + ")) s))::text;", environment)
    state = json.loads(raw)
    if not isinstance(state, dict) or state.get("user") != "cdc_reader" or state.get("database") != "postgres" or not isinstance(state.get("slots"), list):
        raise ValueError("central retirement database identity mismatch")
    expected = {config["slot.name"]: config for config in targets.values()}
    seen = set()
    for slot in state["slots"]:
        if not isinstance(slot, dict) or slot.get("slot_name") not in expected or slot["slot_name"] in seen:
            raise ValueError("central retirement slot inventory mismatch")
        seen.add(slot["slot_name"])
        config = expected[slot["slot_name"]]
        if slot.get("database") != config["database.dbname"] or slot.get("plugin") != "pgoutput" or type(slot.get("active")) is not bool:
            raise ValueError("central retirement slot database/plugin mismatch")
    return state["slots"]


def retire_central_operational_connectors(base, central_host, environment, deadline):
    # Receipt validation and new shard task health precede this call. Never
    # terminate an active backend, touch global sources, or infer slot cleanup
    # from Connect DELETE alone.
    base = base.rstrip("/")
    targets = {name: config for name, config in load_configs(central_host).items()
               if name not in {"control-outbox", "billing-outbox", "notification-contacts"}}
    existing = {}
    identity = ("connector.class", "database.hostname", "database.dbname", "database.user", "slot.name", "plugin.name")
    for name, config in targets.items():
        if not re.fullmatch(r"[a-z0-9_]{1,63}", config["slot.name"]) or not re.fullmatch(r"[a-z0-9_]+", config["database.dbname"]):
            raise ValueError("invalid central retirement slot identity")
        current = request("GET", f"{base}/connectors/{name}/config")
        if current is not None:
            if not isinstance(current, dict) or any(current.get(key) != config.get(key) for key in identity):
                raise ValueError(f"{name}: central retirement connector source identity mismatch")
            existing[name] = current
    retirement_slots(targets, environment)  # Verify DB/slot scope before mutation.
    for name, current in existing.items():
        if time.monotonic() >= deadline:
            raise RuntimeError("central retirement deadline exhausted")
        request("PUT", f"{base}/connectors/{name}/config", {**current, "slot.drop.on.stop": "true"})
        request("DELETE", f"{base}/connectors/{name}")
    while time.monotonic() < deadline:
        slots = retirement_slots(targets, environment)
        for slot in slots:
            if not slot["active"]:
                # The same query checks current DB/user and exact live metadata.
                # An activation race fails closed inside PostgreSQL; no force kill.
                retirement_sql("SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE "
                               "slot_name='" + slot["slot_name"] + "' AND database='" + slot["database"] + "' "
                               "AND plugin='pgoutput' AND NOT active AND current_user='cdc_reader' AND current_database()='postgres';", environment)
        remaining = retirement_slots(targets, environment)
        sources = [name for name in targets if request("GET", f"{base}/connectors/{name}/config") is not None]
        if not remaining and not sources:
            return
        time.sleep(1)
    raise RuntimeError("central retirement incomplete: operational connectors or replication slots remain")

def run(configs, base, deadline):
    base = base.rstrip("/")
    # A stable connector identity must never silently follow a replacement
    # source with existing offsets. Changing physical sources requires the
    # migration/recovery protocol and a distinct approved source identity.
    for name, config in configs.items():
        existing = request("GET", f"{base}/connectors/{name}/config")
        if existing is not None:
            identity_keys = ("database.hostname", "database.dbname", "topic.prefix", "slot.name")
            if any((str(existing.get(key, "")).lower() != str(config.get(key, "")).lower()) if key == "database.hostname" else existing.get(key) != config.get(key) for key in identity_keys):
                raise ValueError(f"{name}: existing connector source identity changed; explicit cutover required")
    for name, config in configs.items():
        # PUT is idempotent for existing connectors and creates them on Connect.
        request("PUT", f"{base}/connectors/{name}/config", config)
    remaining = set(configs)
    while remaining and time.monotonic() < deadline:
        for name in sorted(remaining):
            try:
                status = request("GET", f"{base}/connectors/{name}/status")
            except (RuntimeError, urllib.error.URLError, TimeoutError):
                continue
            connector = status.get("connector", {}).get("state")
            tasks = status.get("tasks", [])
            if connector == "FAILED" or any(t.get("state") == "FAILED" for t in tasks):
                raise RuntimeError(f"{name}: connector/task FAILED")
            if connector == "RUNNING" and tasks and all(t.get("state") == "RUNNING" for t in tasks):
                remaining.remove(name)
        if remaining:
            time.sleep(5)
    if remaining:
        raise RuntimeError(f"connector tasks did not reach RUNNING: {', '.join(sorted(remaining))}")


def main():
    try:
        shard_hosts = os.environ.get("SHARD_HOSTS_JSON")
        configs = (load_shard_configs(os.environ["RDS_HOST"], json.loads(shard_hosts))
                   if shard_hosts else load_configs(os.environ["RDS_HOST"]))
        receipt_file = os.environ.get("CENTRAL_RETIREMENT_RECEIPT_FILE")
        if receipt_file:
            if not shard_hosts:
                raise ValueError("central retirement requires a four-shard registry")
            validate_central_retirement(receipt_file, os.environ["RDS_HOST"], os.environ["CENTRAL_RETIREMENT_RECEIPT_SHA256"])
        retirement_env = retirement_environment(os.environ["RDS_HOST"]) if receipt_file else None
        base = os.environ.get("CONNECT_URL", "http://connect:8083")
        if not shard_hosts:
            assert_no_existing_shard_connectors(base)
        run(configs, base, time.monotonic() + 540)
        if receipt_file:
            retire_central_operational_connectors(base, os.environ["RDS_HOST"], retirement_env, time.monotonic() + 45)
        print(f"registered and verified {len(configs)} connectors")
        return 0
    except (KeyError, ValueError, RuntimeError, OSError, urllib.error.URLError, subprocess.TimeoutExpired) as exc:
        print(f"connector registration failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
