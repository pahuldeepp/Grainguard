"""Opt-in MySQL -> Debezium -> Kafka -> authenticated Device Service proof."""
from __future__ import annotations

import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import psycopg
import pymysql
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, create_engine, inspect
from confluent_kafka import Consumer, Producer, TopicPartition
from confluent_kafka.admin import AdminClient, NewTopic

from normalize import SourceConfig, canonical_id
from runtime import (AdmissionClient, FatalFailure, KafkaRuntime, MAX_REDRIVE_REQUEUES,
                     RawRecord, TenantCredential, decode_dlq, raw_message)
from prepare_local import create_secret_file
from setup_local import ROOT, LAB, load_local_env, prepare_mysql, provision_topics
from source_schema import metadata as source_metadata


def check(condition, description):
    if not condition:
        raise AssertionError(description)
    print("PASS", description, flush=True)


def wait_until(fn, description, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = fn()
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            value = None
        if value:
            return value
        time.sleep(0.5)
    raise TimeoutError(description)


def query(sql, params=()):
    admin = urlsplit(os.environ["POSTGRES_ADMIN_URL"])
    url = urlunsplit((admin.scheme, admin.netloc, "/greenguard_inventory", admin.query, admin.fragment))
    with psycopg.connect(url) as conn, conn.cursor() as cursor:
        cursor.execute(sql, params) if params else cursor.execute(sql)
        return cursor.fetchall()


def mysql(sql, params=(), *, database=None):
    with pymysql.connect(host="127.0.0.1", port=53306, user="root",
                         password=os.environ["MYSQL_CDC_ROOT_PASSWORD"],
                         database=database, autocommit=True) as conn, conn.cursor() as cursor:
        cursor.execute(sql, params) if params else cursor.execute(sql)
        return cursor.fetchall()


def source_dsn(database, password):
    return f"mysql+pymysql://partner_cdc:{quote(password, safe='')}@127.0.0.1:53306/{database}"


def check_live_schema_parity(dsn):
    """The applied migration head must still match the current source model."""
    engine = create_engine(dsn)
    try:
        inspector = inspect(engine)
        for name, model in source_metadata.tables.items():
            live_columns = {column["name"]: column for column in inspector.get_columns(name)}
            check(set(live_columns) == set(model.columns.keys()), f"{name} column names match model")
            for column in model.columns:
                live = live_columns[column.name]
                check(live["nullable"] == column.nullable and
                      live["type"].length == column.type.length,
                      f"{name}.{column.name} type/nullability match model")
            check(inspector.get_pk_constraint(name)["constrained_columns"] ==
                  [column.name for column in model.primary_key.columns],
                  f"{name} primary key matches model")
            model_uniques = {tuple(column.name for column in constraint.columns)
                             for constraint in model.constraints if isinstance(constraint, UniqueConstraint)}
            live_uniques = {tuple(item["column_names"]) for item in inspector.get_unique_constraints(name)}
            check(model_uniques == live_uniques, f"{name} unique keys match model")
            model_fks = {(tuple(element.parent.name for element in constraint.elements),
                          constraint.referred_table.name,
                          tuple(element.column.name for element in constraint.elements), constraint.ondelete)
                         for constraint in model.constraints if isinstance(constraint, ForeignKeyConstraint)}
            live_fks = {(tuple(item["constrained_columns"]), item["referred_table"],
                         tuple(item["referred_columns"]), item.get("options", {}).get("ondelete"))
                        for item in inspector.get_foreign_keys(name)}
            check(model_fks == live_fks, f"{name} foreign keys match model")
            model_checks = {constraint.name for constraint in model.constraints
                            if isinstance(constraint, CheckConstraint)}
            live_checks = {item["name"]: re.sub(r"[\s`]", "", item["sqltext"].lower())
                           for item in inspector.get_check_constraints(name)}
            check(model_checks == set(live_checks), f"{name} check names match model")
            for column_name in ("name", "serial_number"):
                if column_name not in model.columns:
                    continue
                edge = f"char_length({column_name})=char_length(trim({column_name}))"
                check(any(edge in expression for expression in live_checks.values()),
                      f"{name} live edge-space check matches model")
    finally:
        engine.dispose()


def cleanup_inventory(tenants, source_id):
    """Delete only this run's random fixture tenants, in dependency order."""
    if not tenants:
        return
    admin = urlsplit(os.environ["POSTGRES_ADMIN_URL"])
    url = urlunsplit((admin.scheme, admin.netloc, "/greenguard_inventory", admin.query, admin.fragment))
    with psycopg.connect(url) as conn, conn.cursor() as cursor:
        # Fixture cleanup runs as the PostgreSQL superuser; bypass the tenant-ownership
        # row fence for this transaction only (the importer under test keeps it enabled).
        cursor.execute("SET LOCAL session_replication_role = replica")
        for tenant in tenants.values():
            cursor.execute("DELETE FROM inventory_import_state WHERE tenant_id=%s AND source_id=%s", (tenant, source_id))
            for table in ("audit_events", "outbox_events", "command_receipts", "devices", "bins", "sites", "tenants"):
                cursor.execute(f"DELETE FROM {table} WHERE tenant_id=%s", (tenant,))
        cursor.execute("SELECT count(*) FROM tenants WHERE tenant_id IN (%s, %s)", tuple(tenants.values()))
        if cursor.fetchone()[0] != 0:
            raise AssertionError("run-scoped PostgreSQL tenants remain")


def cleanup_topics(names):
    admin = AdminClient({"bootstrap.servers": "127.0.0.1:59092"})
    existing = set(admin.list_topics(timeout=10).topics)
    present = [name for name in names if name in existing]
    if present:
        for future in admin.delete_topics(present).values():
            future.result(30)
    wait_until(lambda: not set(names).intersection(admin.list_topics(timeout=10).topics),
               "run-scoped Kafka topic deletion", timeout=45)


def cleanup_mysql_database(database):
    mysql(f"DROP DATABASE `{database}`")
    check(mysql("SELECT count(*) FROM information_schema.schemata WHERE schema_name=%s", (database,))[0][0] == 0,
          "run-scoped MySQL database removed")


def stop_harness(harness):
    if harness.poll() is None:
        try:
            harness.send_signal(signal.SIGTERM)
        finally:
            try:
                harness.wait(timeout=10)
            except subprocess.TimeoutExpired:
                harness.kill()
                harness.wait(timeout=10)


def run_cleanup_steps(steps, *, primary_failed):
    """Try every independent step; keep the original live failure primary."""
    failures = []
    for label, action in steps:
        try:
            action()
        except Exception as error:
            # Only fixed step labels and exception classes; never log DSNs,
            # source rows, tenant IDs, credentials or provider response bodies.
            print(f"CLEANUP_FAILURE step={label} error={type(error).__name__}", file=sys.stderr, flush=True)
            failures.append(label)
    if failures and not primary_failed:
        raise RuntimeError("live fixture cleanup incomplete: " + ", ".join(failures))
    return failures


def create_topics(names):
    admin = AdminClient({"bootstrap.servers": "127.0.0.1:59092"})
    create = [NewTopic(name, 1, 1, config={
        "cleanup.policy": "delete", "min.insync.replicas": "1",
        **({"retention.ms": "-1"} if name.endswith((".schema-history", ".parked")) else
           {"retention.ms": "604800000"} if name.endswith(".dlq") else {}),
    }) for name in names]
    for future in admin.create_topics(create).values():
        future.result(30)


def connector_request(path, *, method="GET", body=None):
    request = urllib.request.Request("http://127.0.0.1:58083" + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response) if response.status != 204 else None


def consumer(group):
    return Consumer({"bootstrap.servers": "127.0.0.1:59092", "group.id": group,
                     "enable.auto.commit": False, "enable.auto.offset.store": False,
                     "auto.offset.reset": "earliest", "isolation.level": "read_committed"})


def producer():
    return Producer({"bootstrap.servers": "127.0.0.1:59092", "enable.idempotence": True, "acks": "all"})


def process_until(runner, wanted, *, timeout=90):
    seen = []
    deadline = time.monotonic() + timeout
    while len(seen) < wanted and time.monotonic() < deadline:
        msg = runner.consumer.poll(1)
        if msg is None:
            continue
        if msg.error():
            raise RuntimeError("Kafka consume failed")
        rec = raw_message(msg)
        runner.process(rec)
        seen.append(rec)
    check(len(seen) == wanted, f"consumed and committed {wanted} Kafka source changes")
    return seen


def await_record(runner, predicate, *, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        msg = runner.consumer.poll(1)
        if msg is None:
            continue
        if msg.error():
            raise RuntimeError("Kafka consume failed")
        rec = raw_message(msg)
        payload = json.loads(rec.value)["payload"]
        if predicate(rec, payload):
            return rec
        runner.process(rec)
    raise TimeoutError("Kafka change was not observed")


def main():
    load_local_env()
    clients_file = ROOT / ".local/mysql-cdc-clients.env"
    if not clients_file.exists():
        create_secret_file(
            clients_file,
            "MYSQL_CDC_CLIENT_A=" + secrets.token_hex(20) + "\n"
            "MYSQL_CDC_CLIENT_B=" + secrets.token_hex(20) + "\n",
        )
    for line in clients_file.read_text().splitlines():
        name, value = line.split("=", 1)
        os.environ[name] = value
    prepare_mysql()
    provision_topics()
    suffix = uuid.uuid4().hex[:12]
    database, prefix, source_id = "gglive_" + suffix, "gglive" + suffix, "partner-" + suffix
    connector_name = "greenguard-mysql-live-" + suffix
    tables = ("inventory_sites", "inventory_bins", "inventory_devices")
    topics = tuple(f"{prefix}.{database}.{table}" for table in tables)
    dlq = f"{prefix}.{database}.dlq"
    parked = f"{prefix}.{database}.parked"
    history = f"{prefix}.{database}.schema-history"
    run_topics = (*topics, dlq, parked, history, f"__debezium-heartbeat.{prefix}")
    connector_created = False
    database_created = False
    harness = None
    tenants = {"partner-a": str(uuid.uuid4()), "partner-b": str(uuid.uuid4())}
    consumers = []
    succeeded = False
    try:
        mysql(f"CREATE DATABASE `{database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
        database_created = True
        mysql(f"GRANT ALL PRIVILEGES ON `{database}`.* TO 'partner_cdc'@'%'")
        subprocess.run([str(ROOT / ".local/mysql-cdc-venv/bin/alembic"), "-c", "alembic.ini", "upgrade", "head"],
                       cwd=LAB, env={**os.environ, "MYSQL_CDC_SOURCE_DSN": source_dsn(database, os.environ["CDC_DB_PASSWORD"])}, check=True)
        check_live_schema_parity(source_dsn(database, os.environ["CDC_DB_PASSWORD"]))
        harness_env = {**os.environ, "MYSQL_CDC_SOURCE_ID": source_id,
                       "MYSQL_CDC_TENANT_A": tenants["partner-a"],
                       "MYSQL_CDC_TENANT_B": tenants["partner-b"]}
        harness = subprocess.Popen(["node", str(LAB / "api_harness.mjs")], cwd=ROOT,
                                   env=harness_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready_line = harness.stdout.readline()
        if not ready_line:
            raise RuntimeError("RS256 Device Service harness exited: " + harness.stderr.read()[-1000:])
        ready = json.loads(ready_line)
        check(ready["tenants"] == tenants, "local issuer matches run-scoped fixture tenants")
        creds = {tenants["partner-a"]: TenantCredential("importer-a", os.environ["MYSQL_CDC_CLIENT_A"]),
                 tenants["partner-b"]: TenantCredential("importer-b", os.environ["MYSQL_CDC_CLIENT_B"])}
        admission = AdmissionClient(api_url=ready["api_url"], token_url=ready["token_url"], credentials=creds)
        source = SourceConfig(source_id, "generation-1", prefix, database, prefix)
        site_a, site_b, bin_a, bin_b, device_a, device_b = [f"{kind}-{suffix}" for kind in ("sitea", "siteb", "bina", "binb", "devicea", "deviceb")]
        for partner, site, bin_id, device in (("partner-a", site_a, bin_a, device_a), ("partner-b", site_b, bin_b, device_b)):
            mysql("INSERT INTO inventory_sites (tenant_key,site_id,name) VALUES (%s,%s,%s)", (partner, site, "North"), database=database)
            mysql("INSERT INTO inventory_bins (tenant_key,bin_id,site_id,name) VALUES (%s,%s,%s,%s)", (partner, bin_id, site, "Silo"), database=database)
            mysql("INSERT INTO inventory_devices (tenant_key,device_id,site_id,bin_id,serial_number,status) VALUES (%s,%s,%s,%s,%s,%s)",
                  (partner, device, site, bin_id, "SN-" + device, "active"), database=database)
        for statement, params in (
            ("INSERT INTO inventory_sites (tenant_key,site_id,name) VALUES (%s,%s,%s)",
             ("partner-a", "edge-site-" + suffix, "Trailing ")),
            ("INSERT INTO inventory_bins (tenant_key,bin_id,site_id,name) VALUES (%s,%s,%s,%s)",
             ("partner-a", "edge-bin-" + suffix, site_a, "Trailing ")),
            ("INSERT INTO inventory_devices (tenant_key,device_id,site_id,bin_id,serial_number,status) VALUES (%s,%s,%s,%s,%s,%s)",
             ("partner-a", "edge-device-" + suffix, site_a, bin_a, "Serial ", "active")),
        ):
            try:
                mysql(statement, params, database=database)
            except pymysql.MySQLError as error:
                check(error.args[0] == 3819, "MySQL rejected a trailing-space source value")
            else:
                raise AssertionError("MySQL accepted a trailing-space source value")
        create_topics(run_topics)
        config = json.loads((ROOT / "infra/mysql-cdc/connector.json").read_text())["config"]
        config.update({"database.include.list": database,
                       "table.include.list": ",".join(f"{database}.{table}" for table in tables),
                       "topic.prefix": prefix,
                       "database.server.id": str(20000 + int(suffix[:4], 16) % 30000),
                       "schema.history.internal.kafka.topic": history})
        connector_request("/connectors", method="POST", body={"name": connector_name, "config": config})
        connector_created = True
        def connector_running():
            status = connector_request(f"/connectors/{connector_name}/status")
            return status["connector"]["state"] == "RUNNING" and bool(status["tasks"]) and all(t["state"] == "RUNNING" for t in status["tasks"])
        wait_until(connector_running, "Debezium snapshot task running")
        kafka = consumer("mysql-cdc-live-" + suffix)
        consumers.append(kafka)
        runner = KafkaRuntime(consumer=kafka, producer=producer(), source=source,
            tenant_map=tenants, admission=admission, topics=topics, dlq_topic=dlq,
            parked_topic=parked,
            partition_factory=TopicPartition)
        snapshot = process_until(runner, 6)
        print("snapshot markers", [json.loads(rec.value)["payload"]["source"].get("snapshot") for rec in snapshot], flush=True)
        check(all(json.loads(rec.value)["payload"]["op"] == "r" for rec in snapshot), "six pre-connector rows arrived as snapshot events")
        # Snapshot table order can put children before parents; confirmed DLQ plus
        # the same-coordinate redrive completes those dependencies afterward.
        dlq_reader = consumer("mysql-cdc-dlq-live-" + suffix)
        consumers.append(dlq_reader)
        replay = KafkaRuntime(consumer=dlq_reader, producer=producer(), source=source,
            tenant_map=tenants, admission=admission, topics=(dlq,), dlq_topic=dlq,
            parked_topic=parked,
            partition_factory=TopicPartition, redrive=True)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            rows = query("SELECT count(*) FROM inventory_import_state WHERE source_id=%s", (source_id,))
            if rows[0][0] == 6:
                break
            msg = replay.consumer.poll(1)
            if msg and not msg.error():
                replay.process(raw_message(msg))
        check(query("SELECT count(*) FROM inventory_import_state WHERE source_id=%s", (source_id,))[0][0] == 6,
              "snapshot admitted six tenant-scoped site/bin/device rows")
        for partner, site in (("partner-a", site_a), ("partner-b", site_b)):
            tenant = tenants[partner]
            entity = canonical_id(source_id, tenant, "site", site)
            rows = query("SELECT tenant_id::text,name FROM sites WHERE site_id=%s", (entity,))
            check(rows == [(tenant, "North")], f"snapshot site belongs only to {partner}")
        # Deliberately consume a child bin from its topic before importing the
        # already-present source site. The API must reject the missing parent,
        # and confirmed DLQ redrive must later preserve the original coordinate.
        parent_site, child_bin = "parent-" + suffix, "child-" + suffix
        mysql("INSERT INTO inventory_sites (tenant_key,site_id,name) VALUES (%s,%s,%s)",
              ("partner-a", parent_site, "Parent"), database=database)
        mysql("INSERT INTO inventory_bins (tenant_key,bin_id,site_id,name) VALUES (%s,%s,%s,%s)",
              ("partner-a", child_bin, parent_site, "Child"), database=database)
        child_consumer = consumer("mysql-cdc-child-first-" + suffix)
        consumers.append(child_consumer)
        child_runner = KafkaRuntime(consumer=child_consumer, producer=producer(), source=source,
            tenant_map=tenants, admission=admission, topics=(topics[1],), dlq_topic=dlq,
            parked_topic=parked,
            partition_factory=TopicPartition)
        child_change = await_record(child_runner, lambda rec,p: p["after"] and p["after"].get("bin_id") == child_bin)
        child_runner.process(child_change)
        child_runner.consumer.close()
        consumers.remove(child_consumer)
        child_uuid = canonical_id(source_id, tenants["partner-a"], "bin", child_bin)
        check(query("SELECT count(*) FROM inventory_import_state WHERE entity_id=%s", (child_uuid,))[0][0] == 0,
              "child before imported parent was held out of canonical inventory")
        first_dlq_child = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and first_dlq_child is None:
            message = replay.consumer.poll(1)
            if message is None:
                continue
            if message.error():
                raise RuntimeError("Kafka DLQ consume failed")
            dlq_record = raw_message(message)
            original = decode_dlq(dlq_record.value, source=source, topics=topics)
            replay.process(dlq_record)
            if (original.topic, original.partition, original.offset) == (child_change.topic, child_change.partition, child_change.offset):
                first_dlq_child = dlq_record
        check(first_dlq_child is not None and
              query("SELECT count(*) FROM inventory_import_state WHERE entity_id=%s", (child_uuid,))[0][0] == 0,
              "unresolved child confirmed to DLQ tail before parent admission")
        parent_change = await_record(runner, lambda rec,p: rec.topic == topics[0] and p["after"] and p["after"].get("site_id") == parent_site)
        runner.process(parent_change)
        deadline = time.monotonic() + 30
        requeued_child_seen = False
        while time.monotonic() < deadline and query("SELECT count(*) FROM inventory_import_state WHERE entity_id=%s", (child_uuid,))[0][0] == 0:
            msg = replay.consumer.poll(1)
            if msg and not msg.error():
                dlq_record = raw_message(msg)
                original = decode_dlq(dlq_record.value, source=source, topics=topics)
                if (original.topic, original.partition, original.offset) == (child_change.topic, child_change.partition, child_change.offset):
                    check(dlq_record.value == first_dlq_child.value and
                          ("redrive_attempt", b"1") in dlq_record.headers and
                          dlq_record.offset > first_dlq_child.offset,
                          "DLQ tail replay preserved child bytes and incremented bounded header")
                    requeued_child_seen = True
                replay.process(dlq_record)
        check(query("SELECT count(*) FROM inventory_import_state WHERE entity_id=%s", (child_uuid,))[0][0] == 1,
              "missing-parent DLQ replay admitted child using its original coordinate")
        check(requeued_child_seen, "child was admitted from requeued DLQ tail")
        # Exhaust a second child's bounded DLQ retries while its source parent
        # waits unimported. Repair mode must leave the parked offset untouched
        # until that parent has actually been admitted.
        park_parent, park_child = "park-parent-" + suffix, "park-child-" + suffix
        mysql("INSERT INTO inventory_sites (tenant_key,site_id,name) VALUES (%s,%s,%s)",
              ("partner-a", park_parent, "Repair Parent"), database=database)
        mysql("INSERT INTO inventory_bins (tenant_key,bin_id,site_id,name) VALUES (%s,%s,%s,%s)",
              ("partner-a", park_child, park_parent, "Repair Child"), database=database)
        park_source_consumer = consumer("mysql-cdc-park-child-first-" + suffix)
        consumers.append(park_source_consumer)
        park_source = KafkaRuntime(consumer=park_source_consumer, producer=producer(), source=source,
            tenant_map=tenants, admission=admission, topics=(topics[1],), dlq_topic=dlq,
            parked_topic=parked, partition_factory=TopicPartition)
        park_change = await_record(park_source, lambda rec,p: p["after"] and p["after"].get("bin_id") == park_child)
        park_source.process(park_change)
        park_source_consumer.close()
        consumers.remove(park_source_consumer)
        first_park_envelope = None
        for attempt in range(MAX_REDRIVE_REQUEUES + 1):
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                message = replay.consumer.poll(1)
                if message is None:
                    continue
                if message.error():
                    raise RuntimeError("Kafka DLQ consume failed")
                item = raw_message(message)
                original = decode_dlq(item.value, source=source, topics=topics)
                replay.process(item)
                if (original.topic, original.partition, original.offset) == (park_change.topic, park_change.partition, park_change.offset):
                    if first_park_envelope is None:
                        first_park_envelope = item.value
                    check(item.value == first_park_envelope and
                          ("redrive_attempt", str(attempt).encode()) in item.headers,
                          "bounded DLQ attempt retained original child envelope")
                    break
            else:
                raise TimeoutError("park child was not observed in DLQ")
        parked_reader = consumer("mysql-cdc-parked-live-" + suffix)
        consumers.append(parked_reader)
        repair = KafkaRuntime(consumer=parked_reader, producer=producer(), source=source,
            tenant_map=tenants, admission=admission, topics=(parked,), dlq_topic=dlq,
            parked_topic=parked, partition_factory=TopicPartition,
            redrive=True, parked_redrive=True)
        parked_record = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and parked_record is None:
            message = parked_reader.poll(1)
            if message and not message.error():
                parked_record = raw_message(message)
        check(parked_record is not None and parked_record.value == first_park_envelope and
              ("redrive_attempt", str(MAX_REDRIVE_REQUEUES).encode()) in parked_record.headers and
              ("park_reason", b"parent_dependency") in parked_record.headers,
              "exhausted child was durably parked unchanged for operator repair")
        try:
            repair.process(parked_record)
            raise AssertionError("parked repair admitted a missing parent")
        except FatalFailure as error:
            check("operator repair required" in str(error), "parked repair fails closed until parent is imported")
        parent_for_repair = await_record(runner, lambda rec,p: rec.topic == topics[0] and
                                         p["after"] and p["after"].get("site_id") == park_parent)
        runner.process(parent_for_repair)
        repair.process(parked_record)
        park_child_uuid = canonical_id(source_id, tenants["partner-a"], "bin", park_child)
        check(query("SELECT count(*) FROM inventory_import_state WHERE entity_id=%s", (park_child_uuid,))[0][0] == 1,
              "operator repair replay admitted parked child after parent")
        # Continue with binlog update and connector restart.
        mysql("UPDATE inventory_sites SET name=%s WHERE tenant_key=%s AND site_id=%s", ("North Updated", "partner-a", site_a), database=database)
        updated = await_record(runner, lambda rec,p: rec.topic == topics[0] and p["op"] == "u" and p["after"]["site_id"] == site_a)
        runner.process(updated)
        site_uuid = canonical_id(source_id, tenants["partner-a"], "site", site_a)
        check(query("SELECT name FROM sites WHERE site_id=%s", (site_uuid,))[0][0] == "North Updated", "binlog update reached canonical site")
        connector_request(f"/connectors/{connector_name}/restart?includeTasks=true", method="POST")
        wait_until(connector_running, "connector restart resumed")
        mysql("UPDATE inventory_sites SET name=%s WHERE tenant_key=%s AND site_id=%s", ("After Restart", "partner-a", site_a), database=database)
        after_restart = await_record(runner, lambda rec,p: rec.topic == topics[0] and p["op"] == "u" and p["after"]["site_id"] == site_a)
        check(after_restart.offset > updated.offset, "connector restart resumed binlog from retained offset")
        # Real API admission succeeds, then a simulated process crash prevents
        # the Kafka commit. The same source bytes replay through Task2 fencing.
        original_commit = runner.consumer.commit
        class CrashBeforeCommit:
            def __init__(self, inner): self.inner = inner
            def commit(self, **kwargs): raise RuntimeError("crash after API commit")
            def __getattr__(self, name): return getattr(self.inner, name)
        runner.consumer = CrashBeforeCommit(kafka)
        try:
            runner.process(after_restart)
            raise AssertionError("injected crash was not reached")
        except RuntimeError as error:
            check(str(error) == "crash after API commit", "crash injected after API commit before Kafka commit")
        runner.consumer = kafka
        before = query("SELECT count(*) FROM outbox_events WHERE aggregate_id=%s AND event_type='site.changed'", (site_uuid,))[0][0]
        kafka.close()
        consumers.remove(kafka)
        resumed_kafka = consumer("mysql-cdc-live-" + suffix)
        consumers.append(resumed_kafka)
        runner = KafkaRuntime(consumer=resumed_kafka, producer=producer(), source=source,
            tenant_map=tenants, admission=admission, topics=topics, dlq_topic=dlq,
            parked_topic=parked,
            partition_factory=TopicPartition)
        replayed = await_record(runner, lambda rec,p: rec.topic == after_restart.topic
                                and rec.partition == after_restart.partition and rec.offset == after_restart.offset)
        check(replayed.value == after_restart.value and replayed.key == after_restart.key,
              "new Kafka consumer received the same uncommitted source bytes")
        runner.process(replayed)
        after = query("SELECT count(*) FROM outbox_events WHERE aggregate_id=%s AND event_type='site.changed'", (site_uuid,))[0][0]
        check(before == after and query("SELECT name FROM sites WHERE site_id=%s", (site_uuid,))[0][0] == "After Restart",
              "replay used same coordinate without a second canonical event")
        stale = admission.admit(__import__('runtime').normalize_record(updated, source, tenants))
        check(stale["outcome"] == "stale", "older source offset acknowledged stale without mutation")
        mysql("DELETE FROM inventory_devices WHERE tenant_key=%s AND device_id=%s", ("partner-a", device_a), database=database)
        deleted = await_record(runner, lambda rec,p: rec.topic == topics[2] and p["op"] == "d" and p["before"]["device_id"] == device_a)
        runner.process(deleted)
        device_uuid = canonical_id(source_id, tenants["partner-a"], "device", device_a)
        check(query("SELECT status FROM devices WHERE device_id=%s", (device_uuid,))[0][0] == "deleted", "MySQL device delete became canonical soft delete")
        facility = "facility-" + suffix
        mysql("INSERT INTO inventory_sites (tenant_key,site_id,name) VALUES (%s,%s,%s)",
              ("partner-a", facility, "Keeps History"), database=database)
        created_facility = await_record(runner, lambda rec,p: rec.topic == topics[0] and p["after"] and p["after"].get("site_id") == facility)
        runner.process(created_facility)
        facility_uuid = canonical_id(source_id, tenants["partner-a"], "site", facility)
        mysql("DELETE FROM inventory_sites WHERE tenant_key=%s AND site_id=%s", ("partner-a", facility), database=database)
        deleted_facility = await_record(runner, lambda rec,p: rec.topic == topics[0] and p["op"] == "d" and p["before"]["site_id"] == facility)
        runner.process(deleted_facility)
        check(query("SELECT count(*) FROM sites WHERE site_id=%s", (facility_uuid,))[0][0] == 1,
              "facility delete quarantined without canonical deletion")
        before_poison = query("SELECT count(*) FROM inventory_import_state WHERE source_id=%s", (source_id,))[0][0]
        mysql("INSERT INTO inventory_sites (tenant_key,site_id,name) VALUES (%s,%s,%s)", ("unmapped", "bad-" + suffix, "Bad"), database=database)
        poison = await_record(runner, lambda rec,p: rec.topic == topics[0] and p["after"] and p["after"].get("tenant_key") == "unmapped")
        runner.process(poison)
        check(query("SELECT count(*) FROM inventory_import_state WHERE source_id=%s", (source_id,))[0][0] == before_poison,
              "unmapped tenant quarantined without canonical mutation")
        # RLS on the live application role refuses B's row under A's context.
        with psycopg.connect(os.environ["INVENTORY_DIRECT_URL"]) as conn, conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenants["partner-a"],))
            cur.execute("SELECT count(*) FROM sites WHERE tenant_id=%s", (tenants["partner-b"],))
            invisible = cur.fetchone()[0]
        check(invisible == 0, "PostgreSQL RLS hides tenant B from tenant A")
        print("STAGE10C_LIVE_PASS", json.dumps({"snapshot": 6, "update": True, "restart": True,
              "crash_replay": True, "stale": True, "device_delete": True,
              "facility_delete": True, "parent_dlq_redrive": True,
              "unmapped_dlq": True, "two_tenants_rls": True}), flush=True)
        succeeded = True
    finally:
        primary_failed = sys.exc_info()[0] is not None
        steps = [(f"consumer_{index}", client.close) for index, client in enumerate(consumers)]
        if harness:
            steps.append(("api_harness", lambda: stop_harness(harness)))
        preserve_failure = os.environ.get("MYSQL_CDC_PRESERVE_FAILED_FIXTURES") == "1"
        if succeeded or not preserve_failure:
            if connector_created:
                steps.append(("connector", lambda: connector_request(f"/connectors/{connector_name}", method="DELETE")))
            steps.append(("postgres_fixtures", lambda: cleanup_inventory(tenants, source_id)))
            steps.append(("kafka_topics", lambda: cleanup_topics(run_topics)))
            if database_created:
                steps.append(("mysql_database", lambda: cleanup_mysql_database(database)))
        failures = run_cleanup_steps(steps, primary_failed=primary_failed)
        if succeeded and not failures:
            print("PASS cleaned run-scoped MySQL, Kafka and PostgreSQL fixtures", flush=True)
        elif failures:
            print("CLEANUP_INCOMPLETE steps=" + ",".join(failures), file=sys.stderr, flush=True)
        elif preserve_failure and primary_failed:
            print(f"PRESERVED failed run fixtures: database={database} connector={connector_name}", flush=True)
        else:
            print("PASS cleaned failed run fixtures", flush=True)


if __name__ == "__main__":
    main()
