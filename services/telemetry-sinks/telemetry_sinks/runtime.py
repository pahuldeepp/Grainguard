"""Bounded Kafka consumer runtime shared by the ClickHouse and S3 sinks."""

from __future__ import annotations

from collections import defaultdict
import os
from pathlib import Path
import signal
import ssl
import threading
import time
from typing import Any, Callable

from .archive import ArchiveResult, S3ArchiveSink
from .clickhouse import ClickHouseSink
from .contracts import InvalidTelemetryEvent, SCHEMA_DIR, TOPICS, _load_validators, parse_record
from .health import HealthState, start_health_server


MAX_BATCH_RECORDS = 500
MAX_BATCH_BYTES = 1024 * 1024
MAX_BATCH_AGE_SECONDS = 1.0
MAX_RETRY_SECONDS = 60.0
SHUTDOWN_DRAIN_SECONDS = 20.0


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required configuration: {name}")
    return value


def _create_consumer(mode: str, consumer_factory: Callable | None = None) -> Any:
    if consumer_factory is None:
        from confluent_kafka import Consumer
        consumer_factory = Consumer
    protocol = _required("KAFKA_SECURITY_PROTOCOL").upper()
    mechanism = _required("KAFKA_SASL_MECHANISM").upper()
    ca_file = _required("KAFKA_TLS_CA_FILE")
    username = _required("KAFKA_SASL_USERNAME")
    password = _required("KAFKA_SASL_PASSWORD")
    if protocol != "SASL_SSL" or mechanism != "PLAIN":
        raise RuntimeError("telemetry sinks require Kafka SASL_SSL with PLAIN authentication")
    try:
        ssl.create_default_context(cafile=ca_file)
    except (OSError, ssl.SSLError) as error:
        raise RuntimeError("Kafka TLS CA file is missing or invalid") from error
    group_default = f"greenguard-telemetry-{mode}-v1"
    config = {
        "bootstrap.servers": _required("KAFKA_BROKERS"),
        "group.id": os.getenv("KAFKA_CONSUMER_GROUP", group_default),
        "client.id": os.getenv("HOSTNAME", f"telemetry-sinks-{mode}"),
        "enable.auto.commit": False,
        "enable.auto.offset.store": False,
        "auto.offset.reset": "earliest",
        "isolation.level": "read_committed",
        "allow.auto.create.topics": False,
        "security.protocol": protocol,
        "sasl.mechanisms": mechanism,
        "sasl.username": username,
        "sasl.password": password,
        "ssl.ca.location": ca_file,
        "enable.ssl.certificate.verification": True,
        "socket.timeout.ms": 5000,
        "socket.connection.setup.timeout.ms": 5000,
        "request.timeout.ms": 10000,
        "max.poll.interval.ms": 300000,
        "session.timeout.ms": 30000,
    }
    return consumer_factory(config)


def run(mode: str, *, consumer_factory: Callable | None = None, topic_partition_factory: Callable | None = None,
        s3_client: Any | None = None,
        clickhouse_factory: Callable[..., ClickHouseSink] = ClickHouseSink,
        stop_event: threading.Event | None = None) -> None:
    if mode not in {"clickhouse", "s3-archive"}:
        raise RuntimeError("mode must be clickhouse or s3-archive")
    stop = stop_event or threading.Event()
    state = HealthState(mode)
    server = start_health_server(state, port=int(os.getenv("HEALTH_PORT", "8080")))
    consumer = None
    sink = None
    validators = _load_validators(Path(os.getenv("EVENT_SCHEMA_DIR", str(SCHEMA_DIR))))
    try:
        if mode == "clickhouse":
            sink = clickhouse_factory(
                _required("CLICKHOUSE_URL"),
                _required("CLICKHOUSE_USER"),
                _required("CLICKHOUSE_PASSWORD"),
            )
        else:
            if s3_client is None:
                import boto3
                from botocore.config import Config
                s3_client = boto3.client("s3", region_name=_required("AWS_REGION"),
                                         config=Config(connect_timeout=5, read_timeout=20, retries={"max_attempts": 1}))
            sink = S3ArchiveSink(s3_client, _required("TELEMETRY_ARCHIVE_BUCKET"))
        _retry(lambda: sink.check(), "backend readiness check", stop, state)
        state.set_backends(backend_ready=True)
        consumer = _create_consumer(mode, consumer_factory)
        metadata = _retry(lambda: consumer.list_topics(timeout=10), "Kafka metadata check", stop, state)
        missing = sorted(set(TOPICS) - set(metadata.topics))
        if missing:
            raise RuntimeError("Kafka telemetry topics are missing: " + ", ".join(missing))
        consumer.subscribe(list(TOPICS))
        batches: dict[tuple[str, int], list] = defaultdict(list)
        batch_bytes: dict[tuple[str, int], int] = defaultdict(int)
        first_seen: dict[tuple[str, int], float] = {}
        last_backend_check = time.monotonic()
        poll_error_since = None

        def commit(next_offset: int, topic: str, partition: int) -> None:
            factory = topic_partition_factory
            if factory is None:
                from confluent_kafka import TopicPartition
                factory = TopicPartition
            topic_partition = factory(topic, partition, next_offset)
            _retry(lambda: _commit(consumer, topic_partition), "Kafka offset commit", stop, state)

        def flush(key: tuple[str, int]) -> bool:
            batch = batches.get(key, [])
            if not batch:
                return True
            records = tuple(batch)
            if mode == "clickhouse":
                count = _retry(lambda: sink.write_batch(records), "ClickHouse insert", stop, state)
                commit(records[-1].offset + 1, key[0], key[1])
                state.success(mode, key[0], count)
                consumed = len(records)
            else:
                result: ArchiveResult = _retry(lambda: sink.write_batch(records), "S3 archive write", stop, state)
                if result.commit_next_offset is None:
                    return False
                if result.consumed_count <= 0 or result.consumed_count > len(records):
                    raise RuntimeError("S3 archive returned an invalid consumed-record count")
                consumed = result.consumed_count
                commit(result.commit_next_offset, key[0], key[1])
                state.success(mode, key[0], consumed)
            del batch[:consumed]
            batch_bytes[key] = sum(len(item.raw_key) + len(item.raw_value) for item in batch)
            if batch:
                first_seen[key] = time.monotonic()
            else:
                batches.pop(key, None)
                batch_bytes.pop(key, None)
                first_seen.pop(key, None)
            return True

        while not stop.is_set():
            message = consumer.poll(0.2)
            state.heartbeat()
            if message is not None:
                error = message.error()
                if error is not None:
                    from confluent_kafka import KafkaError
                    if error.code() == KafkaError._PARTITION_EOF:
                        state.heartbeat()
                    elif error.fatal():
                        raise RuntimeError("Kafka consumer reported a fatal error")
                    else:
                        if poll_error_since is None:
                            poll_error_since = time.monotonic()
                        state.set_backends(kafka_ready=False)
                        if time.monotonic() - poll_error_since >= MAX_RETRY_SECONDS:
                            raise RuntimeError("Kafka consumer remained unhealthy past its retry budget")
                    continue
                poll_error_since = None
                record = parse_record(message.topic(), message.key(), message.value(),
                                      message.partition(), message.offset(), validators,
                                      getattr(message, "headers", lambda: None)() or [])
                key = (record.topic, record.partition)
                if not batches[key]:
                    first_seen[key] = time.monotonic()
                batches[key].append(record)
                batch_bytes[key] += len(record.raw_key) + len(record.raw_value)
                if batch_bytes[key] >= MAX_BATCH_BYTES or len(batches[key]) >= MAX_BATCH_RECORDS:
                    flush(key)
            if consumer.assignment():
                state.set_backends(kafka_ready=True)
            now = time.monotonic()
            if now - last_backend_check >= 15:
                try:
                    sink.check()
                    state.set_backends(backend_ready=True)
                except Exception:
                    state.set_backends(backend_ready=False)
                last_backend_check = now
            for key in list(batches):
                if now - first_seen.get(key, now) >= MAX_BATCH_AGE_SECONDS:
                    flush(key)

        state.mark_stopping()
        drain_deadline = time.monotonic() + SHUTDOWN_DRAIN_SECONDS
        for key in list(batches):
            if time.monotonic() >= drain_deadline:
                break
            flush(key)
    except InvalidTelemetryEvent:
        state.mark_fatal()
        raise
    except Exception:
        state.mark_fatal()
        raise
    finally:
        state.mark_stopping()
        if consumer is not None:
            try:
                consumer.close()
            finally:
                server.shutdown()
                server.server_close()
        else:
            server.shutdown()
            server.server_close()


def _commit(consumer: Any, topic_partition: Any) -> None:
    result = consumer.commit(offsets=[topic_partition], asynchronous=False)
    if result and any(getattr(item, "error", None) for item in result):
        raise RuntimeError("Kafka offset commit was rejected")


def _retry(operation: Callable[[], Any], label: str, stop: threading.Event, state: HealthState) -> Any:
    deadline = time.monotonic() + MAX_RETRY_SECONDS
    shutdown_deadline = None
    delay = 0.25
    while True:
        if stop.is_set():
            shutdown_deadline = shutdown_deadline or time.monotonic() + SHUTDOWN_DRAIN_SECONDS
            deadline = min(deadline, shutdown_deadline)
        try:
            return operation()
        except Exception as error:
            state.retry()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"{label} failed beyond the retry budget") from error
            if stop.is_set():
                time.sleep(min(delay, remaining))
            else:
                stop.wait(min(delay, remaining))
            delay = min(delay * 2, 5.0)


def install_signal_handlers(stop: threading.Event) -> None:
    def request_stop(_signum: int, _frame: Any) -> None:
        stop.set()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
