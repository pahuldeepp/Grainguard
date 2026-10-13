"""Test builders and in-memory fakes (no tests in this module)."""

from __future__ import annotations

import copy
import json
import uuid
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path

from risk_engine.apply import Record
from risk_engine.scoring import Policy
from risk_engine.events import DEVICE_TOPIC, LOT_TOPIC, TELEMETRY_TOPIC, TELEMETRY_V2_TOPIC
from risk_engine.join import covers
from risk_engine.store import StoreError

ROOT = Path(__file__).resolve().parents[2]
# These illustrative values exist only in tests and are explicitly test-approved;
# production selects persisted, tenant-scoped policies from the database.
SYNTHETIC_WHEAT_POLICY_V1 = Policy("wheat", 1, 25.0, 35.0, 65.0, 80.0, 50, calibrated=True)
SYNTHETIC_CANOLA_POLICY_V1 = Policy("canola", 1, 22.0, 30.0, 60.0, 75.0, 50, calibrated=True)
TEST_POLICIES = {"wheat": SYNTHETIC_WHEAT_POLICY_V1, "canola": SYNTHETIC_CANOLA_POLICY_V1}
FIXTURES = ROOT / "tests" / "fixtures" / "events"
TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def new_id() -> str:
    return str(uuid.uuid4())


def _envelope(tenant, event_type, aggregate_type, aggregate_id, version, payload, event_id=None):
    return {
        "event_id": event_id or new_id(), "event_type": event_type, "schema_version": 1,
        "occurred_at": "2026-09-24T12:00:00.000000Z", "tenant_id": tenant,
        "aggregate_type": aggregate_type, "aggregate_id": aggregate_id,
        "aggregate_version": str(version), "correlation_id": new_id(), "causation_id": new_id(),
        "traceparent": TRACE, "payload": payload,
    }


def registered(tenant, device, site, bin_id, inventory_version=1, binding_version=1, status="active"):
    return _envelope(tenant, "device.registered", "device", device, inventory_version, {
        "device_id": device, "serial_number": "SN-1", "site_id": site, "bin_id": bin_id,
        "status": status, "binding_version": str(binding_version)})


def binding_changed(tenant, device, site, bin_id, inventory_version, binding_version):
    return _envelope(tenant, "device.binding_changed", "device", device, inventory_version, {
        "device_id": device, "site_id": site, "bin_id": bin_id, "binding_version": str(binding_version)})


def status_changed(tenant, device, status, inventory_version, binding_version):
    return _envelope(tenant, "device.status_changed", "device", device, inventory_version, {
        "device_id": device, "status": status, "binding_version": str(binding_version)})


def lot_changed(tenant, site, bin_id, lot, grain, version, effective_from, previous=None):
    return _envelope(tenant, "lot.changed", "bin_occupancy", bin_id, version, {
        "bin_id": bin_id, "site_id": site, "lot_id": lot, "grain_type": grain, "variety": None,
        "occupancy_version": str(version), "effective_from": effective_from, "previous_lot_id": previous})


def telemetry(tenant, device, site, bin_id, observed_at, measurements=None, binding_version=1, version=1):
    return _envelope(tenant, "telemetry.recorded", "device_telemetry_stream", device, version, {
        "reading_id": new_id(), "device_id": device, "site_id": site, "bin_id": bin_id,
        "binding_version": str(binding_version), "source_message_id": f"m-{new_id()}",
        "observed_at": observed_at, "received_at": observed_at,
        "measurements": measurements or {"temperature_c": 28.0, "relative_humidity_percent": 66.0}})


_offsets = iter(range(1, 10**9))


def record(event, topic=None, offset=None, partition=0) -> Record:
    if topic is None:
        topic = {"telemetry.recorded": (TELEMETRY_V2_TOPIC if event.get("schema_version") == 2
                                        else TELEMETRY_TOPIC), "lot.changed": LOT_TOPIC}.get(
            event.get("event_type"), DEVICE_TOPIC)
    value = event if isinstance(event, bytes) else json.dumps(event).encode()
    return Record(topic, partition, next(_offsets) if offset is None else offset, value)


class FakeTx:
    """In-memory model of PgTx for pure-logic and failure-branch tests."""

    def __init__(self, db: "FakeDatabase", tenant: str):
        self.db, self.tenant = db, tenant
        self.s = db.staged

    def _hook(self, name):
        failure = self.db.failures.get(name)
        if failure:
            error = failure.pop(0)
            if error is not None:
                raise error

    def inbox_insert(self, entry):
        self._hook("inbox_insert")
        key = (entry.consumer_name, self.tenant, entry.event_id)
        if key in self.s["inbox"]:
            return self.s["inbox"][key]
        self.s["inbox"][key] = entry.sha256
        return None

    def binding_for_update(self, device_id):
        return self.s["bindings"].get((self.tenant, device_id))

    def binding_upsert(self, binding, source_event_id):
        self._hook("binding_upsert")
        self.s["bindings"][(self.tenant, binding.device_id)] = binding

    def lock_bin(self, bin_id):
        self.db.locks.append((self.tenant, bin_id))

    def lot_version(self, bin_id, occupancy_version):
        return self.s["lots"].get((self.tenant, bin_id, occupancy_version), (None,))[0]

    def open_interval(self, bin_id):
        rows = [v for k, v in self.s["lots"].items() if k[:2] == (self.tenant, bin_id)]
        return max(rows, key=lambda item: item[1].occupancy_version)[1] if rows else None

    def close_interval(self, bin_id, occupancy_version, effective_to):
        row, interval = self.s["lots"][(self.tenant, bin_id, occupancy_version)]
        if effective_to <= interval.effective_from:
            raise StoreError("23514", "bin_lot_intervals_ordered")
        self.s["lots"][(self.tenant, bin_id, occupancy_version)] = (row, replace(interval, effective_to=effective_to))

    def insert_interval(self, lot):
        from risk_engine.join import Interval

        self._hook("insert_interval")
        interval = Interval(lot.bin_id, lot.occupancy_version, lot.lot_id, lot.grain_type,
                            lot.effective_from, None)
        self.s["lots"][(self.tenant, lot.bin_id, lot.occupancy_version)] = (lot, interval)

    def intervals_covering(self, bin_id, instant):
        return [v[1] for k, v in self.s["lots"].items()
                if k[:2] == (self.tenant, bin_id) and covers(v[1], instant)]

    def assessments_after(self, bin_id, lot_id, instant):
        return [a for a in self.s["assessments"].values() if a["tenant"] == self.tenant
                and a["bin_id"] == bin_id and a["lot_id"] == lot_id and a["observed_at"] >= instant
                and (self.tenant, a["assessment_id"]) not in self.s["invalidations"]]

    def insert_invalidation(self, assessment_id, event_id, replacement_lot_id,
                            replacement_occupancy_version, source_event_id):
        self._hook("insert_invalidation")
        self.s["invalidations"][(self.tenant, assessment_id)] = {
            "event_id": event_id, "replacement_lot_id": replacement_lot_id,
            "replacement_occupancy_version": replacement_occupancy_version,
            "source_event_id": source_event_id,
        }

    def assessment(self, source_event_id, lot_id, policy_version, policy_id=None):
        row = self.s["assessments"].get((self.tenant, source_event_id, lot_id, policy_version))
        if row is None or (policy_id is not None and row.get("policy_id") != policy_id):
            return None
        return row

    def next_stream_version(self, device_id):
        key = (self.tenant, device_id)
        self.s["streams"][key] = self.s["streams"].get(key, 0) + 1
        return self.s["streams"][key]

    def insert_assessment(self, values):
        self._hook("insert_assessment")
        key = (self.tenant, values["source_event_id"], values["lot_id"], values["policy_version"])
        self.s["assessments"][key] = {**values, "tenant": self.tenant}

    def insert_outbox(self, event):
        self._hook("insert_outbox")
        self.s["outbox"].append(event)


class FakeDatabase:
    """Commits staged state only when the transaction body completes."""

    def __init__(self):
        self.state = {"inbox": {}, "bindings": {}, "lots": {}, "streams": {}, "assessments": {},
                      "invalidations": {}, "outbox": []}
        self.staged = None
        self.failures: dict[str, list] = {}
        self.locks: list = []
        self.transactions = 0
        self.quarantined: list = []

    def fail(self, name, *errors):
        self.failures.setdefault(name, []).extend(errors)

    @contextmanager
    def transaction(self, tenant_id):
        self.transactions += 1
        self.staged = copy.deepcopy(self.state)
        yield FakeTx(self, tenant_id)
        self.state = self.staged

    def quarantine(self, *args):
        self.quarantined.append(args)


class FakeSource:
    def __init__(self, records=()):
        self.queue = list(records)
        self.commits: list = []
        self.paused: list = []
        self.resumed: list = []
        self.marks: dict = {}
        self.committed_offsets: dict = {}

    def poll(self, timeout_s):
        return self.queue.pop(0) if self.queue else None

    def commit(self, record):
        self.commits.append((record.topic, record.partition, record.offset))

    def rewind_and_pause(self, record):
        self.paused.append(record)

    def resume(self, topic, partition):
        self.resumed.append((topic, partition))

    def high_watermarks(self, topic):
        return dict(self.marks)

    def committed(self, topic):
        return dict(self.committed_offsets)


class FakeSink:
    def __init__(self, error=None):
        self.items: list = []
        self.error = error

    def quarantine(self, record, reason):
        if self.error:
            raise self.error
        self.items.append((record.topic, record.offset, reason))
