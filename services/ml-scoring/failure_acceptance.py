"""Disposable three-broker Kafka failure acceptance for the synthetic scorer.

Run with the pinned intelligence venv and the usual ml-scoring PYTHONPATH.
Starts its own unique Compose project, injects process crashes through a separate
launcher, asserts durable evidence, and removes only that project's resources.
No external URLs, existing databases, real telemetry, or cloud APIs are used.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

import psycopg
from confluent_kafka import Consumer, KafkaError, KafkaException, Producer, TopicPartition
from confluent_kafka.admin import AdminClient, ConfigResource, NewTopic
from grain_advisor_preview import BinId, RiskAssessment, TenantId, build_preview
from ml_scoring.registry import derive_model_version
from ml_scoring.comparison_report import resolve_i4_comparison_report
from risk_engine.ml_shadow import parse_shadow_prediction
from risk_engine.scoring import Assessment

ROOT = Path(__file__).resolve().parents[2]
SERVICE = Path(__file__).resolve().parent
EVIDENCE_PATH = ROOT / "evidence/intelligence/i5-multibroker-shadow-acceptance.json"
COMPOSE = SERVICE / "compose.failure-acceptance.yaml"
TOPIC = "greenguard.telemetry.recorded.v1"
OUTPUT = "greenguard.ml.prediction.shadow.v1"
TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
BIN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
DEVICES = [str(uuid.uuid5(uuid.NAMESPACE_URL, f"ml-failure-device:{i}")) for i in range(16)]
SYNTHETIC_WINDOW_END = datetime.now(timezone.utc) - timedelta(hours=1)
SYNTHETIC_WINDOW_START = SYNTHETIC_WINDOW_END - timedelta(minutes=15 * 25)


def free_ports(count: int) -> tuple[int, ...]:
    sockets: list[socket.socket] = []
    try:
        for _ in range(count):
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            sockets.append(listener)
        return tuple(listener.getsockname()[1] for listener in sockets)
    finally:
        for listener in sockets:
            listener.close()


def synthetic_event(device: str, sequence: int) -> tuple[bytes, bytes]:
    observed = SYNTHETIC_WINDOW_START + timedelta(minutes=15 * sequence)
    timestamp = observed.isoformat(timespec="seconds").replace("+00:00", "Z")
    body = {
        "event_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"ml-failure:{device}:{sequence}")),
        "event_type": "telemetry.recorded", "schema_version": 1, "occurred_at": timestamp,
        "tenant_id": TENANT, "aggregate_type": "device_telemetry_stream", "aggregate_id": device,
        "aggregate_version": str(sequence + 1),
        "correlation_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        "causation_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
        "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "payload": {
            "reading_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"ml-failure-reading:{device}:{sequence}")),
            "device_id": device, "site_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "bin_id": BIN, "binding_version": "1", "source_message_id": f"ml-failure:{device}:{sequence}",
            "observed_at": timestamp, "received_at": timestamp,
            "measurements": {"temperature_c": 25.5, "relative_humidity_percent": 65.0},
        },
    }
    return f"{TENANT}:{device}".encode(), json.dumps(body, separators=(",", ":")).encode()


def eventually(description: str, predicate, timeout: float = 180):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(0.25)
    raise TimeoutError(f"{description}: last result {last!r}")


def read_journal(path: Path) -> list[dict]:
    if not path.exists():
        return []
    # Writers fsync each record; ignore a final partial line while a child runs.
    return [json.loads(line) for line in path.read_text().splitlines(keepends=True)
            if line.endswith("\n")]


class Acceptance:
    def __init__(self, directory: Path):
        pg, *brokers = free_ports(4)
        requested_project = os.environ.get("ML_FAILURE_COMPOSE_PROJECT")
        if requested_project is not None:
            if not re.fullmatch(r"greenguard-ml-failure-ci-[a-z0-9][a-z0-9_-]{0,48}", requested_project):
                raise ValueError("ML_FAILURE_COMPOSE_PROJECT must use the isolated CI project prefix")
            self.project = requested_project
        else:
            self.project = "greenguard-ml-failure-" + uuid.uuid4().hex[:12]
        self.group = self.project + "-scorer"
        self.bootstrap = ",".join(f"127.0.0.1:{port}" for port in brokers)
        # Do not inherit AWS, Kafka, PostgreSQL, SASL, OTLP or service credentials.
        self.environment = {name: os.environ[name] for name in ("PATH", "HOME", "LANG", "TMPDIR")
                            if name in os.environ}
        if requested_project is not None:
            self.environment["ML_FAILURE_COMPOSE_PROJECT"] = requested_project
        self.environment.update({"ML_FAILURE_PG_PORT": str(pg), **{
            f"ML_FAILURE_KAFKA_{i}_PORT": str(port) for i, port in enumerate(brokers, 1)}})
        self.admin_dsn = f"postgresql://postgres:ml-failure-acceptance-admin-only@127.0.0.1:{pg}/greenguard_ml"
        self.app_dsn = f"postgresql://ml_failure_app:ml-failure-acceptance-runtime-only@127.0.0.1:{pg}/greenguard_ml"
        self.directory = directory
        self.processes: list[tuple[subprocess.Popen, object, str]] = []
        self.admin = None
        self.output_consumer = None
        self.output_events: list[dict] = []
        self.advisory_previews: list[str] = []
        self.synthetic_source_event_ids = {
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"ml-failure:{device}:{sequence}"))
            for device in DEVICES for sequence in range(26)
        }
        self.compose_started = False

    def compose(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        result = subprocess.run(["docker", "compose", "-p", self.project, "-f", str(COMPOSE), *args],
                                cwd=ROOT, env=self.environment, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=480)
        if check and result.returncode:
            raise RuntimeError(f"Compose {' '.join(args)} failed:\n{result.stdout}")
        return result

    def start(self) -> None:
        context = subprocess.run(["docker", "context", "inspect"], env=self.environment,
                                 text=True, capture_output=True, check=True, timeout=10)
        endpoint = json.loads(context.stdout)[0]["Endpoints"]["docker"]["Host"]
        if not endpoint.startswith("unix://"):
            raise RuntimeError("acceptance requires a local Docker Unix socket")
        self.compose_started = True
        print(self.compose("up", "-d", "--wait", "--wait-timeout", "360").stdout, flush=True)
        subprocess.run([sys.executable, str(SERVICE / "migrate.py")], cwd=ROOT,
                       env={**self.scorer_environment(), "ML_MIGRATION_DATABASE_URL": self.admin_dsn},
                       check=True, timeout=60)
        with psycopg.connect(self.admin_dsn, autocommit=True) as connection:
            connection.execute("CREATE ROLE ml_failure_app LOGIN NOBYPASSRLS PASSWORD 'ml-failure-acceptance-runtime-only'")
            connection.execute("GRANT CONNECT ON DATABASE greenguard_ml TO ml_failure_app")
            connection.execute("GRANT USAGE ON SCHEMA public TO ml_failure_app")
            connection.execute("GRANT SELECT, INSERT, DELETE ON consumer_inbox TO ml_failure_app")
            connection.execute("GRANT SELECT, INSERT, UPDATE ON bin_window_state TO ml_failure_app")
            connection.execute("GRANT SELECT, INSERT, DELETE ON ml_shadow_predictions TO ml_failure_app")
            connection.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ml_shadow_outbox TO ml_failure_app")
            connection.execute("GRANT SELECT, INSERT, UPDATE ON quarantine_samples, ml_drift_status TO ml_failure_app")
            assert connection.execute("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='ml_failure_app'").fetchone() == (False, False)
        self.admin = AdminClient({"bootstrap.servers": self.bootstrap, "socket.timeout.ms": 10000})
        topics = [NewTopic(topic, num_partitions=1, replica_assignment=[[1, 2, 3]],
                           config={"min.insync.replicas": "2", "unclean.leader.election.enable": "false"})
                  for topic in (TOPIC, OUTPUT)]
        for future in self.admin.create_topics(topics, operation_timeout=30).values():
            future.result(45)
        self.wait_cluster(isr=3)
        resources = [ConfigResource(ConfigResource.Type.TOPIC, topic) for topic in (TOPIC, OUTPUT)]
        def configs_ready():
            # Creation is acknowledged by the controller before every broker
            # necessarily serves the new topic's config. Retry that startup race.
            for future in self.admin.describe_configs(resources).values():
                try:
                    config = future.result(30)
                except KafkaException as exc:
                    if exc.args[0].code() == KafkaError.UNKNOWN_TOPIC_OR_PART:
                        return False
                    raise
                assert config["min.insync.replicas"].value == "2"
                assert config["unclean.leader.election.enable"].value == "false"
            return True
        eventually("topic durability configuration available on brokers", configs_ready, 60)
        self.output_consumer = Consumer({"bootstrap.servers": self.bootstrap,
                                        "group.id": self.project + "-output",
                                        "enable.auto.commit": False})
        self.output_consumer.assign([TopicPartition(OUTPUT, 0, 0)])

    def scorer_environment(self) -> dict[str, str]:
        report = json.loads(resolve_i4_comparison_report(ROOT).read_text())
        version = derive_model_version(report["model_artifacts"]["transformer"]["sha256"],
                                       report["drift_reference"])
        return {**self.environment, "PYTHONPATH": os.pathsep.join((str(SERVICE), str(ROOT),
                   str(ROOT / "packages/ml-features/src"), str(ROOT / "packages/grain-physics/src"))),
                "ML_ENVIRONMENT": "local-synthetic", "ML_SHADOW_ENABLED": "true",
                "ML_ALLOW_PLAINTEXT_KAFKA": "true", "KAFKA_SECURITY_PROTOCOL": "PLAINTEXT",
                "KAFKA_BOOTSTRAP_SERVERS": self.bootstrap, "KAFKA_CONSUMER_GROUP": self.group,
                "ML_SYNTHETIC_TENANT_ID": TENANT, "ML_DATABASE_URL": self.app_dsn,
                "ML_MODEL_NAME": "greenguard.hotspot-transition.classifier", "ML_MODEL_VERSION": version,
                "ML_MODEL_REGISTRY_ROOT": str(ROOT / "evidence/model-registry"),
                "ML_FAILURE_ACCEPTANCE_DRIVER": "disposable-local-only", "ML_HEALTH_BIND": "127.0.0.1",
                "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "PORT": str(free_ports(1)[0])}

    def launch(self, mode: str, crash_event: str = "") -> tuple[subprocess.Popen, Path]:
        journal = self.directory / f"{len(self.processes)}-{mode}.jsonl"
        log = (self.directory / f"{len(self.processes)}-{mode}.log").open("w+")
        process = subprocess.Popen([sys.executable, str(SERVICE / "failure_acceptance_driver.py"),
                                    mode, str(journal), crash_event], cwd=ROOT,
                                   env=self.scorer_environment(), stdout=log, stderr=subprocess.STDOUT)
        self.processes.append((process, log, mode))
        return process, journal

    @staticmethod
    def stop(process: subprocess.Popen) -> None:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
                raise RuntimeError("scorer exceeded shutdown bound")
        if process.returncode not in (0, 73, 74):
            raise RuntimeError(f"scorer exited unexpectedly: {process.returncode}")

    def query(self, sql: str, params: tuple = (), tenant: str = TENANT) -> list[tuple]:
        with psycopg.connect(self.app_dsn) as connection:
            connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
            return connection.execute(sql, params).fetchall()

    def snapshot(self) -> dict:
        # Relay lease/attempt/published timestamps legitimately change on retry.
        return {
            "inbox": self.query("SELECT event_id,payload_sha256,topic,partition_id,offset_id FROM consumer_inbox WHERE tenant_id=%s ORDER BY event_id", (TENANT,)),
            "window": self.query("SELECT bin_id,state,revision,last_source_event_seq FROM bin_window_state WHERE tenant_id=%s ORDER BY bin_id", (TENANT,)),
            "predictions": self.query("SELECT prediction_id,window_end,probability,feature_digest FROM ml_shadow_predictions WHERE tenant_id=%s ORDER BY prediction_id", (TENANT,)),
            "outbox": self.query("SELECT event_id,payload FROM ml_shadow_outbox WHERE tenant_id=%s ORDER BY event_id", (TENANT,)),
        }

    def inbox(self, expected: int) -> None:
        def ready():
            for process, _log, _mode in self.processes:
                if process.poll() not in (None, 0, 73, 74):
                    raise RuntimeError(f"scorer died with {process.returncode}")
            count = self.query("SELECT count(*) FROM consumer_inbox WHERE tenant_id=%s", (TENANT,))[0][0]
            assert count <= expected, (count, expected)
            return count == expected
        eventually(f"inbox reaches {expected}", ready)

    def committed_offset(self) -> int:
        consumer = Consumer({"bootstrap.servers": self.bootstrap, "group.id": self.group,
                             "enable.auto.commit": False})
        try:
            return consumer.committed([TopicPartition(TOPIC, 0)], timeout=10)[0].offset
        finally:
            consumer.close()

    def wait_committed(self, expected: int) -> None:
        eventually(f"input offset committed through {expected}", lambda: self.committed_offset() == expected)

    def publish(self, messages: list[tuple[bytes, bytes]]) -> None:
        producer = Producer({"bootstrap.servers": self.bootstrap, "acks": "all",
                             "enable.idempotence": True, "message.timeout.ms": 60000})
        errors = []
        acknowledgements = []
        def delivered(error, message):
            if error:
                errors.append(str(error))
            else:
                acknowledgements.append(message.offset())
        for key, value in messages:
            producer.produce(TOPIC, partition=0, key=key, value=value, on_delivery=delivered)
            producer.poll(0)
        remaining = producer.flush(65)
        assert not remaining and not errors and len(acknowledgements) == len(messages), (remaining, errors)

    def wait_cluster(self, *, isr: int, failed_broker: int | None = None) -> dict:
        def ready():
            try:
                metadata = self.admin.list_topics(timeout=5)
            except Exception:
                return False
            result = {}
            for topic in (TOPIC, OUTPUT):
                item = metadata.topics.get(topic)
                if not item or item.error:
                    return False
                partition = item.partitions[0]
                assert set(partition.replicas) == {1, 2, 3}
                if partition.leader < 1 or len(partition.isrs) != isr:
                    return False
                if failed_broker is not None and (partition.leader == failed_broker or failed_broker in partition.isrs):
                    return False
                result[topic] = {"leader": partition.leader, "isr": sorted(partition.isrs)}
            return result
        return eventually(f"both topics have {isr} in-sync replicas", ready, 180)

    def receive(self, expected: int, consumer: Consumer | None = None) -> list[dict]:
        target = self.output_consumer if consumer is None else consumer
        events = self.output_events if consumer is None else []
        deadline = time.monotonic() + 120
        while len(events) < expected and time.monotonic() < deadline:
            message = target.poll(0.5)
            if message is None:
                continue
            if message.error():
                if message.error().fatal():
                    raise RuntimeError(message.error())
                continue
            body = json.loads(message.value())
            assert body["tenant_id"] == TENANT and body["event_type"] == "ml.prediction.shadowed"
            assert body["payload"]["mode"] == "shadow"
            assert body["payload"]["production_eligible"] is False
            assert body["payload"]["data_origin"] == "synthetic_grain_sim"
            assert message.key().decode() == f"{TENANT}:{body['event_id']}"
            if consumer is None:
                # Exercise the live acknowledged Kafka bytes through the independent
                # Risk Engine validator and deterministic Grain Advisor preview.
                # Historical replay below checks durability only; it must not inflate
                # the count of downstream previews. This is local shadow comparison,
                # and no product risk state is written.
                parsed = parse_shadow_prediction(message.value(), expected_tenant_id=TENANT,
                                                 kafka_key=message.key())
                assert parsed.source_event_id in self.synthetic_source_event_ids
                risk = RiskAssessment(
                    TenantId(parsed.tenant_id), BinId(parsed.subject_id),
                    Assessment("wheat", 1, 50, "warning", ("synthetic_fixture_warning",), True),
                    source_event_id=parsed.source_event_id,
                )
                preview = build_preview(risk, shadow_event=body,
                                        now=datetime.now(timezone.utc),
                                        max_age=timedelta(days=1))
                assert preview.severity == "warning" and preview.deterministic_score == 50
                assert preview.label == "INFORMATIONAL · NON-ACTIONABLE · SYNTHETIC-ONLY"
                assert preview.shadow_context is not None
                assert "does not alter" in preview.shadow_context
                assert "No alert, risk state, or operational action" in preview.render()
                self.advisory_previews.append(preview.render())
            events.append(body)
        assert len(events) == expected, f"received {len(events)}/{expected} shadow records"
        return events

    def published(self, expected: int) -> None:
        eventually(f"{expected} published outbox records", lambda: self.query(
            "SELECT count(*),count(*) FILTER (WHERE published_at IS NOT NULL) FROM ml_shadow_outbox WHERE tenant_id=%s",
            (TENANT,))[0] == (expected, expected))

    def exercise(self) -> dict:
        messages = [synthetic_event(device, sequence) for sequence in range(24) for device in DEVICES]
        crash_event = json.loads(messages[0][1])["event_id"]
        process, journal = self.launch("input-crash", crash_event)
        self.publish(messages)
        assert process.wait(timeout=120) == 73
        crash_records = read_journal(journal)
        assert any(row.get("boundary") == "before_input_offset_commit" and row["offset"] == 0
                   for row in crash_records)
        self.inbox(1)
        assert self.committed_offset() < 1
        before_replay = self.snapshot()
        assert len(before_replay["inbox"]) == 1 and before_replay["window"][0][2] == 1
        restarted, replay_journal = self.launch("observe")
        self.inbox(384)
        self.wait_committed(384)
        self.receive(1)
        self.published(1)
        assert any(row.get("status") == "duplicate" and row.get("event_id") == crash_event
                   and row["offset"] == 0 for row in read_journal(replay_journal))
        snapshot = self.snapshot()
        assert len(snapshot["inbox"]) == 384 and snapshot["window"][0][2] == 384
        assert len(snapshot["predictions"]) == len(snapshot["outbox"]) == 1
        print("PASS: abrupt exit after DB commit/before input offset commit; replay observed; 384 unique effects", flush=True)

        initial = self.wait_cluster(isr=3)
        input_leader = initial[TOPIC]["leader"]
        # Replica assignment starts both topics on the same preferred leader;
        # require that fact so both input and output undergo an actual election.
        assert initial[OUTPUT]["leader"] == input_leader
        broker = f"kafka-{input_leader}"
        self.compose("stop", "--timeout", "10", broker)
        failed = self.wait_cluster(isr=2, failed_broker=input_leader)
        # All-acks input production and runtime output relay occur with one
        # broker down; two replicas still satisfy min.insync.replicas=2.
        self.publish([synthetic_event(device, 24) for device in DEVICES])
        self.inbox(400)
        self.wait_committed(400)
        self.receive(2)
        self.published(2)
        assert len({event["event_id"] for event in self.output_events}) == 2
        self.compose("start", broker)
        recovered = self.wait_cluster(isr=3)
        self.stop(restarted)
        print("PASS: both topic leaders changed; input and shadow output acknowledged with one broker down; ISR restored", flush=True)

        output_crash, output_journal = self.launch("output-crash")
        self.publish([synthetic_event(device, 25) for device in DEVICES])
        assert output_crash.wait(timeout=120) == 74
        ack = next(row for row in read_journal(output_journal)
                   if row["boundary"] == "after_output_ack_before_database_mark")
        self.receive(3)
        assert self.output_events[-1]["event_id"] == ack["event_id"]
        self.inbox(416)
        assert self.query("SELECT published_at,attempt_count FROM ml_shadow_outbox WHERE tenant_id=%s AND event_id=%s",
                          (TENANT, ack["event_id"])) == [(None, 1)]
        interrupted_snapshot = self.snapshot()
        # Use the real persisted lease and natural expiry; never repair/reset it
        # with privileged SQL, which would mask broken crash recovery.
        final_process, final_journal = self.launch("observe")
        self.wait_committed(416)
        self.receive(4)
        self.published(3)
        assert self.output_events[-1] == self.output_events[-2]
        assert self.snapshot() == interrupted_snapshot, "outbox replay changed inbox/window/prediction/event effects"
        assert self.query("SELECT attempt_count FROM ml_shadow_outbox WHERE tenant_id=%s AND event_id=%s",
                          (TENANT, ack["event_id"])) == [(2,)]
        self.stop(final_process)
        print("PASS: abrupt exit after output Kafka ack/before DB published mark; lease expired; identical event replayed; DB effects unchanged", flush=True)

        # Re-read from earliest after broker and scorer restarts: acknowledged
        # records must remain present, including both copies at the ack boundary.
        historical = Consumer({"bootstrap.servers": self.bootstrap, "group.id": self.project + "-history",
                               "enable.auto.commit": False})
        try:
            historical.assign([TopicPartition(OUTPUT, 0, 0)])
            assert self.receive(4, historical) == self.output_events
            historical.assign([TopicPartition(TOPIC, 0, 0)])
            recovered_input = []
            deadline = time.monotonic() + 60
            while len(recovered_input) < 416 and time.monotonic() < deadline:
                message = historical.poll(0.5)
                if message is not None and not message.error():
                    recovered_input.append((message.key(), message.value()))
            assert recovered_input == messages + [synthetic_event(device, sequence)
                                                  for sequence in (24, 25) for device in DEVICES]
        finally:
            historical.close()
        final = self.snapshot()
        assert final["window"][0][2] == 416
        assert len(final["inbox"]) == 416 and len(final["predictions"]) == len(final["outbox"]) == 3
        wrong_tenant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        for table in ("consumer_inbox", "bin_window_state", "ml_shadow_predictions", "ml_shadow_outbox"):
            assert self.query(f"SELECT count(*) FROM {table}", tenant=wrong_tenant) == [(0,)]
        assert {str(row[0]) for row in final["outbox"]} == {event["event_id"] for event in self.output_events}
        assert {str(row[0]) for row in final["predictions"]} == {
            event["payload"]["prediction_id"] for event in self.output_events}
        assert self.query("SELECT count(*) FROM quarantine_samples") == [(0,)]
        assert len(self.advisory_previews) == len(self.output_events) == 4
        return {"status": "pass", "local_synthetic_only": True, "broker_count": 3,
                "replication_factor": 3, "min_insync_replicas": 2,
                "leaders_before": initial, "leaders_during_outage": failed, "after_restart": recovered,
                "input_records": 416, "unique_inbox_records": 416, "window_revision": 416,
                "unique_predictions": 3, "unique_outbox_records": 3,
                "output_deliveries": 4, "unique_output_event_ids": 3,
                "risk_engine_validation_and_grain_advisor_previews": len(self.advisory_previews),
                "advisory_preview_non_actionable": True,
                "input_db_before_commit_crash_observed": True,
                "input_same_offset_replay_observed": True,
                "output_ack_before_mark_crash_observed": True,
                "output_replay_payload_identical": True, "database_effects_unchanged_on_output_replay": True,
                "input_and_output_reread_after_restart": True, "forced_rls_wrong_tenant_denied": True}

    def cleanup(self, failed: bool) -> None:
        errors = []
        for process, log, mode in self.processes:
            try:
                self.stop(process)
            except Exception as exc:
                errors.append(str(exc))
            if failed:
                log.flush()
                log.seek(0)
                print(f"Scorer {mode}:\n{log.read()[-20000:]}", file=sys.stderr)
            log.close()
        if self.output_consumer is not None:
            try:
                self.output_consumer.close()
            except Exception as exc:
                errors.append(f"output consumer close failed: {exc}")
        if self.compose_started:
            if failed:
                try:
                    print(self.compose("logs", "--no-color", "--tail", "100", check=False).stdout,
                          file=sys.stderr)
                except Exception as exc:
                    errors.append(f"could not read container diagnostics: {exc}")
            try:
                result = self.compose("down", "--volumes", "--remove-orphans", check=False)
                if result.returncode:
                    errors.append(result.stdout)
            except Exception as exc:
                errors.append(f"Compose teardown failed: {exc}")
            try:
                remaining = self.compose("ps", "-a", "-q", check=False)
                if remaining.returncode or remaining.stdout.strip():
                    errors.append("Compose containers remain after teardown: " + remaining.stdout)
                for resource in ("volume", "network"):
                    remaining = subprocess.run(
                        ["docker", resource, "ls", "--filter",
                         f"label=com.docker.compose.project={self.project}", "-q"],
                        env=self.environment, text=True, capture_output=True, timeout=30,
                    )
                    if remaining.returncode or remaining.stdout.strip():
                        errors.append(f"Compose {resource} resources remain: {remaining.stdout}")
            except Exception as exc:
                errors.append(f"could not confirm teardown: {exc}")
        if errors:
            raise RuntimeError("failure acceptance cleanup failed: " + "; ".join(errors))


def main() -> int:
    if not __debug__:
        raise RuntimeError("acceptance assertions require Python without -O")
    def terminate(_signum, _frame):
        raise KeyboardInterrupt("acceptance interrupted; cleaning up its disposable project")
    signal.signal(signal.SIGTERM, terminate)
    with tempfile.TemporaryDirectory(prefix="ml-failure-acceptance-") as temporary:
        harness = Acceptance(Path(temporary))
        failed = True
        try:
            harness.start()
            result = harness.exercise()
            failed = False
        finally:
            harness.cleanup(failed)
        result["disposable_resources_removed"] = True
        EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary_evidence = EVIDENCE_PATH.with_suffix(".json.tmp")
        temporary_evidence.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                                      encoding="utf-8")
        temporary_evidence.replace(EVIDENCE_PATH)
        print(json.dumps(result, indent=2, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
