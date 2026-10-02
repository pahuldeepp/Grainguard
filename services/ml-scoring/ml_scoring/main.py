"""Explicitly opt-in, synthetic-only Kafka shadow scorer runtime."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import logging
import os
import signal
import socket
import threading
import hashlib
import ipaddress
import time
from urllib.parse import urlsplit

from confluent_kafka import Consumer, KafkaError, KafkaException, Producer
from opentelemetry._logs import SeverityNumber
from opentelemetry.context import get_current
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.trace import Status, StatusCode, Tracer
from opentelemetry.metrics import Meter, Observation

from ml_scoring.processor import (BinDeviceLimitExceeded, INPUT_TOPIC, ProcessResult,
                                  ShadowScoringProcessor)
from ml_scoring.contracts import (ContractError, TelemetryEvent,
                                  parse_canonical_uuid, parse_telemetry_recorded)
from ml_scoring.deployment import RollingPSIMonitor
from ml_scoring.local_guard import (validate_cluster_synthetic_postgres_dsn,
                                   validate_local_postgres_dsn)
from ml_scoring.outbox import (
    DB_OPERATION_TIMEOUT_SECONDS,
    DELIVERY_TIMEOUT_SECONDS,
    FatalKafkaProducerError,
    publish_pending_once,
)
from ml_scoring.registry import ModelRegistry
from ml_scoring.store import DuplicateEventConflict, PostgresRepository


LOG = logging.getLogger("greenguard.ml_scoring")
READY = threading.Event()
STOP = threading.Event()
OTEL_EXPORT_TIMEOUT_SECONDS = 2
RELAY_FINAL_FLUSH_SECONDS = 5
SCORER_SHUTDOWN_GRACE_SECONDS = 90
RELAY_SHUTDOWN_TIMEOUT_SECONDS = int(
    DELIVERY_TIMEOUT_SECONDS + DB_OPERATION_TIMEOUT_SECONDS * 2
    + RELAY_FINAL_FLUSH_SECONDS + 5
)


class OpenTelemetryLoggingHandler(logging.Handler):
    """Export standard logs with trace context and bounded, non-tenant metadata."""

    _SEVERITY = (
        (logging.CRITICAL, SeverityNumber.FATAL),
        (logging.ERROR, SeverityNumber.ERROR),
        (logging.WARNING, SeverityNumber.WARN),
        (logging.INFO, SeverityNumber.INFO),
        (logging.DEBUG, SeverityNumber.DEBUG),
    )

    def __init__(self, logger_provider: LoggerProvider):
        super().__init__(level=logging.NOTSET)
        self.addFilter(_ExcludeOpenTelemetryInternalLogs())
        self._otel_logger = logger_provider.get_logger("greenguard.ml_scoring")

    def emit(self, record: logging.LogRecord) -> None:
        try:
            severity = next((number for minimum, number in self._SEVERITY
                             if record.levelno >= minimum), SeverityNumber.TRACE)
            exception = record.exc_info[1] if record.exc_info else None
            self._otel_logger.emit(
                timestamp=int(record.created * 1_000_000_000),
                observed_timestamp=time.time_ns(),
                context=get_current(),
                severity_number=severity,
                severity_text=record.levelname,
                body=record.getMessage(),
                attributes={
                    "code.filepath": record.pathname,
                    "code.function.name": record.funcName,
                    "code.lineno": record.lineno,
                    "logger.name": record.name,
                },
                exception=exception,
            )
        except Exception:
            self.handleError(record)


class _ExcludeOpenTelemetryInternalLogs(logging.Filter):
    """Prevent the exporter SDK from recursively exporting its own logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        return record.name != "opentelemetry" and not record.name.startswith("opentelemetry.")


_LOCAL_POSTGRES_HOSTS = {"localhost", "127.0.0.1", "::1"}
_LOCAL_KAFKA_HOSTS = {"localhost", "127.0.0.1", "::1"}
_CLUSTER_SYNTHETIC_DNS_SUFFIX = ".ml-synthetic.svc.cluster.local"


def validate_local_endpoints(database_url: str, brokers: str) -> None:
    try:
        validate_local_postgres_dsn(database_url, allowed_hosts=_LOCAL_POSTGRES_HOSTS,
                                    database_name="greenguard_ml")
    except ValueError as exc:
        raise RuntimeError("synthetic scorer database must be local PostgreSQL named greenguard_ml") from exc
    endpoints = [item.strip() for item in brokers.split(",") if item.strip()]
    if not endpoints:
        raise RuntimeError("at least one local Kafka bootstrap endpoint is required")
    for endpoint in endpoints:
        try:
            parsed = urlsplit(f"//{endpoint}")
            valid_port = parsed.port is not None and 1 <= parsed.port <= 65535
        except ValueError:
            valid_port = False
            parsed = urlsplit("//invalid")
        if parsed.hostname not in _LOCAL_KAFKA_HOSTS or not valid_port:
            raise RuntimeError("synthetic scorer Kafka brokers must be local host:port endpoints")


def validate_local_kafka_metadata(metadata: object) -> None:
    brokers = getattr(metadata, "brokers", None)
    hosts = [getattr(broker, "host", "") for broker in brokers.values()] if brokers else []
    if not hosts or any(host.lower().rstrip(".") not in _LOCAL_KAFKA_HOSTS for host in hosts):
        raise RuntimeError("Kafka metadata advertised a non-local or empty broker set")


def validate_cluster_synthetic_endpoints(database_url: str, brokers: str) -> None:
    """Restrict the opt-in cluster profile to one isolated K8s namespace."""
    try:
        validate_cluster_synthetic_postgres_dsn(database_url)
    except ValueError as exc:
        raise RuntimeError("cluster-synthetic PostgreSQL must be its verified-TLS in-namespace service") from exc
    endpoints = [item.strip() for item in brokers.split(",") if item.strip()]
    if not endpoints:
        raise RuntimeError("at least one cluster-synthetic Kafka bootstrap endpoint is required")
    for endpoint in endpoints:
        try:
            parsed = urlsplit(f"//{endpoint}")
            host, port = parsed.hostname or "", parsed.port
            try:
                ipaddress.ip_address(host)
                is_ip_address = True
            except ValueError:
                is_ip_address = False
        except ValueError:
            host, port, is_ip_address = "", None, False
        if (is_ip_address or not host.lower().endswith(_CLUSTER_SYNTHETIC_DNS_SUFFIX)
                or port != 9093):
            raise RuntimeError("cluster-synthetic Kafka must use port 9093 in the ml-synthetic namespace")


def validate_cluster_synthetic_kafka_metadata(metadata: object) -> None:
    brokers = getattr(metadata, "brokers", None)
    values = list(brokers.values()) if brokers else []
    if not values:
        raise RuntimeError("Kafka metadata advertised an empty cluster-synthetic broker set")
    for broker in values:
        host = str(getattr(broker, "host", "")).lower().rstrip(".")
        port = getattr(broker, "port", None)
        try:
            ipaddress.ip_address(host)
            is_ip_address = True
        except ValueError:
            is_ip_address = False
        if (is_ip_address or not host.endswith(_CLUSTER_SYNTHETIC_DNS_SUFFIX)
                or port != 9093):
            raise RuntimeError("Kafka metadata advertised a broker outside the ml-synthetic namespace")


def validate_cluster_synthetic_kafka_security(*, protocol: str, mechanism: str,
                                               username: str, password: str,
                                               ca_location: str) -> None:
    if (protocol != "SASL_SSL" or mechanism != "SCRAM-SHA-512"
            or not username or not password or not ca_location
            or not os.path.isfile(ca_location)):
        raise RuntimeError("cluster-synthetic Kafka requires SASL_SSL SCRAM-SHA-512 and a mounted CA")


def record_input_quality(event: TelemetryEvent, result: str, *, labels: dict[str, str],
                         temperature: object, humidity: object, missing: object,
                         drift_monitors: dict[str, RollingPSIMonitor] | None = None) -> list[tuple[str, float]]:
    """Export low-cardinality telemetry distributions, excluding tenant identity."""
    if result not in {"awaiting_bin_grid", "insufficient_history", "shadow_scored",
                      "shadow_prediction_exists"}:
        return []
    drift_values: list[tuple[str, float]] = []
    if event.temperature_c is None:
        missing.add(1, {"feature": "temperature_c", **labels})
    else:
        temperature.record(event.temperature_c, labels)
        if drift_monitors is not None:
            psi_value = drift_monitors["temperature_c"].observe(event.temperature_c)
            if psi_value is not None:
                drift_values.append(("temperature_c", psi_value))
    if event.relative_humidity_percent is None:
        missing.add(1, {"feature": "relative_humidity_percent", **labels})
    else:
        humidity.record(event.relative_humidity_percent, labels)
        if drift_monitors is not None:
            psi_value = drift_monitors["relative_humidity_percent"].observe(
                event.relative_humidity_percent,
            )
            if psi_value is not None:
                drift_values.append(("relative_humidity_percent", psi_value))
    return drift_values


def build_drift_monitors(reference: dict[str, object]) -> dict[str, RollingPSIMonitor]:
    features = reference["features"]
    assert isinstance(features, dict)
    settings = (reference["minimum_samples"], reference["window_size"], reference["update_every"])
    return {
        name: RollingPSIMonitor(edges=feature["edges"],
                                reference_proportions=feature["reference_proportions"],
                                minimum_samples=settings[0], window_size=settings[1],
                                update_every=settings[2])
        for name, feature in features.items()
    }


def register_psi_gauge(meter: Meter, latest_psi: dict[tuple[str, str, str, str], float],
                       lock: threading.Lock) -> object:
    """Expose current PSI values as an OTel asynchronous gauge."""
    def observe(_options: object) -> list[Observation]:
        with lock:
            return [Observation(value, {"feature": feature, "model.name": model_name,
                                        "model.version": model_version, "mode": mode})
                    for (feature, model_name, model_version, mode), value in latest_psi.items()]

    return meter.create_observable_gauge(
        "ml_scoring_input_feature_psi", callbacks=[observe], unit="{psi}",
    )


def commit_offset_after_processing(consumer: Consumer, message: object) -> bool:
    """Commit DB-complete work; a rebalance failure safely replays via inbox."""
    try:
        consumer.commit(message=message, asynchronous=False)
        return True
    except KafkaException as exc:
        error = exc.args[0] if exc.args else None
        if error is not None and error.fatal():
            raise
        LOG.warning("offset commit failed; event will replay through consumer_inbox: %s", exc)
        return False


def _outbox_producer_config(consumer_config: dict[str, object]) -> dict[str, object]:
    allowed = {"bootstrap.servers", "security.protocol", "sasl.mechanism", "sasl.username",
               "sasl.password", "ssl.ca.location", "socket.timeout.ms",
               "socket.connection.setup.timeout.ms", "request.timeout.ms"}
    config = {key: value for key, value in consumer_config.items() if key in allowed}
    config.update({"client.id": f"{consumer_config['client.id']}-shadow-outbox",
                   "enable.idempotence": True, "acks": "all",
                   "message.timeout.ms": int(DELIVERY_TIMEOUT_SECONDS * 1000)})
    return config


def _run_outbox_relay(repository: PostgresRepository, producer: Producer,
                      tenant_id: str, stop: threading.Event,
                      published: object, failures: object,
                      labels: dict[str, str], relay_failed: threading.Event,
                      relay_degraded: threading.Event) -> None:
    consecutive_failures = 0
    try:
        while not stop.is_set():
            count = 0
            try:
                count = publish_pending_once(repository, producer, tenant_id, stop=stop)
                consecutive_failures = 0
                relay_degraded.clear()
                if count:
                    published.add(count, labels)
            except FatalKafkaProducerError:
                relay_failed.set()
                stop.set()
                failures.add(1, labels)
                LOG.exception("shadow outbox Kafka producer is fatal; stopping relay")
                raise
            except Exception:
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    relay_degraded.set()
                failures.add(1, labels)
                LOG.exception("shadow prediction outbox relay failed; rows remain retryable")
            if count == 0:
                stop.wait(0.5)
    except BaseException:
        relay_failed.set()
        stop.set()
        LOG.exception("shadow prediction outbox relay stopped unexpectedly")
        raise
    finally:
        try:
            remaining = producer.flush(RELAY_FINAL_FLUSH_SECONDS)
            if remaining:
                relay_failed.set()
                LOG.error("shadow prediction outbox relay stopped with %d Kafka records pending", remaining)
        except Exception:
            relay_failed.set()
            LOG.exception("shadow prediction outbox producer failed to flush during shutdown")


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _shutdown_provider_bounded(provider: object, name: str, timeout_seconds: float = 2.0,
                               **kwargs: object) -> bool:
    """Run SDK shutdown behind a hard caller deadline; SDK batches default to 30s."""
    errors: list[BaseException] = []

    def shutdown() -> None:
        try:
            provider.shutdown(**kwargs)  # type: ignore[attr-defined]
        except Exception as error:
            errors.append(error)

    worker = threading.Thread(target=shutdown, name=f"{name}-shutdown", daemon=True)
    worker.start()
    worker.join(timeout=timeout_seconds)
    if worker.is_alive():
        LOG.error("%s telemetry shutdown exceeded %.1fs; abandoning final export", name,
                  timeout_seconds)
        return False
    if errors:
        LOG.error("%s telemetry shutdown failed: %s", name, errors[0])
        return False
    return True


def _telemetry() -> tuple[Tracer, Meter, MeterProvider, TracerProvider, LoggerProvider,
                          logging.Handler | None]:
    resource = Resource.create({"service.name": "ml-scoring", "service.version": "0.1.0"})
    tracer_provider = TracerProvider(resource=resource)
    logger_provider = LoggerProvider(resource=resource)
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    metric_readers = []
    log_handler = None
    if endpoint:
        from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        timeout = OTEL_EXPORT_TIMEOUT_SECONDS
        tracer_provider.add_span_processor(BatchSpanProcessor(
            OTLPSpanExporter(endpoint=endpoint, timeout=timeout),
            export_timeout_millis=timeout * 1000,
        ))
        metric_readers.append(PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=endpoint, timeout=timeout),
            export_timeout_millis=timeout * 1000,
        ))
        logger_provider.add_log_record_processor(BatchLogRecordProcessor(
            OTLPLogExporter(endpoint=endpoint, timeout=timeout),
            export_timeout_millis=timeout * 1000,
        ))
        # Bridge the service's existing stdlib logs so operational failures and
        # lifecycle events reach the same collector as traces and metrics.
        log_handler = OpenTelemetryLoggingHandler(logger_provider)
        logging.getLogger().addHandler(log_handler)
    meter_provider = MeterProvider(resource=resource, metric_readers=metric_readers)
    trace.set_tracer_provider(tracer_provider)
    metrics.set_meter_provider(meter_provider)
    return (trace.get_tracer("greenguard.ml_scoring"), metrics.get_meter("greenguard.ml_scoring"),
            meter_provider, tracer_provider, logger_provider, log_handler)


def _readiness_is_healthy(repository: PostgresRepository, gate: threading.BoundedSemaphore,
                          relay_failed: threading.Event | None = None,
                          relay_degraded: threading.Event | None = None) -> bool:
    if not READY.is_set() or not gate.acquire(blocking=False):
        return False
    try:
        if ((relay_failed is not None and relay_failed.is_set())
                or (relay_degraded is not None and relay_degraded.is_set())):
            return False
        return repository.ping()
    except Exception:
        LOG.exception("readiness database check failed")
        return False
    finally:
        gate.release()


def _health_server(repository: PostgresRepository, port: int, host: str = "127.0.0.1",
                   relay_failed: threading.Event | None = None,
                   relay_degraded: threading.Event | None = None) -> ThreadingHTTPServer:
    readiness_gate = threading.BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        timeout = 5

        def do_GET(self) -> None:
            if self.path == "/livez":
                self.send_response(200)
                payload = b'{"status":"alive"}'
            elif self.path == "/readyz":
                healthy = _readiness_is_healthy(
                    repository, readiness_gate, relay_failed, relay_degraded,
                )
                self.send_response(200 if healthy else 503)
                payload = b'{"status":"ready"}' if healthy else b'{"status":"not_ready"}'
            else:
                self.send_response(404)
                payload = b'{"error":"not_found"}'
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, fmt: str, *args: object) -> None:
            LOG.info("health %s", fmt % args)

    class HealthServer(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in host else socket.AF_INET
        daemon_threads = True
        block_on_close = False

    if host not in {"127.0.0.1", "::1", "localhost"} and (
            os.environ.get("ML_ENVIRONMENT") != "cluster-synthetic"
            or os.environ.get("ML_ALLOW_REMOTE_HEALTH_BIND") != "true"):
        raise RuntimeError("remote health bind is allowed only in the explicit cluster-synthetic profile")
    server = HealthServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, name="health-server", daemon=True).start()
    return server


def run() -> None:
    environment = os.environ.get("ML_ENVIRONMENT")
    if environment not in {"local-synthetic", "cluster-synthetic"}:
        raise RuntimeError("this prototype may run only with ML_ENVIRONMENT=local-synthetic or cluster-synthetic")
    if os.environ.get("ML_SHADOW_ENABLED") != "true":
        raise RuntimeError("scoring is disabled; set ML_SHADOW_ENABLED=true only for an isolated synthetic environment")
    try:
        synthetic_tenant = parse_canonical_uuid(
            _required("ML_SYNTHETIC_TENANT_ID"), "ML_SYNTHETIC_TENANT_ID",
        )
    except ContractError as exc:
        raise RuntimeError("ML_SYNTHETIC_TENANT_ID must be a canonical lowercase UUID") from exc
    model_name, model_version = _required("ML_MODEL_NAME"), _required("ML_MODEL_VERSION")
    database_url = _required("ML_DATABASE_URL")
    brokers = _required("KAFKA_BOOTSTRAP_SERVERS")
    if environment == "local-synthetic":
        validate_local_endpoints(database_url, brokers)
    else:
        validate_cluster_synthetic_endpoints(database_url, brokers)
    registry = ModelRegistry(_required("ML_MODEL_REGISTRY_ROOT"), allow_synthetic_shadow=True)
    model = registry.load(model_name, model_version)
    security_protocol = os.environ.get("KAFKA_SECURITY_PROTOCOL", "SSL")
    if security_protocol not in {"SSL", "SASL_SSL", "PLAINTEXT"}:
        raise RuntimeError("KAFKA_SECURITY_PROTOCOL must be SSL, SASL_SSL, or PLAINTEXT")
    if environment == "cluster-synthetic":
        validate_cluster_synthetic_kafka_security(
            protocol=security_protocol,
            mechanism=os.environ.get("KAFKA_SASL_MECHANISM", ""),
            username=os.environ.get("KAFKA_SASL_USERNAME", ""),
            password=os.environ.get("KAFKA_SASL_PASSWORD", ""),
            ca_location=os.environ.get("KAFKA_SSL_CA_LOCATION", ""),
        )
    if security_protocol == "PLAINTEXT" and os.environ.get("ML_ALLOW_PLAINTEXT_KAFKA") != "true":
        raise RuntimeError("plaintext Kafka requires explicit ML_ALLOW_PLAINTEXT_KAFKA=true for local development")
    config = {
        "bootstrap.servers": brokers,
        "group.id": _required("KAFKA_CONSUMER_GROUP"),
        "client.id": os.environ.get("HOSTNAME", "ml-scoring-local"),
        "enable.auto.commit": False,
        "enable.auto.offset.store": False,
        "auto.offset.reset": "earliest",
        "security.protocol": security_protocol,
        "allow.auto.create.topics": False,
        # Bound network waits during polling and consumer.close() after SIGTERM.
        "socket.timeout.ms": 5000,
        "socket.connection.setup.timeout.ms": 5000,
        "request.timeout.ms": 10000,
    }
    if security_protocol.startswith("SASL"):
        config.update({"sasl.mechanism": _required("KAFKA_SASL_MECHANISM"),
                      "sasl.username": _required("KAFKA_SASL_USERNAME"),
                      "sasl.password": _required("KAFKA_SASL_PASSWORD")})
    ca_location = os.environ.get("KAFKA_SSL_CA_LOCATION")
    if ca_location:
        config["ssl.ca.location"] = ca_location

    tracer, meter, meter_provider, tracer_provider, logger_provider, log_handler = _telemetry()
    processed = meter.create_counter("ml_scoring_events_total")
    latency = meter.create_histogram("ml_scoring_event_processing", unit="ms")
    predictions = meter.create_counter("ml_scoring_shadow_predictions_total")
    probability = meter.create_histogram("ml_scoring_shadow_probability", unit="1")
    inference_latency = meter.create_histogram("ml_scoring_model_inference", unit="ms")
    input_temperature = meter.create_histogram("ml_scoring_input_temperature", unit="Cel")
    input_humidity = meter.create_histogram("ml_scoring_input_relative_humidity", unit="%")
    missing_measurements = meter.create_counter("ml_scoring_input_missing_measurements_total")
    outbox_published = meter.create_counter("ml_scoring_shadow_outbox_published_total")
    outbox_failures = meter.create_counter("ml_scoring_shadow_outbox_failures_total")
    drift_persistence_failures = meter.create_counter("ml_scoring_drift_state_persistence_failures_total")
    latest_psi: dict[tuple[str, str, str, str], float] = {}
    psi_lock = threading.Lock()
    register_psi_gauge(meter, latest_psi, psi_lock)
    drift_monitors = build_drift_monitors(model.manifest.drift_reference)
    repository = PostgresRepository(database_url)
    processor = ShadowScoringProcessor(model, repository, synthetic_tenant_id=synthetic_tenant)
    health = None
    consumer = None
    relay_thread = None
    relay_failed = threading.Event()
    relay_degraded = threading.Event()
    drift_state_restored = False
    try:
        with repository.tenant_transaction(synthetic_tenant) as transaction:
            prior_drift = transaction.load_drift_status(
                model.manifest.model_name, model.manifest.model_version,
            )
            prior_windows = {
                feature_name: transaction.load_drift_window(
                    model.manifest.model_name, model.manifest.model_version, feature_name,
                ) for feature_name in drift_monitors
            }
        for feature_name, state in prior_windows.items():
            if state is not None:
                # Invalid or incompatible persisted state fails startup rather
                # than silently resetting the drift sample window.
                drift_monitors[feature_name].restore_state(state)
        for feature_name, (psi_value, _sample_count) in prior_drift.items():
            latest_psi[(feature_name, model.manifest.model_name,
                        model.manifest.model_version, "shadow")] = psi_value
        drift_state_restored = True
        # Validate producer construction before advertising readiness; a failed
        # relay is a failed deployment, not a healthy scorer with stranded output.
        relay_producer = Producer(_outbox_producer_config(config))
        health = _health_server(repository, int(os.environ.get("PORT", "8080")),
                                os.environ.get("ML_HEALTH_BIND", "127.0.0.1"),
                                relay_failed, relay_degraded)
        consumer = Consumer(config)
        metadata = consumer.list_topics(timeout=5)
        if environment == "local-synthetic":
            validate_local_kafka_metadata(metadata)
        else:
            validate_cluster_synthetic_kafka_metadata(metadata)
        consumer.subscribe([INPUT_TOPIC])
        relay_thread = threading.Thread(
            target=_run_outbox_relay,
            args=(repository, relay_producer, synthetic_tenant,
                  STOP, outbox_published, outbox_failures,
                  {"model.name": model.manifest.model_name,
                   "model.version": model.manifest.model_version, "mode": "shadow"},
                  relay_failed, relay_degraded),
            name="ml-scoring-shadow-outbox", daemon=True,
        )
        relay_thread.start()
        READY.set()
        LOG.info("subscribed to synthetic shadow input topic %s", INPUT_TOPIC)
        while not STOP.is_set():
            message = consumer.poll(1.0)
            if message is None:
                continue
            error = message.error()
            if error:
                if error.code() == KafkaError._PARTITION_EOF:
                    continue
                if error.fatal():
                    raise RuntimeError(f"Kafka consumer error: {error}")
                LOG.warning("transient Kafka consumer error: %s", error)
                continue
            started = time.perf_counter()
            with tracer.start_as_current_span("ml_scoring.process_event") as span:
                span.set_attribute("messaging.destination.name", message.topic())
                span.set_attribute("messaging.kafka.partition", message.partition())
                span.set_attribute("messaging.kafka.offset", message.offset())
                span.set_attribute("model.name", model.manifest.model_name)
                span.set_attribute("model.version", model.manifest.model_version)
                span.set_attribute("ml.mode", "shadow")
                telemetry = None
                try:
                    telemetry = parse_telemetry_recorded(message.key(), message.value())
                except ContractError:
                    pass  # The processor records/quarantines contract failures.
                try:
                    result = processor.process(message.topic(), message.key(), message.value(),
                                               partition=message.partition(), offset=message.offset())
                except (BinDeviceLimitExceeded, DuplicateEventConflict) as exc:
                    # These failures are attributable to this event. Corrupt stored
                    # state and scorer/model contract failures deliberately fail fast
                    # so data is not silently skipped as if it were a bad input.
                    # The durable shared quarantine record is the handled outcome;
                    # on a failed Kafka commit, replay repeats this idempotent upsert.
                    # A conflicting event ID cannot be claimed again in the tenant
                    # inbox, whose existing row is the conflict source.
                    LOG.error("quarantining non-retryable event: %s", type(exc).__name__)
                    raw = message.value() or b""
                    digest = hashlib.sha256(raw if isinstance(raw, bytes) else raw.encode()).hexdigest()
                    repository.quarantine(topic=message.topic(), partition=message.partition(),
                                          offset=message.offset(), reason=f"poison:{type(exc).__name__}",
                                          digest=digest)
                    result = ProcessResult("quarantined")
                except Exception as exc:
                    span.record_exception(exc)
                    span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
                    raise
                span.set_attribute("greenguard.ml_scoring.result", result.status)
            if telemetry is not None and telemetry.tenant_id == synthetic_tenant:
                labels = {"model.name": model.manifest.model_name,
                          "model.version": model.manifest.model_version, "mode": "shadow"}
                psi_values = record_input_quality(
                    telemetry, result.status, labels=labels, temperature=input_temperature,
                    humidity=input_humidity, missing=missing_measurements,
                    drift_monitors=drift_monitors,
                )
                for feature_name, psi_value in psi_values:
                    with psi_lock:
                        latest_psi[(feature_name, labels["model.name"],
                                    labels["model.version"], labels["mode"])] = psi_value
                    if psi_value > 0.25:
                        LOG.warning("synthetic reference PSI breach for %s: %.4f",
                                    feature_name, psi_value)
                drift_window_updates = []
                psi_updated_features = {feature_name for feature_name, _ in psi_values}
                if result.status in {"awaiting_bin_grid", "insufficient_history", "shadow_scored",
                                     "shadow_prediction_exists"}:
                    for feature_name, observed_value in (
                            ("temperature_c", telemetry.temperature_c),
                            ("relative_humidity_percent", telemetry.relative_humidity_percent)):
                        if observed_value is not None and feature_name in psi_updated_features:
                            state = drift_monitors[feature_name].export_state()
                            drift_window_updates.append((feature_name, state))
                if drift_window_updates:
                    try:
                        with repository.tenant_transaction(synthetic_tenant) as transaction:
                            for feature_name, state in drift_window_updates:
                                transaction.upsert_drift_status(
                                    model.manifest.model_name, model.manifest.model_version,
                                    feature_name, state["current_psi"], len(state["bins"]),
                                    window_state=state,
                                )
                    except Exception:
                        drift_persistence_failures.add(len(drift_window_updates), labels)
                        # PSI telemetry remains available in memory, and a failed
                        # summary write must not poison an otherwise durable score.
                        LOG.exception("could not persist aggregate drift status")
            processed.add(1, {"result": result.status})
            latency.record((time.perf_counter() - started) * 1000, {"result": result.status})
            if result.status == "shadow_scored" and result.probability is not None:
                labels = {"model.name": model.manifest.model_name,
                          "model.version": result.model_version or model.manifest.model_version,
                          "mode": "shadow"}
                predictions.add(1, labels)
                probability.record(result.probability, labels)
                if result.inference_ms is not None:
                    inference_latency.record(result.inference_ms, labels)
            # Database transaction finishes before Kafka offset commit: replay is
            # safe through consumer_inbox; committed offsets can never outrun writes.
            commit_offset_after_processing(consumer, message)
        if relay_failed.is_set():
            raise RuntimeError("shadow prediction outbox relay stopped unexpectedly")
    finally:
        relay_joined = True
        READY.clear()
        STOP.set()
        if relay_thread is not None:
            relay_thread.join(timeout=RELAY_SHUTDOWN_TIMEOUT_SECONDS)
            if relay_thread.is_alive():
                relay_joined = False
                relay_failed.set()
                LOG.critical(
                    "shadow outbox relay exceeded its %ss shutdown bound; process will exit unhealthy",
                    RELAY_SHUTDOWN_TIMEOUT_SECONDS,
                )
        if consumer is not None:
            consumer.close()
        if health is not None:
            health.shutdown()
            health.server_close()
        if drift_state_restored and repository is not None and drift_monitors and synthetic_tenant:
            try:
                with repository.tenant_transaction(synthetic_tenant) as transaction:
                    for feature_name, monitor in drift_monitors.items():
                        state = monitor.export_state()
                        transaction.upsert_drift_status(
                            model.manifest.model_name, model.manifest.model_version,
                            feature_name, state["current_psi"], len(state["bins"]),
                            window_state=state,
                        )
            except Exception:
                LOG.exception("could not persist final aggregate drift checkpoint")
        # Never close the pool while the relay may still own a transaction.
        # The relay is daemonized; if it outlives this bound, fail the process
        # rather than silently exiting successfully with an interrupted publish.
        # Deployments must allow more than RELAY_SHUTDOWN_TIMEOUT_SECONDS.
        if relay_joined:
            repository.close()
        # The pinned batch processors have a 30-second shutdown default. Keep
        # each provider inside a two-second caller deadline so a stalled exporter
        # cannot consume the pod's termination grace period.
        _shutdown_provider_bounded(meter_provider, "metrics", timeout_millis=2000)
        _shutdown_provider_bounded(tracer_provider, "traces")
        if log_handler is not None:
            logging.getLogger().removeHandler(log_handler)
        _shutdown_provider_bounded(logger_provider, "logs")
        if not relay_joined:
            raise RuntimeError("shadow outbox relay exceeded its shutdown bound")


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    run()
