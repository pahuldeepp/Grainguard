"""Idempotent opt-in local MySQL migration and Kafka/Connect registration."""
from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

import pymysql
from confluent_kafka.admin import AdminClient, AlterConfigOpType, ConfigEntry, ConfigResource, NewTopic

ROOT = Path(__file__).resolve().parents[2]
LAB = Path(__file__).resolve().parent
TOPICS = {
    "legacy.partner_inventory.inventory_sites": ("delete", None),
    "legacy.partner_inventory.inventory_bins": ("delete", None),
    "legacy.partner_inventory.inventory_devices": ("delete", None),
    # Debezium's Kafka schema-history records are keyless; compaction rejects them.
    "greenguard.mysql-cdc.schema-history": ("delete", -1),
    "__debezium-heartbeat.legacy": ("delete", None),
    "greenguard.mysql-cdc.dlq.v1": ("delete", 604800000),
    # Needs-repair records must survive past the short raw DLQ retention.
    "greenguard.mysql-cdc.parked.v1": ("delete", -1),
}


def load_local_env():
    for file in (ROOT / ".env", ROOT / ".local/mysql-cdc.env"):
        if not file.is_file():
            raise RuntimeError(f"required local environment file is missing: {file}")
        for line in file.read_text(encoding="utf-8").splitlines():
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key, value)


def required(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def prepare_mysql():
    password = required("MYSQL_CDC_ROOT_PASSWORD")
    with pymysql.connect(host="127.0.0.1", port=53306, user="root", password=password,
                         database="partner_inventory", autocommit=True) as connection:
        with connection.cursor() as cursor:
            cursor.execute("GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'partner_cdc'@'%'")
            cursor.execute("SHOW VARIABLES LIKE 'binlog_format'")
            assert cursor.fetchone()[1] == "ROW"
            cursor.execute("SHOW VARIABLES LIKE 'binlog_row_image'")
            assert cursor.fetchone()[1] == "FULL"
    dsn = f"mysql+pymysql://partner_cdc:{quote(required('CDC_DB_PASSWORD'), safe='')}@127.0.0.1:53306/partner_inventory"
    subprocess.run([str(ROOT / ".local/mysql-cdc-venv/bin/alembic"), "-c", "alembic.ini", "upgrade", "head"],
                   cwd=LAB, env={**os.environ, "MYSQL_CDC_SOURCE_DSN": dsn}, check=True)
    print("MySQL ROW/FULL and Alembic migration verified")


def provision_topics():
    admin = AdminClient({"bootstrap.servers": "127.0.0.1:59092"})
    existing = set(admin.list_topics(timeout=10).topics)
    create = [NewTopic(name, 1, 1, config={"cleanup.policy": cleanup, "min.insync.replicas": "1",
                                            **({"retention.ms": str(retention)} if retention else {})})
              for name, (cleanup, retention) in TOPICS.items() if name not in existing]
    if create:
        for name, future in admin.create_topics(create).items():
            future.result(30)
            print("created topic", name)
    # Reconcile existing opt-in topics too; a prior failed snapshot may have
    # created a wrong cleanup policy before the connector was registered.
    resources = []
    for name, (cleanup, retention) in TOPICS.items():
        entries = [ConfigEntry("cleanup.policy", cleanup,
                               incremental_operation=AlterConfigOpType.SET)]
        if retention:
            entries.append(ConfigEntry("retention.ms", str(retention),
                                       incremental_operation=AlterConfigOpType.SET))
        resources.append(ConfigResource("TOPIC", name, incremental_configs=entries))
    for future in admin.incremental_alter_configs(resources).values():
        future.result(30)
    metadata = admin.list_topics(timeout=10)
    for name in TOPICS:
        topic = metadata.topics.get(name)
        if not topic or topic.error or len(topic.partitions) != 1:
            raise RuntimeError(f"MySQL CDC topic drift: {name}")
    print("MySQL CDC topics verified")


def register_connector():
    config = json.loads((ROOT / "infra/mysql-cdc/connector.json").read_text())
    name = config["name"]
    base = "http://127.0.0.1:58083/connectors"
    request = urllib.request.Request(base + "/" + name + "/config",
        data=json.dumps(config["config"]).encode(),
        headers={"Content-Type": "application/json"}, method="PUT")
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status not in (200, 201):
            raise RuntimeError("MySQL connector registration failed")
    print("MySQL connector registered with persistent Kafka Connect metadata")


if __name__ == "__main__":
    load_local_env()
    prepare_mysql()
    provision_topics()
    register_connector()
