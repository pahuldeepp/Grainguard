#!/usr/bin/env python3
"""Bounded, repeatable registration of the checked-in Debezium connectors."""
import json
import os
import pathlib
import re
import sys
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
            return json.load(response)
    except urllib.error.HTTPError as exc:
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
        configs[name] = config
    return configs


def run(configs, base, deadline):
    base = base.rstrip("/")
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


if __name__ == "__main__":
    try:
        configs = load_configs(os.environ["RDS_HOST"])
        run(configs, os.environ.get("CONNECT_URL", "http://connect:8083"), time.monotonic() + 540)
        print(f"registered and verified {len(configs)} connectors")
    except (KeyError, ValueError, RuntimeError, urllib.error.URLError) as exc:
        print(f"connector registration failed: {exc}", file=sys.stderr)
        sys.exit(1)
