"""Manual-commit Kafka importer; canonical writes go only through Device Service."""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
import signal
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Callable, Mapping

from normalize import InvalidChange, NormalizedChange, SourceConfig, normalize_change


class RetryableFailure(RuntimeError):
    """Admission or broker is unavailable; leave the Kafka offset uncommitted."""


class FatalFailure(RuntimeError):
    """Configuration/auth/assignment failure needs operator action before restart."""


class PoisonChange(RuntimeError):
    """Permanently rejected source event, to be copied byte-for-byte to DLQ."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class TenantCredential:
    client_id: str
    client_secret: str


def configured_tenants(raw: str) -> tuple[dict[str, str], dict[str, TenantCredential]]:
    """Canonicalize trusted UUIDs before they key the OAuth credential map."""
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate importer tenant configuration key")
            result[key] = value
        return result
    tenants = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(tenants, dict) or not tenants:
        raise ValueError("trusted tenant map must be nonempty")
    tenant_map: dict[str, str] = {}
    credentials: dict[str, TenantCredential] = {}
    for source_key, binding in tenants.items():
        if (not isinstance(source_key, str) or not source_key or not isinstance(binding, dict)
                or set(binding) != {"tenant_id", "client_id", "client_secret"}
                or any(not isinstance(binding[name], str) or not binding[name]
                       for name in ("tenant_id", "client_id", "client_secret"))):
            raise ValueError("trusted tenant binding is invalid")
        try:
            canonical = str(uuid.UUID(binding["tenant_id"]))
        except (ValueError, TypeError, AttributeError):
            raise ValueError("trusted tenant UUID is invalid") from None
        principal = TenantCredential(binding["client_id"], binding["client_secret"])
        if canonical in credentials and credentials[canonical] != principal:
            raise ValueError("canonical tenant aliases have conflicting importer credentials")
        tenant_map[source_key] = canonical
        credentials[canonical] = principal
    return tenant_map, credentials


@dataclass(frozen=True)
class RawRecord:
    topic: str
    partition: int
    offset: int
    key: bytes | None
    value: bytes | None
    headers: tuple[tuple[str, bytes | None], ...] = ()


REDRIVE_ATTEMPT_HEADER = "redrive_attempt"
PARK_REASON_HEADER = "park_reason"
MAX_REDRIVE_REQUEUES = 3


def raw_message(message: Any) -> RawRecord:
    return RawRecord(message.topic(), message.partition(), message.offset(),
                     message.key(), message.value(), tuple(message.headers() or ()))


def _secure_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"})):
        raise ValueError("import endpoints require HTTPS except loopback development")
    if not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("invalid import endpoint")
    return url


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise FatalFailure("import endpoint redirected")


class AdmissionClient:
    """Obtain per-tenant OAuth credentials and POST a normalized command.

    Tenant IDs and client credentials come from trusted configuration, never the
    Debezium row. The API itself verifies RS256, scope, tenant and source binding.
    """

    def __init__(self, *, api_url: str, token_url: str,
                 credentials: Mapping[str, TenantCredential], timeout_s: float = 5.0,
                 opener: Any = None, now: Callable[[], float] = time.time):
        self.api_url = _secure_url(api_url)
        self.token_url = _secure_url(token_url)
        if urllib.parse.urlsplit(api_url).path != "/v1/internal/inventory/imports":
            raise ValueError("API URL must be the inventory import command")
        if timeout_s <= 0:
            raise ValueError("HTTP timeout must be positive")
        self.credentials = dict(credentials)
        self.timeout_s = timeout_s
        self.opener = opener or urllib.request.build_opener(_NoRedirect())
        self.now = now
        self._tokens: dict[str, tuple[str, float]] = {}

    def _token(self, tenant_id: str) -> str:
        cached = self._tokens.get(tenant_id)
        if cached and cached[1] - self.now() > 30:
            return cached[0]
        credential = self.credentials.get(tenant_id)
        if credential is None:
            raise FatalFailure("tenant has no configured importer principal")
        secret = base64.b64encode(f"{credential.client_id}:{credential.client_secret}".encode()).decode()
        request = urllib.request.Request(self.token_url,
            data=urllib.parse.urlencode({"grant_type": "client_credentials", "scope": "inventory:import"}).encode(),
            headers={"Authorization": f"Basic {secret}", "Content-Type": "application/x-www-form-urlencoded"},
            method="POST")
        try:
            with self.opener.open(request, timeout=self.timeout_s) as response:
                body = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                if error.code in (400, 401, 403):
                    raise FatalFailure("OAuth client credentials were rejected") from None
                raise RetryableFailure("OAuth token endpoint unavailable") from None
            finally:
                error.close()
        except (urllib.error.URLError, TimeoutError, OSError):
            raise RetryableFailure("OAuth token endpoint unavailable") from None
        if (not isinstance(body, dict) or not isinstance(body.get("token_type"), str)
                or body["token_type"].lower() != "bearer"
                or not isinstance(body.get("access_token"), str)
                or not body["access_token"] or type(body.get("expires_in")) is not int
                or body["expires_in"] < 1):
            raise FatalFailure("OAuth token response is invalid")
        token = body["access_token"]
        self._tokens[tenant_id] = token, self.now() + body["expires_in"]
        return token

    def admit(self, change: NormalizedChange) -> dict[str, Any]:
        token = self._token(change.tenant_id)
        command = asdict(change)
        # JavaScript cannot precisely represent all signed-64-bit offsets.
        command["source_coordinate"]["offset"] = str(change.source_coordinate.offset)
        request = urllib.request.Request(self.api_url,
            data=json.dumps(command, separators=(",", ":")).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST")
        try:
            with self.opener.open(request, timeout=self.timeout_s) as response:
                if response.status != 200 and response.status != 201:
                    raise RetryableFailure("admission response status was unexpected")
                result = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                if error.code in (401, 403):
                    self._tokens.pop(change.tenant_id, None)
                    raise FatalFailure("import principal was rejected by Device Service") from None
                if error.code == 422:
                    try:
                        problem = json.load(error)
                    except (ValueError, OSError):
                        problem = {}
                    if isinstance(problem, dict) and problem.get("code") == "invalid_reference":
                        raise PoisonChange("parent_dependency") from None
                    raise PoisonChange("admission_unprocessable") from None
                if error.code in (400, 409):
                    raise PoisonChange(f"admission_http_{error.code}") from None
                raise RetryableFailure("Device Service admission unavailable") from None
            finally:
                error.close()
        except (urllib.error.URLError, TimeoutError, OSError):
            raise RetryableFailure("Device Service admission unavailable") from None
        if not isinstance(result, dict) or result.get("outcome") not in ("applied", "stale"):
            raise RetryableFailure("Device Service response is invalid")
        return result


def normalize_record(record: RawRecord, source: SourceConfig,
                     tenant_map: Mapping[str, str]) -> NormalizedChange:
    return normalize_change(source_config=source, topic=record.topic,
        partition=record.partition, offset=record.offset, key=record.key,
        value=record.value, tenant_map=tenant_map)


def dlq_envelope(record: RawRecord, *, source: SourceConfig, reason: str) -> bytes:
    # Raw bytes are preserved even for malformed, non-UTF8 or null values.
    return json.dumps({"schema_version": 1, "source_id": source.source_id,
        "connector_generation": source.connector_generation,
        "topic": record.topic, "partition": record.partition, "offset": record.offset,
        "key_base64": None if record.key is None else base64.b64encode(record.key).decode(),
        "value_base64": None if record.value is None else base64.b64encode(record.value).decode(),
        "reason": reason}, separators=(",", ":")).encode()


def decode_dlq_entry(raw: bytes, *, source: SourceConfig,
                     topics: tuple[str, ...]) -> tuple[RawRecord, str]:
    """Recover original bytes/coordinate and reason; refuse a different lineage."""
    try:
        envelope = json.loads(raw)
        keys = {"schema_version", "source_id", "connector_generation", "topic",
                "partition", "offset", "key_base64", "value_base64", "reason"}
        if (not isinstance(envelope, dict) or set(envelope) != keys
                or envelope["schema_version"] != 1 or envelope["source_id"] != source.source_id
                or envelope["connector_generation"] != source.connector_generation
                or envelope["topic"] not in topics
                or type(envelope["partition"]) is not int or envelope["partition"] < 0
                or type(envelope["offset"]) is not int or envelope["offset"] < 0
                or not isinstance(envelope["reason"], str)
                or re.fullmatch(r"[a-z][a-z0-9_]{0,63}", envelope["reason"]) is None):
            raise ValueError("DLQ envelope lineage is invalid")
        def original(value: Any) -> bytes | None:
            if value is None:
                return None
            if not isinstance(value, str):
                raise ValueError("DLQ raw bytes are invalid")
            return base64.b64decode(value, validate=True)
        record = RawRecord(envelope["topic"], envelope["partition"], envelope["offset"],
                           original(envelope["key_base64"]), original(envelope["value_base64"]))
        return record, envelope["reason"]
    except (ValueError, TypeError, KeyError, UnicodeDecodeError, binascii.Error) as error:
        raise FatalFailure("DLQ envelope is invalid or belongs to another source") from error


def decode_dlq(raw: bytes, *, source: SourceConfig, topics: tuple[str, ...]) -> RawRecord:
    """Recover original bytes/coordinate; refuse a different connector lineage."""
    record, _ = decode_dlq_entry(raw, source=source, topics=topics)
    return record


class KafkaRuntime:
    """One in-flight record; commit only after API effect or confirmed DLQ write."""

    def __init__(self, *, consumer: Any, producer: Any, source: SourceConfig,
                 tenant_map: Mapping[str, str], admission: Any, topics: tuple[str, ...],
                 dlq_topic: str, parked_topic: str, attempts: int = 3,
                 sleep: Callable[[float], None] = time.sleep,
                 running: Callable[[], bool] = lambda: True,
                 partition_factory: Callable[[str, int, int], Any] | None = None,
                 redrive: bool = False, parked_redrive: bool = False):
        if (attempts < 1 or not topics or not parked_topic or parked_topic == dlq_topic
                or parked_redrive and not redrive
                or redrive and topics != ((parked_topic,) if parked_redrive else (dlq_topic,))
                or not redrive and (dlq_topic in topics or parked_topic in topics)):
            raise ValueError("invalid importer topics or retry budget")
        self.consumer, self.producer, self.source = consumer, producer, source
        self.tenant_map, self.admission, self.topics = dict(tenant_map), admission, topics
        self.dlq_topic, self.parked_topic = dlq_topic, parked_topic
        self.attempts, self.sleep, self.running = attempts, sleep, running
        self.redrive, self.parked_redrive = redrive, parked_redrive
        self.source_topics = tuple(f"{source.topic_prefix}.{source.database}.{table}"
                                   for table in ("inventory_sites", "inventory_bins", "inventory_devices"))
        if partition_factory is None:
            from confluent_kafka import TopicPartition
            partition_factory = TopicPartition
        self.partition_factory = partition_factory
        self._assigned: set[tuple[str, int]] = set()
        self._epoch = 0
        consumer.subscribe(list(topics), on_assign=self._on_assign, on_revoke=self._on_revoke)

    def _on_assign(self, consumer: Any, partitions: list[Any]) -> None:
        self._epoch += 1
        self._assigned = {(p.topic, p.partition) for p in partitions}

    def _on_revoke(self, consumer: Any, partitions: list[Any]) -> None:
        self._epoch += 1
        self._assigned.difference_update((p.topic, p.partition) for p in partitions)

    def _assert_assignment(self, record: RawRecord, epoch: int) -> None:
        if self._epoch != epoch or (record.topic, record.partition) not in self._assigned:
            raise RetryableFailure("source partition assignment changed before commit")

    def _publish_confirmed(self, *, topic: str, key: bytes | None, value: bytes,
                           headers: list[tuple[str, bytes]], partition: int | None = None) -> None:
        # Do not enqueue another quarantine record while an earlier delivery
        # is unresolved. Otherwise a later flush could run both callbacks and
        # make this source record appear confirmed independently of its send.
        if self.producer.flush(10):
            raise RetryableFailure("previous quarantine publish is still pending")
        errors: list[Any] = []
        delivered: list[bool] = []
        def ack(error: Any, _message: Any) -> None:
            errors.append(error)
            delivered.append(True)
        kwargs: dict[str, Any] = {"key": key, "value": value, "headers": headers, "on_delivery": ack}
        if partition is not None:
            kwargs["partition"] = partition
        self.producer.produce(topic, **kwargs)
        pending = self.producer.flush(10)
        if pending or not delivered or errors[0] is not None:
            raise RetryableFailure("quarantine publish was not confirmed")

    def _publish_dlq(self, record: RawRecord, reason: str) -> None:
        self._publish_confirmed(topic=self.dlq_topic,
            key=f"{record.topic}:{record.partition}:{record.offset}".encode(),
            value=dlq_envelope(record, source=self.source, reason=reason),
            headers=[(REDRIVE_ATTEMPT_HEADER, b"0")])

    @staticmethod
    def _redrive_attempt(record: RawRecord) -> int:
        values = [value for key, value in record.headers if key == REDRIVE_ATTEMPT_HEADER]
        if not values:
            return 0  # pre-header v1 DLQ records remain redrivable
        if len(values) != 1 or not isinstance(values[0], bytes):
            raise FatalFailure("DLQ redrive attempt header is invalid")
        raw = values[0]
        if not raw or len(raw) > 2 or not raw.isdigit() or (len(raw) > 1 and raw.startswith(b"0")):
            raise FatalFailure("DLQ redrive attempt header is invalid")
        attempt = int(raw)
        if attempt > MAX_REDRIVE_REQUEUES:
            raise FatalFailure("DLQ redrive attempt exceeds configured limit")
        return attempt

    def _requeue_parent_dependency(self, record: RawRecord) -> None:
        attempt = self._redrive_attempt(record)
        if attempt >= MAX_REDRIVE_REQUEUES:
            # A separate, indefinitely retained needs-repair topic removes
            # the head-of-line blocker only after a confirmed durable write.
            self._publish_confirmed(topic=self.parked_topic, key=record.key, value=record.value,
                headers=[(REDRIVE_ATTEMPT_HEADER, str(attempt).encode()),
                         (PARK_REASON_HEADER, b"parent_dependency")],
                partition=record.partition)
            print(f"PARKED parent_dependency redrive_attempt={attempt}; operator repair required", flush=True)
            return
        # The exact v1 envelope and raw source bytes remain unchanged. A
        # confirmed append to this same partition puts the child after a
        # parent already waiting behind it in the DLQ.
        self._publish_confirmed(topic=self.dlq_topic, key=record.key, value=record.value,
            headers=[(REDRIVE_ATTEMPT_HEADER, str(attempt + 1).encode())],
            partition=record.partition)

    def _park_dlq_record(self, record: RawRecord, reason: str) -> None:
        """Move non-replayable poison aside before parsing/admission can mutate it."""
        attempt = self._redrive_attempt(record)
        self._publish_confirmed(topic=self.parked_topic, key=record.key, value=record.value,
            headers=[(REDRIVE_ATTEMPT_HEADER, str(attempt).encode()),
                     (PARK_REASON_HEADER, reason.encode("ascii"))],
            partition=record.partition)
        print(f"PARKED {reason}; operator repair required", flush=True)

    @staticmethod
    def _park_reason(record: RawRecord, envelope_reason: str) -> None:
        values = [value for key, value in record.headers if key == PARK_REASON_HEADER]
        if (re.fullmatch(r"[a-z][a-z0-9_]{0,63}", envelope_reason) is None
                or len(values) != 1 or not isinstance(values[0], bytes)
                or values[0] != envelope_reason.encode("ascii")):
            raise FatalFailure("parked record reason header does not match its envelope")

    def _admit_with_retry(self, change: NormalizedChange) -> None:
        for attempt in range(self.attempts):
            try:
                self.admission.admit(change)
                return
            except PoisonChange as error:
                if error.reason != "parent_dependency" or attempt + 1 == self.attempts:
                    raise
                if not self.running():
                    raise RetryableFailure("import shutdown during parent wait") from None
                self.sleep(min(0.25 * (2 ** attempt), 2.0))
            except RetryableFailure:
                if attempt + 1 == self.attempts or not self.running():
                    raise
                self.sleep(min(0.25 * (2 ** attempt), 2.0))
        raise AssertionError("retry loop exhausted")

    def process(self, record: RawRecord) -> None:
        epoch = self._epoch
        self._assert_assignment(record, epoch)
        if self.redrive:
            if record.value is None:
                raise FatalFailure("DLQ record has no envelope")
            self._redrive_attempt(record)
            original, reason = decode_dlq_entry(record.value, source=self.source, topics=self.source_topics)
            if self.parked_redrive:
                self._park_reason(record, reason)
            elif reason != "parent_dependency":
                self._park_dlq_record(record, reason)
                original = None
            if original is None:
                pass  # Confirmed park is the terminal disposition for this DLQ record.
            else:
                try:
                    change = normalize_record(original, self.source, self.tenant_map)
                except InvalidChange as error:
                    raise FatalFailure("DLQ change still fails normalization") from error
                try:
                    self._admit_with_retry(change)
                except PoisonChange as error:
                    if error.reason != "parent_dependency":
                        raise FatalFailure("DLQ change still fails admission") from error
                    if self.parked_redrive:
                        raise FatalFailure("parked parent dependency remains unresolved; operator repair required") from error
                    self._requeue_parent_dependency(record)
        else:
            try:
                change = normalize_record(record, self.source, self.tenant_map)
                self._admit_with_retry(change)
            except InvalidChange:
                self._publish_dlq(record, "normalization_invalid")
            except PoisonChange as error:
                self._publish_dlq(record, error.reason)
        # A failed API call, token/auth fault, DLQ write or shutdown leaves the
        # source offset untouched. A replay after API commit is fenced by Task2.
        self._assert_assignment(record, epoch)
        if not self.running():
            return
        result = self.consumer.commit(
            offsets=[self.partition_factory(record.topic, record.partition, record.offset + 1)],
            asynchronous=False)
        if not result or any(getattr(item, "error", None) for item in result):
            raise RetryableFailure("Kafka offset commit failed")
        self._assert_assignment(record, epoch)

    def run(self) -> None:
        try:
            while self.running():
                message = self.consumer.poll(1.0)
                if message is None:
                    continue
                if message.error():
                    raise RetryableFailure("Kafka poll failed")
                record = raw_message(message)
                self.process(record)
        finally:
            self.consumer.close()


def main() -> None:
    from confluent_kafka import Consumer, Producer
    required = ("MYSQL_CDC_KAFKA_BROKERS", "MYSQL_CDC_GROUP", "MYSQL_CDC_TOPIC_PREFIX",
                "MYSQL_CDC_DATABASE", "MYSQL_CDC_CONNECTOR_NAME", "MYSQL_CDC_GENERATION",
                "MYSQL_CDC_SOURCE_ID", "MYSQL_CDC_DLQ_TOPIC", "MYSQL_CDC_PARKED_TOPIC",
                "MYSQL_CDC_TENANTS_JSON",
                "MYSQL_CDC_API_URL", "MYSQL_CDC_TOKEN_URL")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise ValueError("missing importer configuration: " + ", ".join(missing))
    source = SourceConfig(os.environ["MYSQL_CDC_SOURCE_ID"], os.environ["MYSQL_CDC_GENERATION"],
        os.environ["MYSQL_CDC_CONNECTOR_NAME"], os.environ["MYSQL_CDC_DATABASE"],
        os.environ["MYSQL_CDC_TOPIC_PREFIX"])
    tenant_map, credentials = configured_tenants(os.environ["MYSQL_CDC_TENANTS_JSON"])
    topics = tuple(f"{source.topic_prefix}.{source.database}.{table}"
                   for table in ("inventory_sites", "inventory_bins", "inventory_devices"))
    offset_reset = os.environ.get("MYSQL_CDC_OFFSET_RESET", "error")
    if offset_reset not in ("error", "earliest"):
        raise ValueError("offset reset must be error or explicit earliest")
    mode = os.environ.get("MYSQL_CDC_MODE", "ingest")
    if mode not in ("ingest", "redrive", "parked-redrive"):
        raise ValueError("import mode must be ingest, redrive or parked-redrive")
    subscription = ((os.environ["MYSQL_CDC_PARKED_TOPIC"],) if mode == "parked-redrive" else
                    (os.environ["MYSQL_CDC_DLQ_TOPIC"],) if mode == "redrive" else topics)
    group = os.environ["MYSQL_CDC_GROUP"] + ("-parked-redrive" if mode == "parked-redrive" else
                                        "-redrive" if mode == "redrive" else "")
    consumer = Consumer({"bootstrap.servers": os.environ["MYSQL_CDC_KAFKA_BROKERS"],
        "group.id": group, "enable.auto.commit": False,
        "enable.auto.offset.store": False, "auto.offset.reset": offset_reset,
        "isolation.level": "read_committed"})
    producer = Producer({"bootstrap.servers": os.environ["MYSQL_CDC_KAFKA_BROKERS"],
                         "enable.idempotence": True, "acks": "all"})
    admission = AdmissionClient(api_url=os.environ["MYSQL_CDC_API_URL"],
        token_url=os.environ["MYSQL_CDC_TOKEN_URL"], credentials=credentials)
    running = True
    def stop(_signum: int, _frame: Any) -> None:
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    KafkaRuntime(consumer=consumer, producer=producer, source=source,
        tenant_map=tenant_map, admission=admission, topics=subscription,
        dlq_topic=os.environ["MYSQL_CDC_DLQ_TOPIC"],
        parked_topic=os.environ["MYSQL_CDC_PARKED_TOPIC"], running=lambda: running,
        redrive=(mode != "ingest"), parked_redrive=(mode == "parked-redrive")).run()


if __name__ == "__main__":
    main()
