"""Durable Kafka-to-EventBridge adapter for canonical alert lifecycle events."""

import hashlib
import json
import logging
import os
import re
import signal
import ssl
import time
import uuid
from worker_health import WorkerHealth, start_health_server

import boto3

log = logging.getLogger("eventbridge-bridge")
log.setLevel(os.getenv("LOG_LEVEL", "INFO"))
EVENT_TYPES = {
    "alert.opened",
    "alert.updated",
    "alert.acknowledged",
    "alert.escalated",
    "alert.resolved",
}
UUID_FIELDS = ("event_id", "tenant_id", "aggregate_id", "correlation_id", "causation_id")
TRACEPARENT = re.compile(r"^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$")
HEALTH = WorkerHealth()
HEALTH_SERVER = None


def ensure_health_server() -> None:
    global HEALTH_SERVER
    if HEALTH_SERVER is None:
        HEALTH_SERVER = start_health_server(HEALTH, port=int(os.getenv("HEALTH_PORT", "8080")))




def validate_event(raw: bytes) -> dict:
    event = json.loads(raw)
    if not isinstance(event, dict) or type(event.get("schema_version")) is not int or event["schema_version"] != 1:
        raise ValueError("unsupported alert event")
    event_type = event.get("event_type")
    if not isinstance(event_type, str) or event_type not in EVENT_TYPES or event.get("aggregate_type") != "alert_episode":
        raise ValueError("unsupported alert transition")
    for field in UUID_FIELDS:
        value = event.get(field)
        if not isinstance(value, str):
            raise ValueError(f"invalid {field}")
        try:
            canonical = str(uuid.UUID(value))
        except ValueError as error:
            raise ValueError(f"invalid {field}") from error
        if canonical != value:
            raise ValueError(f"invalid {field}")
    payload = event.get("payload")
    if not isinstance(payload, dict) or payload.get("episode_id") != event["aggregate_id"]:
        raise ValueError("invalid alert payload identity")
    version = event.get("aggregate_version")
    if not isinstance(version, str) or not re.fullmatch(r"[1-9][0-9]*", version):
        raise ValueError("invalid aggregate version")
    if payload.get("episode_version") != version:
        raise ValueError("event and payload versions differ")
    severity = payload.get("severity")
    if not isinstance(severity, str) or severity not in {"warning", "critical"}:
        raise ValueError("invalid alert severity")
    states = {
        "alert.opened": {"open"},
        "alert.updated": {"open", "acknowledged"},
        "alert.acknowledged": {"acknowledged"},
        "alert.escalated": {"open"},
        "alert.resolved": {"resolved"},
    }
    state = payload.get("state")
    if not isinstance(state, str) or state not in states[event_type]:
        raise ValueError("invalid alert transition state")
    if not isinstance(event.get("traceparent"), str) or not TRACEPARENT.fullmatch(event["traceparent"]):
        raise ValueError("invalid traceparent")
    return event


def _put(events, bus_name: str, detail_type: str, event: dict) -> None:
    result = events.put_events(Entries=[{
        "EventBusName": bus_name,
        "Source": "greenguard.alerts",
        "DetailType": detail_type,
        "Detail": json.dumps(event, separators=(",", ":")),
    }])
    if result.get("FailedEntryCount", 0):
        raise RuntimeError("EventBridge rejected an alert event")


def forward_record(events, quarantine, *, bus_name: str, quarantine_url: str,
                   raw: bytes, topic: str,
                   partition: int, offset: int) -> None:
    try:
        event = validate_event(raw)
        _put(events, bus_name, event["event_type"], event)
        if (event["payload"]["severity"] == "critical"
                and event["event_type"] in {"alert.opened", "alert.escalated", "alert.resolved"}):
            # This marker routes notification-producing critical transitions only. The
            # canonical detail remains unchanged; jobs-worker applies the same severity rule.
            _put(events, bus_name, "alert.critical.serverless", event)
    except (ValueError, json.JSONDecodeError) as error:
        quarantine.send_message(QueueUrl=quarantine_url, MessageBody=json.dumps({
            "topic": topic,
            "partition": partition,
            "offset": offset,
            "payload_sha256": hashlib.sha256(raw).hexdigest(),
            "reason": str(error)[:300],
        }))


def run(consumer_factory=None, kafka_error=None, aws_client=None) -> bool:
    ensure_health_server()
    HEALTH.set_ready(False)
    HEALTH.heartbeat()
    required = ("KAFKA_BROKERS", "EVENT_BUS_NAME", "BRIDGE_QUARANTINE_QUEUE_URL")
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError("missing required configuration: " + ", ".join(missing))
    topic = os.getenv("ALERTS_LIFECYCLE_TOPIC", "greenguard.alerts.lifecycle.v1")
    protocol = os.getenv("KAFKA_SECURITY_PROTOCOL", "").strip().upper()
    mechanism = os.getenv("KAFKA_SASL_MECHANISM", "").strip().upper()
    user, password, ca_file = (os.getenv(name, "") for name in
                               ("KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "KAFKA_TLS_CA_FILE"))
    required = os.getenv("KAFKA_REQUIRE_TLS", "").lower() == "true"
    security = {}
    if any((required, protocol, mechanism, user, password, ca_file)):
        if protocol != "SASL_SSL" or mechanism != "PLAIN" or not all((user, password, ca_file)):
            raise ValueError("Kafka requires SASL_SSL, PLAIN credentials, and a TLS CA file")
        ssl.create_default_context(cafile=ca_file)
        security = {"security.protocol": "SASL_SSL", "sasl.mechanism": "PLAIN",
                    "sasl.username": user, "sasl.password": password, "ssl.ca.location": ca_file,
                    "enable.ssl.certificate.verification": True}
    if consumer_factory is None or kafka_error is None:
        from confluent_kafka import Consumer, KafkaError  # imported only by the live runner
        consumer_factory, kafka_error = Consumer, KafkaError
    consumer = consumer_factory({
        "bootstrap.servers": os.environ["KAFKA_BROKERS"],
        "group.id": os.getenv("KAFKA_GROUP", "greenguard-eventbridge-bridge-v1"),
        "enable.auto.commit": False,
        "auto.offset.reset": "earliest",
        "isolation.level": "read_committed",
        **security,
    })
    consumer.subscribe([topic])
    aws_client = aws_client or boto3.client
    events = aws_client("events")
    quarantine = aws_client("sqs")
    running = True

    def stop(_signum, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while running:
            message = consumer.poll(1.0)
            HEALTH.heartbeat()
            HEALTH.set_ready(bool(consumer.assignment()))
            if message is None:
                continue
            if message.error():
                if message.error().code() == kafka_error._PARTITION_EOF:
                    continue
                raise RuntimeError(f"Kafka consume failed: {message.error()}")
            forward_record(events, quarantine,
                bus_name=os.environ["EVENT_BUS_NAME"],
                quarantine_url=os.environ["BRIDGE_QUARANTINE_QUEUE_URL"],
                raw=message.value() or b"",
                topic=message.topic(), partition=message.partition(), offset=message.offset())
            # Commit only after EventBridge accepted all applicable events or the poison
            # record was durably quarantined. A crash before this point safely replays.
            consumer.commit(message=message, asynchronous=False)
            HEALTH.heartbeat()
    finally:
        HEALTH.set_ready(False)
        consumer.close()
    return running


if __name__ == "__main__":
    while True:
        try:
            if not run():
                break
        except Exception:
            log.exception("bridge stopped; restarting consumer")
            time.sleep(2)
