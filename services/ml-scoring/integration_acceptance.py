"""Disposable real Kafka/PostgreSQL acceptance for the local synthetic scorer.

Uses one local broker and database; this is not multi-broker or production
acceptance. Resources are isolated to one Compose project and removed in finally.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid

import psycopg
from confluent_kafka import Consumer, Producer
from ml_scoring.contracts import parse_telemetry_recorded
from ml_scoring.comparison_report import resolve_i4_comparison_report
from ml_scoring.main import SCORER_SHUTDOWN_GRACE_SECONDS, build_drift_monitors
from ml_scoring.registry import derive_model_version
from ml_scoring.store import PostgresRepository

ROOT = Path(__file__).resolve().parents[2]
SERVICE = Path(__file__).resolve().parent
COMPOSE_FILE = SERVICE / "compose.integration.yaml"
PROJECT = "greenguard-ml-scoring-it-" + uuid.uuid4().hex[:12]
TOPIC = "greenguard.telemetry.recorded.v1"
SHADOW_TOPIC = "greenguard.ml.prediction.shadow.v1"
GROUP = "ml-scoring-it-shadow"
TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
BIN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
SITE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
DEVICE_NS = uuid.UUID("aeb5738f-a373-4d31-ae46-3f69e7ea2c60")
APP_DSN = ""


def compose(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["docker", "compose", "-p", PROJECT, "-f", str(COMPOSE_FILE), *args],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        check=False, timeout=480,
    )
    if check and result.returncode:
        raise RuntimeError(f"docker compose {' '.join(args)} failed:\n{result.stdout}")
    return result


def make_event(device_id: str, sequence: int) -> tuple[bytes, bytes]:
    observed = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * sequence)
    timestamp = observed.isoformat(timespec="seconds").replace("+00:00", "Z")
    event_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"ml-scoring-it:{device_id}:{sequence}"))
    reading_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"ml-scoring-it-reading:{device_id}:{sequence}"))
    body = {
        "event_id": event_id, "event_type": "telemetry.recorded", "schema_version": 1,
        "occurred_at": timestamp, "tenant_id": TENANT,
        "aggregate_type": "device_telemetry_stream", "aggregate_id": device_id,
        "aggregate_version": str(sequence + 1),
        "correlation_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        "causation_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
        "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "payload": {
            "reading_id": reading_id, "device_id": device_id, "site_id": SITE, "bin_id": BIN,
            "binding_version": "1", "source_message_id": f"ml-scoring-it:{device_id}:{sequence}",
            "observed_at": timestamp, "received_at": timestamp,
            "measurements": {"temperature_c": 25.5, "relative_humidity_percent": 65.0},
        },
    }
    key = f"{TENANT}:{device_id}".encode()
    return key, json.dumps(body, separators=(",", ":")).encode()


def wait_for_inbox_count(expected: int, tenant: str, timeout: float = 180) -> int:
    """Wait on durable processing evidence, not Kafka CLI coordinator polling.

    The per-message commit protocol is intentionally synchronous. Querying the
    group coordinator in a tight loop while it is processing thousands of test
    records adds load and may itself be delayed while Kafka initializes its
    offsets topic. The tenant inbox is the durable proof that DB work completed.
    """
    deadline = time.monotonic() + timeout
    last_count = -1
    while time.monotonic() < deadline:
        last_count = query_as_app(
            "SELECT count(*) FROM consumer_inbox WHERE tenant_id=%s", tenant, (tenant,),
        )[0][0]
        if last_count >= expected:
            return last_count
        time.sleep(0.5)
    raise TimeoutError(f"ml-scoring durably processed {last_count}/{expected} Kafka input events")


def wait_ready(port: int, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        exit_code = process.poll()
        if exit_code is not None:
            raise RuntimeError(f"ml-scoring exited before readiness with status {exit_code}")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/readyz", timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, TimeoutError):
            time.sleep(0.25)
    raise TimeoutError("ml-scoring did not become ready")


def publish(messages: list[tuple[bytes, bytes]]) -> None:
    producer = Producer({"bootstrap.servers": f"127.0.0.1:{os.environ['ML_IT_KAFKA_PORT']}"})
    for key, value in messages:
        producer.produce(TOPIC, key=key, value=value)
        producer.poll(0)
    remaining = producer.flush(30)
    if remaining:
        raise RuntimeError(f"{remaining} Kafka messages remain undelivered")


def consume_shadow_event(timeout: float = 20.0) -> dict:
    consumer = Consumer({
        "bootstrap.servers": f"127.0.0.1:{os.environ['ML_IT_KAFKA_PORT']}",
        "group.id": f"{GROUP}-output-{uuid.uuid4()}",
        "auto.offset.reset": "earliest", "enable.auto.commit": False,
        "security.protocol": "PLAINTEXT",
    })
    consumer.subscribe([SHADOW_TOPIC])
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            message = consumer.poll(0.5)
            if message is None:
                continue
            if message.error():
                raise RuntimeError(f"shadow topic consumer failed: {message.error()}")
            value = message.value()
            if value is None:
                raise AssertionError("shadow prediction topic produced a tombstone")
            return json.loads(value)
    finally:
        consumer.close()
    raise TimeoutError("ml-scoring did not publish its transactional shadow event")


def query_as_app(sql: str, tenant: str, params: tuple = ()) -> list[tuple]:
    with psycopg.connect(APP_DSN) as connection:
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        return connection.execute(sql, params).fetchall()


def free_loopback_ports(count: int) -> tuple[int, ...]:
    listeners: list[socket.socket] = []
    try:
        for _ in range(count):
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            listeners.append(listener)
        return tuple(int(listener.getsockname()[1]) for listener in listeners)
    finally:
        for listener in listeners:
            listener.close()


def main() -> int:
    for name in ("PGHOST", "PGHOSTADDR", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE"):
        os.environ.pop(name, None)
    pg_port, kafka_port, health_port = free_loopback_ports(3)
    os.environ["ML_IT_PG_PORT"] = str(pg_port)
    os.environ["ML_IT_KAFKA_PORT"] = str(kafka_port)
    global APP_DSN
    APP_DSN = f"postgresql://ml_app:ml-scoring-it-runtime-only@127.0.0.1:{pg_port}/greenguard_ml"
    app_dsn = APP_DSN
    migrator_dsn = f"postgresql://postgres:ml-scoring-it-only@127.0.0.1:{pg_port}/greenguard_ml"
    # Keep the disposable scorer isolated from developer cloud credentials,
    # Kafka auth, and external OTLP exporters. Only pass the selected local
    # evidence report override through from the parent process.
    env = {name: os.environ[name] for name in
           ("PATH", "HOME", "LANG", "TMPDIR", "ML_I4_COMPARISON_REPORT")
           if name in os.environ}
    # Telemetry is opt-in for this destructive/disposable integration harness.
    # If requested, only allow the existing local observability profile on loopback.
    otel_endpoint = os.environ.get("ML_IT_OTEL_ENDPOINT", "").strip()
    if otel_endpoint:
        parsed_endpoint = urlsplit(otel_endpoint)
        try:
            loopback = parsed_endpoint.hostname == "localhost" or ipaddress.ip_address(
                parsed_endpoint.hostname or ""
            ).is_loopback
        except ValueError:
            loopback = False
        if (parsed_endpoint.scheme != "http" or not loopback
                or parsed_endpoint.port not in {4317, 14317}
                or parsed_endpoint.username or parsed_endpoint.password
                or parsed_endpoint.path not in {"", "/"}
                or parsed_endpoint.query or parsed_endpoint.fragment):
            raise RuntimeError("ML_IT_OTEL_ENDPOINT must be a credential-free loopback OTLP/gRPC endpoint")
        env["OTEL_EXPORTER_OTLP_ENDPOINT"] = otel_endpoint
    env.update({
        "ML_ENVIRONMENT": "local-synthetic", "ML_SHADOW_ENABLED": "true",
        "ML_ALLOW_PLAINTEXT_KAFKA": "true", "KAFKA_SECURITY_PROTOCOL": "PLAINTEXT",
        "KAFKA_BOOTSTRAP_SERVERS": f"127.0.0.1:{kafka_port}", "KAFKA_CONSUMER_GROUP": GROUP,
        "ML_SYNTHETIC_TENANT_ID": TENANT, "ML_DATABASE_URL": app_dsn,
        "ML_MODEL_NAME": "greenguard.hotspot-transition.classifier",
        "ML_MODEL_REGISTRY_ROOT": str(ROOT / "evidence" / "model-registry"),
        "PORT": str(health_port), "ML_HEALTH_BIND": "127.0.0.1",
    })
    report = json.loads(resolve_i4_comparison_report(ROOT).read_text())
    digest = report["model_artifacts"]["transformer"]["sha256"]
    env["ML_MODEL_VERSION"] = derive_model_version(digest, report["drift_reference"])
    scorer: subprocess.Popen[bytes] | None = None
    scorer_output = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
    acceptance_succeeded = False
    try:
        print(compose("up", "-d", "--wait", "--wait-timeout", "360").stdout, end="")
        subprocess.run([sys.executable, str(SERVICE / "migrate.py")], cwd=ROOT,
                       env={**env, "ML_MIGRATION_DATABASE_URL": migrator_dsn}, check=True)
        with psycopg.connect(migrator_dsn, autocommit=True) as connection:
            connection.execute("CREATE ROLE ml_app LOGIN NOBYPASSRLS PASSWORD 'ml-scoring-it-runtime-only'")
            connection.execute("GRANT CONNECT ON DATABASE greenguard_ml TO ml_app")
            connection.execute("GRANT USAGE ON SCHEMA public TO ml_app")
            connection.execute("GRANT SELECT, INSERT, DELETE ON consumer_inbox TO ml_app")
            connection.execute("GRANT SELECT, INSERT, UPDATE ON bin_window_state TO ml_app")
            connection.execute("GRANT SELECT, INSERT, DELETE ON ml_shadow_predictions TO ml_app")
            connection.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ml_shadow_outbox TO ml_app")
            connection.execute("GRANT SELECT, INSERT, UPDATE ON ml_drift_status TO ml_app")
            connection.execute("GRANT SELECT, INSERT, UPDATE ON quarantine_samples TO ml_app")
            attrs = connection.execute(
                "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='ml_app'"
            ).fetchone()
        if attrs != (False, False):
            raise AssertionError(f"unsafe ml_app role attributes: {attrs}")
        drift_repository = PostgresRepository(app_dsn)
        try:
            with drift_repository.tenant_transaction(TENANT) as transaction:
                transaction.upsert_drift_status(
                    "greenguard.hotspot-transition.classifier", "integration-v1",
                    "temperature_c", 0.31, 512,
                )
                persisted_drift = transaction.load_drift_status(
                    "greenguard.hotspot-transition.classifier", "integration-v1",
                )
            if persisted_drift != {"temperature_c": (0.31, 512)}:
                raise AssertionError(f"drift snapshot was not persisted: {persisted_drift!r}")
            monitor = build_drift_monitors(report["drift_reference"])["temperature_c"]
            observed = [report["drift_reference"]["features"]["temperature_c"]["edges"][4]] * 512
            for value in observed:
                monitor.observe(value)
            checkpoint = monitor.export_state()
            with drift_repository.tenant_transaction(TENANT) as transaction:
                transaction.upsert_drift_status(
                    "greenguard.hotspot-transition.classifier", "drift-window-v1",
                    "temperature_c", checkpoint["current_psi"], len(checkpoint["bins"]), checkpoint,
                )
                persisted_window = transaction.load_drift_window(
                    "greenguard.hotspot-transition.classifier", "drift-window-v1", "temperature_c",
                )
            if persisted_window != checkpoint:
                raise AssertionError("PostgreSQL drift window checkpoint changed during serialization")
            restarted_monitor = build_drift_monitors(report["drift_reference"])["temperature_c"]
            restarted_monitor.restore_state(persisted_window)
            continuation = [report["drift_reference"]["features"]["temperature_c"]["edges"][0],
                            report["drift_reference"]["features"]["temperature_c"]["edges"][-1]]
            for value in continuation:
                if monitor.observe(value) != restarted_monitor.observe(value):
                    raise AssertionError("restarted drift monitor diverged from uninterrupted PSI window")
            if monitor.export_state() != restarted_monitor.export_state():
                raise AssertionError("restarted drift monitor did not preserve window state")
            if query_as_app("SELECT count(*) FROM ml_drift_status", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")[0][0] != 0:
                raise AssertionError("forced RLS exposed another tenant's drift summary")
        finally:
            drift_repository.close()
        malformed_shadow_payloads = [
            {"event_id": str(uuid.uuid4()), "tenant_id": TENANT,
             "event_type": "ml.prediction.shadowed", "aggregate_type": "ml_prediction",
             "payload": {}},
            {"event_id": str(uuid.uuid4()), "tenant_id": TENANT,
             "event_type": "ml.prediction.shadowed", "aggregate_type": "ml_prediction",
             "payload": {"mode": "shadow"}},
        ]
        for malformed_payload in malformed_shadow_payloads:
            with psycopg.connect(migrator_dsn, autocommit=True) as connection:
                try:
                    connection.execute(
                        "INSERT INTO ml_shadow_outbox (tenant_id,event_id,payload) VALUES (%s,%s,%s::jsonb)",
                        (TENANT, malformed_payload["event_id"],
                         json.dumps(malformed_payload, separators=(",", ":"))),
                    )
                except psycopg.errors.CheckViolation:
                    pass
                else:
                    raise AssertionError("shadow outbox accepted a payload missing required synthetic fields")
        production_outbox_shadow_payloads = [
            {"mode": "shadow"},
            {"payload": {"mode": "shadow"}},
        ]
        for shadow_payload in production_outbox_shadow_payloads:
            with psycopg.connect(migrator_dsn, autocommit=True) as connection:
                try:
                    connection.execute(
                        """INSERT INTO outbox_events
                           (tenant_id,event_id,aggregate_id,aggregate_version,event_type,payload,traceparent)
                           VALUES (%s,%s,%s,1,'ml.prediction.shadowed',%s::jsonb,
                             '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01')""",
                        (TENANT, str(uuid.uuid4()), BIN,
                         json.dumps(shadow_payload, separators=(",", ":"))),
                    )
                except psycopg.errors.CheckViolation:
                    pass
                else:
                    raise AssertionError("production outbox accepted a shadow prediction payload")
        for table in ("ml_predictions", "outbox_events"):
            try:
                with psycopg.connect(app_dsn) as connection:
                    connection.execute("SELECT set_config('app.tenant_id', %s, true)", (TENANT,))
                    connection.execute(f"INSERT INTO {table} DEFAULT VALUES")
            except psycopg.errors.InsufficientPrivilege:
                pass
            else:
                raise AssertionError(f"runtime role can write production table {table}")
        compose("exec", "-T", "kafka", "/opt/kafka/bin/kafka-topics.sh",
                "--bootstrap-server", "kafka:29092", "--create", "--if-not-exists",
                "--topic", TOPIC, "--partitions", "1", "--replication-factor", "1")
        compose("exec", "-T", "kafka", "/opt/kafka/bin/kafka-topics.sh",
                "--bootstrap-server", "kafka:29092", "--create", "--if-not-exists",
                "--topic", SHADOW_TOPIC, "--partitions", "1", "--replication-factor", "1")
        scorer = subprocess.Popen(
            [sys.executable, "-m", "ml_scoring.main"], cwd=ROOT,
            env={**env, "PYTHONPATH": os.pathsep.join((
                str(SERVICE), str(ROOT), str(ROOT / "packages/ml-features/src"),
                str(ROOT / "packages/grain-physics/src"),
            ))}, stdout=scorer_output, stderr=subprocess.STDOUT,
        )
        wait_ready(health_port, scorer)
        devices = [str(uuid.uuid5(DEVICE_NS, str(index))) for index in range(16)]
        messages = [make_event(device, sequence) for sequence in range(24) for device in devices]
        publish(messages)
        processed_count = wait_for_inbox_count(len(messages), TENANT)

        predictions = query_as_app(
            "SELECT prediction_id, model_name, model_version, feature_set_version, status, data_origin "
            "FROM ml_shadow_predictions WHERE tenant_id=%s AND subject_id=%s",
            TENANT, (TENANT, BIN),
        )
        if (len(predictions) != 1 or predictions[0][4:] != ("shadow", "synthetic_grain_sim")
                or predictions[0][1] != env["ML_MODEL_NAME"]
                or predictions[0][2] != env["ML_MODEL_VERSION"]):
            raise AssertionError(f"unexpected model audit record: {predictions!r}")
        shadow_event = consume_shadow_event()
        if (shadow_event.get("event_type") != "ml.prediction.shadowed"
                or shadow_event.get("aggregate_type") != "ml_prediction"
                or shadow_event.get("aggregate_id") != str(predictions[0][0])
                or shadow_event.get("causation_id") != shadow_event.get("payload", {}).get("source_event_id")
                or shadow_event.get("payload", {}).get("prediction_id") != str(predictions[0][0])
                or shadow_event.get("payload", {}).get("mode") != "shadow"
                or shadow_event.get("payload", {}).get("production_eligible") is not False
                or shadow_event.get("payload", {}).get("data_origin") != "synthetic_grain_sim"):
            raise AssertionError(f"invalid shadow prediction Kafka event: {shadow_event!r}")
        outbox_deadline = time.monotonic() + 10
        outbox_state = (0, 0)
        while time.monotonic() < outbox_deadline:
            outbox_state = query_as_app(
                "SELECT count(*), count(*) FILTER (WHERE published_at IS NOT NULL) "
                "FROM ml_shadow_outbox WHERE tenant_id=%s", TENANT, (TENANT,),
            )[0]
            if outbox_state == (1, 1):
                break
            time.sleep(0.1)
        if outbox_state != (1, 1):
            raise AssertionError(f"shadow outbox was not atomically stored and published: {outbox_state!r}")
        inbox_count = query_as_app(
            "SELECT count(*) FROM consumer_inbox WHERE tenant_id=%s", TENANT, (TENANT,),
        )[0][0]
        if inbox_count != len(messages):
            raise AssertionError(f"expected {len(messages)} inbox records, got {inbox_count}")
        key, raw = messages[0]
        parsed = parse_telemetry_recorded(key, raw)
        offset_conflict = replace(
            parsed, event_id=str(uuid.uuid4()), digest=hashlib.sha256(b"different event").hexdigest(),
        )
        repository = PostgresRepository(app_dsn)
        try:
            try:
                with repository.tenant_transaction(TENANT) as transaction:
                    transaction.claim_event(offset_conflict, topic=TOPIC, partition=0, offset=0)
            except psycopg.errors.UniqueViolation:
                pass
            else:
                raise AssertionError("inbox offset uniqueness violation was suppressed")
        finally:
            repository.close()
        wrong_tenant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        if query_as_app("SELECT count(*) FROM ml_shadow_predictions", wrong_tenant)[0][0] != 0:
            raise AssertionError("forced RLS exposed another tenant's shadow prediction")
        if query_as_app("SELECT count(*) FROM ml_shadow_outbox", wrong_tenant)[0][0] != 0:
            raise AssertionError("forced RLS exposed another tenant's shadow outbox")

        # One known-new sentinel follows the full replay on the single-partition
        # input topic. Seeing it in the durable inbox proves every replay record
        # before it was consumed, without polling Kafka's slow local CLI/JVM.
        replay_sentinel = make_event(devices[0], 24)
        publish(messages + [replay_sentinel])
        replay_count = wait_for_inbox_count(len(messages) + 1, TENANT)
        if processed_count != len(messages):
            raise AssertionError(f"unexpected durable input count: {processed_count}")
        after_replay = query_as_app(
            "SELECT (SELECT count(*) FROM consumer_inbox WHERE tenant_id=%s), "
            "(SELECT count(*) FROM ml_shadow_predictions WHERE tenant_id=%s AND subject_id=%s)",
            TENANT, (TENANT, TENANT, BIN),
        )[0]
        if replay_count != len(messages) + 1 or after_replay != (len(messages) + 1, 1):
            raise AssertionError(f"replayed events changed durable results: {after_replay}")

        # Exercise real SQL retention under the runtime role. Age the published
        # pair, add an equally old but still-pending pair, and prove only published
        # rows are pruned while the pending event remains available for delivery.
        original_event = query_as_app(
            "SELECT event_id, payload FROM ml_shadow_outbox WHERE tenant_id=%s",
            TENANT, (TENANT,),
        )[0]
        old_timestamp = datetime.now(timezone.utc) - timedelta(days=31)
        pending_prediction_id, pending_event_id = str(uuid.uuid4()), str(uuid.uuid4())
        pending_payload = json.loads(json.dumps(original_event[1]))
        pending_payload["event_id"] = pending_event_id
        pending_payload["aggregate_id"] = pending_prediction_id
        pending_payload["payload"]["prediction_id"] = pending_prediction_id
        with psycopg.connect(migrator_dsn, autocommit=True) as connection:
            connection.execute(
                "UPDATE ml_shadow_outbox SET created_at=%s, published_at=%s WHERE tenant_id=%s AND event_id=%s",
                (old_timestamp, old_timestamp, TENANT, original_event[0]),
            )
            connection.execute(
                "UPDATE ml_shadow_predictions SET created_at=%s WHERE tenant_id=%s AND prediction_id=%s",
                (old_timestamp, TENANT, predictions[0][0]),
            )
            connection.execute(
                """INSERT INTO ml_shadow_predictions
                   (tenant_id,prediction_id,subject_id,window_end,model_name,model_version,
                    feature_set_version,revision,probability,feature_digest,status,data_origin,created_at)
                   SELECT tenant_id,%s,subject_id,window_end + interval '15 minutes',model_name,model_version,
                    feature_set_version,revision,probability,feature_digest,status,data_origin,%s
                   FROM ml_shadow_predictions WHERE tenant_id=%s AND prediction_id=%s""",
                (pending_prediction_id, old_timestamp, TENANT, predictions[0][0]),
            )
            connection.execute(
                """INSERT INTO ml_shadow_outbox
                   (tenant_id,event_id,payload,created_at,lease_token,lease_until)
                   VALUES (%s,%s,%s::jsonb,%s,%s,clock_timestamp() + interval '1 hour')""",
                (TENANT, pending_event_id, json.dumps(pending_payload, separators=(",", ":")),
                 old_timestamp, str(uuid.uuid4())),
            )
        repository = PostgresRepository(app_dsn)
        try:
            with repository.tenant_transaction(TENANT) as transaction:
                pruned = transaction.prune_published_shadow_rows(
                    datetime.now(timezone.utc) - timedelta(days=30),
                )
            if pruned != 1:
                raise AssertionError(f"expected one published shadow row pruned, got {pruned}")
            remaining = query_as_app(
                "SELECT event_id,published_at FROM ml_shadow_outbox WHERE tenant_id=%s",
                TENANT, (TENANT,),
            )
            remaining_predictions = query_as_app(
                "SELECT prediction_id FROM ml_shadow_predictions WHERE tenant_id=%s",
                TENANT, (TENANT,),
            )
            if remaining != [(uuid.UUID(pending_event_id), None)] \
                    or remaining_predictions != [(uuid.UUID(pending_prediction_id),)]:
                raise AssertionError(
                    "shadow retention removed a pending row or retained an expired published row: "
                    f"{remaining!r}, {remaining_predictions!r}"
                )
            with repository.tenant_transaction(TENANT) as transaction:
                if transaction.prune_published_shadow_rows(datetime.now(timezone.utc) - timedelta(days=30)) != 0:
                    raise AssertionError("shadow retention removed an unpublished outbox row")
        finally:
            repository.close()
        print(
            "PASS: Kafka -> ml-scoring -> PostgreSQL -> shadow Kafka topic: 384 input events, "
            "one audited and published shadow result, "
            "forced tenant RLS, offset-conflict fail-closed behavior, replay idempotency, sentinel ordering, "
            "and tenant-scoped bounded retention that preserves pending outbox rows"
        )
        acceptance_succeeded = True
        return 0
    finally:
        acceptance_failed = sys.exc_info()[0] is not None
        cleanup_errors: list[str] = []
        if scorer is not None:
            try:
                if scorer.poll() is None:
                    scorer.send_signal(signal.SIGTERM)
                try:
                    # Allow the same grace period configured by the deployment
                    # chart for relay, consumer, health and telemetry shutdown.
                    scorer.wait(timeout=SCORER_SHUTDOWN_GRACE_SECONDS)
                except subprocess.TimeoutExpired:
                    scorer.kill()
                    scorer.wait(timeout=5)
            except Exception as exc:
                cleanup_errors.append(f"could not stop scorer cleanly: {exc}")
        try:
            scorer_output.flush()
            scorer_output.seek(0)
            scorer_log = scorer_output.read()
        except Exception as exc:
            scorer_log = ""
            cleanup_errors.append(f"could not read scorer log: {exc}")
        try:
            logs = compose("logs", "--no-color", check=False).stdout
        except Exception as exc:
            logs = ""
            cleanup_errors.append(f"could not read Compose logs: {exc}")
        finally:
            scorer_output.close()
        try:
            teardown = compose("down", "--volumes", "--remove-orphans", check=False)
            if teardown.returncode:
                cleanup_errors.append("integration Compose teardown failed:\n" + teardown.stdout)
        except Exception as exc:
            cleanup_errors.append(f"integration Compose teardown failed: {exc}")
        if (not acceptance_succeeded or scorer is None
                or scorer.returncode not in (0, -signal.SIGTERM, 143)):
            print(scorer_log, file=sys.stderr)
            print(logs, file=sys.stderr)
        if cleanup_errors:
            for error in cleanup_errors:
                print(error, file=sys.stderr)
            if not acceptance_failed:
                raise RuntimeError("integration cleanup encountered an error")


if __name__ == "__main__":
    raise SystemExit(main())
