"""Process entry point: ``python -m risk_engine.main``.

``run(getenv, ...)`` takes configuration and collaborators as parameters so startup,
shutdown and configuration errors are testable without Kafka.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from risk_engine import events
from risk_engine.apply import Applier
from risk_engine.consumer import Consumer, DatabaseSink, LotFeed
from risk_engine.health import Metrics, serve
from risk_engine.kafka_source import KafkaSource
from risk_engine.policy_api import PolicyAPI
from risk_engine.policy_auth import OIDCVerifier
from risk_engine.policy_service import PolicyService
from risk_engine.store import PgDatabase
from risk_engine.shards import ShardedDatabase

log = logging.getLogger("risk_engine")


@dataclass(frozen=True)
class Config:
    database_url: str
    kafka_brokers: str
    group: str
    offset_reset: str
    health_port: int
    lot_feed_gate: bool
    max_wait_s: float


def load_config(getenv: Callable[[str], str | None]) -> Config:
    database_url = getenv("RISK_DATABASE_URL")
    brokers = getenv("KAFKA_BROKERS")
    if (not database_url and not getenv("SHARD_REGISTRY_FILE")) or not brokers:
        raise ValueError("RISK_DATABASE_URL and KAFKA_BROKERS are required")
    gate = getenv("RISK_LOT_FEED_GATE") or "checkpoint"
    if gate not in ("checkpoint", "off"):
        raise ValueError("RISK_LOT_FEED_GATE must be checkpoint or off")
    port = int(getenv("RISK_HEALTH_PORT") or "8086")
    max_wait = float(getenv("RISK_NOT_READY_MAX_WAIT_S") or "300")
    if not 0 < port < 65536 or not 1 <= max_wait <= 86400:
        raise ValueError("RISK_HEALTH_PORT or RISK_NOT_READY_MAX_WAIT_S out of range")
    return Config(database_url or "", brokers, getenv("RISK_KAFKA_GROUP") or "greenguard.risk-engine.v1",
                  getenv("RISK_KAFKA_OFFSET_RESET") or "error", port, gate == "checkpoint", max_wait)


def run(getenv: Callable[[str], str | None], stop: threading.Event | None = None,
        database: Callable[[str], Any] = PgDatabase, source: Callable[..., Any] = KafkaSource,
        start_health: Callable[..., Any] = serve) -> int:
    config = load_config(getenv)
    stop = stop or threading.Event()
    metrics = Metrics()
    def create_database():
        return (ShardedDatabase.from_env(getenv, metrics.observe_placement) if getenv("SHARD_REGISTRY_FILE")
                else database(config.database_url))
    db = create_database()
    health_db = create_database()
    verifier = OIDCVerifier.from_env(getenv)
    policy_db = create_database() if verifier is not None else None
    policy_api = PolicyAPI(PolicyService(policy_db) if policy_db is not None else None, verifier)
    kafka = source(config.kafka_brokers, config.group, events.TOPICS, config.offset_reset)
    lot_feed = LotFeed(enabled=config.lot_feed_gate)
    applier = Applier(db, config.group, lot_feed.value)
    consumer = Consumer(kafka, DatabaseSink(db, config.group), applier, lot_feed, metrics,
                        max_wait_s=config.max_wait_s)
    last_step_at: float | None = None

    def ready() -> bool:
        return (last_step_at is not None and time.monotonic() - last_step_at <= 10.0
                and health_db.ping())

    server = start_health(config.health_port, metrics, ready, policy_api=policy_api)
    try:
        while not stop.is_set():
            consumer.step(1.0)
            last_step_at = time.monotonic()
    finally:
        server.shutdown()
        kafka.close()
        health_db.close()
        if policy_db is not None:
            policy_db.close()
        db.close()
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    return run(os.environ.get, stop)


if __name__ == "__main__":
    raise SystemExit(main())
