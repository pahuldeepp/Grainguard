"""Durable Kafka-to-EventBridge adapter for canonical alert lifecycle events."""

import hashlib
import json
import logging
import os
import re
import signal
import time
import uuid

import boto3
from confluent_kafka import Consumer, KafkaError

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


def run() -> bool:
    required = ("KAFKA_BROKERS", "EVENT_BUS_NAME", "BRIDGE_QUARANTINE_QUEUE_URL")
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError("missing required configuration: " + ", ".join(missing))
    topic = os.getenv("ALERTS_LIFECYCLE_TOPIC", "greenguard.alerts.lifecycle.v1")
    consumer = Consumer({
        "bootstrap.servers": os.environ["KAFKA_BROKERS"],
        "group.id": os.getenv("KAFKA_GROUP", "greenguard-eventbridge-bridge-v1"),
        "enable.auto.commit": False,
        "auto.offset.reset": "earliest",
        "isolation.level": "read_committed",
    })
    consumer.subscribe([topic])
    events = boto3.client("events")
    quarantine = boto3.client("sqs")
    running = True

    def stop(_signum, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while running:
            message = consumer.poll(1.0)
            if message is None:
                continue
            if message.error():
                if message.error().code() == KafkaError._PARTITION_EOF:
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
    finally:
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
