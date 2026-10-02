from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
import hashlib
import json
import logging
import os
import shutil
import threading
import tempfile
import unittest
from unittest.mock import patch
import uuid
from types import SimpleNamespace

import numpy as np
from confluent_kafka import KafkaError, KafkaException
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, SimpleLogRecordProcessor

from ml_scoring.contracts import ContractError, parse_telemetry_recorded
from ml_scoring.deployment import (DeploymentGateError, GuardrailSnapshot, PromotionEvidence,
                                   RollingPSIMonitor, population_stability_index,
                                   require_promotion_evidence, rollback_reasons,
                                   _histogram_counts)
from ml_scoring.events import build_shadow_prediction_event
from ml_scoring.main import (READY, _health_server, _readiness_is_healthy, _run_outbox_relay,
                             _outbox_producer_config, build_drift_monitors,
                             commit_offset_after_processing, run, validate_local_endpoints,
                             _shutdown_provider_bounded,
                             validate_local_kafka_metadata, record_input_quality, register_psi_gauge,
                             OpenTelemetryLoggingHandler)
from ml_scoring.outbox import FatalKafkaProducerError, publish_pending_once
from ml_scoring.processor import (BinDeviceLimitExceeded, CorruptBinWindowState,
                                  INPUT_TOPIC, ShadowScoringProcessor, _sequence, _wire_time)
from ml_scoring.registry import (LoadedModel, ModelBundleError, ModelRegistry,
                                 derive_model_version)
from ml_scoring.store import InMemoryRepository, PostgresRepository, ShadowPrediction


TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
DEVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
SITE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
BIN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"


class FakeModel:
    manifest = SimpleNamespace(synthetic_only=True, production_eligible=False,
                               model_name="synthetic-test", model_version="test-v1")

    def predict(self, values: np.ndarray) -> np.ndarray:
        assert values.shape[0] == 1 and values.shape[1] == 96 and values.shape[2] % 3 == 0
        return np.asarray([0.25], dtype=np.float32)


def event(sequence: int, *, tenant_id: str = TENANT, device_id: str = DEVICE,
          bin_id: str | None = BIN, observed_at: datetime | None = None,
          received_at: datetime | None = None) -> tuple[str, bytes]:
    observed_at = observed_at or datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * sequence)
    received_at = received_at or observed_at
    ts = observed_at.isoformat(timespec="seconds").replace("+00:00", "Z")
    receive_ts = received_at.isoformat(timespec="seconds").replace("+00:00", "Z")
    body = {
        "event_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"event-{tenant_id}-{device_id}-{sequence}")),
        "event_type": "telemetry.recorded", "schema_version": 1,
        "occurred_at": receive_ts, "tenant_id": tenant_id,
        "aggregate_type": "device_telemetry_stream", "aggregate_id": device_id,
        "aggregate_version": str(sequence + 1),
        "correlation_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        "causation_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
        "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "payload": {
            "reading_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"reading-{tenant_id}-{device_id}-{sequence}")),
            "device_id": device_id, "site_id": SITE, "bin_id": bin_id,
            "binding_version": "1", "source_message_id": f"reading:{sequence}",
            "observed_at": ts, "received_at": receive_ts,
            "measurements": {"temperature_c": 25.5, "relative_humidity_percent": 65.0},
        },
    }
    return f"{tenant_id}:{device_id}", json.dumps(body, separators=(",", ":")).encode()


class ContractTests(unittest.TestCase):
    def test_rejects_oversized_numeric_literal_as_contract_error(self) -> None:
        key, raw = event(0)
        text = raw.decode().replace("25.5", "1" + "0" * 400)
        with self.assertRaisesRegex(ContractError, "finite number"):
            parse_telemetry_recorded(key, text)

    def test_rejects_non_ascii_bigint_digits(self) -> None:
        key, raw = event(0)
        body = json.loads(raw)
        body["aggregate_version"] = "١٢٣"
        with self.assertRaisesRegex(ContractError, "aggregate_version"):
            parse_telemetry_recorded(key, json.dumps(body))
        body["aggregate_version"] = "1"
        body["payload"]["binding_version"] = "١"
        with self.assertRaisesRegex(ContractError, "binding_version"):
            parse_telemetry_recorded(key, json.dumps(body))

    def test_rejects_received_timestamp_far_in_future(self) -> None:
        observed = datetime.now(timezone.utc) + timedelta(days=1)
        key, raw = event(0, observed_at=observed, received_at=observed)
        with self.assertRaisesRegex(ContractError, "received_at is too far in the future"):
            parse_telemetry_recorded(key, raw)

    def test_rejects_observation_far_ahead_of_receive_time(self) -> None:
        observed = datetime(2026, 1, 1, tzinfo=timezone.utc)
        key, raw = event(0, observed_at=observed, received_at=observed - timedelta(minutes=6))
        with self.assertRaisesRegex(ContractError, "too far after"):
            parse_telemetry_recorded(key, raw)

    def test_rejects_extreme_timestamp_years_before_window_arithmetic(self) -> None:
        key, raw = event(0)
        for value in ("0001-01-01T00:00:00Z", "9999-12-31T23:59:00Z"):
            body = json.loads(raw)
            body["payload"]["observed_at"] = value
            body["payload"]["received_at"] = value
            body["occurred_at"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ContractError, "timestamp range"):
                parse_telemetry_recorded(key, json.dumps(body))

    def test_schema_version_requires_exact_integer_one(self) -> None:
        key, raw = event(0)
        for invalid in (True, 1.0, 2):
            body = json.loads(raw)
            body["schema_version"] = invalid
            with self.subTest(schema_version=invalid), self.assertRaisesRegex(ContractError, "schema_version 1"):
                parse_telemetry_recorded(key, json.dumps(body))

    def test_rejects_missing_required_property_and_zero_trace_id(self) -> None:
        key, raw = event(0)
        body = json.loads(raw)
        del body["payload"]["reading_id"]
        with self.assertRaises(ContractError):
            parse_telemetry_recorded(key, json.dumps(body))
        key, raw = event(0)
        body = json.loads(raw)
        body["traceparent"] = "00-00000000000000000000000000000000-0123456789abcdef-01"
        with self.assertRaises(ContractError):
            parse_telemetry_recorded(key, json.dumps(body))
        with self.assertRaisesRegex(ContractError, "UTF-8"):
            parse_telemetry_recorded(b"\xff", raw)


class ShadowScoringTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repository = InMemoryRepository()
        self.processor = ShadowScoringProcessor(FakeModel(), self.repository,
                                                synthetic_tenant_id=TENANT, expected_sensor_count=1)

    def process(self, seq: int, *, tenant_id: str = TENANT, offset: int | None = None):
        key, raw = event(seq, tenant_id=tenant_id)
        return self.processor.process(INPUT_TOPIC, key, raw, partition=0,
                                      offset=seq if offset is None else offset)

    def test_drops_events_older_than_the_retained_context(self) -> None:
        self.process(200)
        previous_state = json.loads(json.dumps(self.repository._states[(TENANT, BIN)]))
        result = self.process(0)
        self.assertEqual(result.status, "late_event_outside_window")
        self.assertEqual(self.repository._states[(TENANT, BIN)], previous_state)

    def test_rejects_same_sensor_reordering_beyond_lateness_bound(self) -> None:
        self.process(10)
        result = self.process(5)
        self.assertEqual(result.status, "late_event_outside_window")

    def test_scores_off_grid_observation_in_its_fifteen_minute_slot(self) -> None:
        for seq in range(23):
            self.process(seq)
        observed = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * 23, seconds=9)
        key, raw = event(23, observed_at=observed)
        result = self.processor.process(INPUT_TOPIC, key, raw, partition=0, offset=23)
        self.assertEqual(result.status, "shadow_scored")
        self.assertEqual(len(self.repository.predictions), 1)

    def test_bin_scoring_waits_for_sensors_with_different_arrival_times(self) -> None:
        repository = InMemoryRepository()
        processor = ShadowScoringProcessor(FakeModel(), repository, synthetic_tenant_id=TENANT,
                                           expected_sensor_count=2)
        device_b = "12121212-1212-4121-8121-121212121212"
        for seq in range(24):
            observed = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * seq)
            received = observed + (timedelta(seconds=5) if seq == 23 else timedelta(0))
            key, raw = event(seq, device_id=DEVICE, observed_at=observed, received_at=received)
            result = processor.process(INPUT_TOPIC, key, raw, partition=0, offset=seq)
            if seq == 23:
                self.assertEqual(result.status, "awaiting_bin_grid")
        for seq in range(23):
            key, raw = event(seq, device_id=device_b)
            processor.process(INPUT_TOPIC, key, raw, partition=1, offset=seq)
        observed = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=15 * 23)
        key, raw = event(23, device_id=device_b, observed_at=observed,
                         received_at=observed + timedelta(seconds=3))
        result = processor.process(INPUT_TOPIC, key, raw, partition=1, offset=23)
        self.assertEqual(result.status, "shadow_scored")
        self.assertEqual(len(repository.predictions), 1)

    def test_one_slot_sensor_reordering_preserves_feature_digest(self) -> None:
        device_b = "12121212-1212-4121-8121-121212121212"

        def run(order: list[tuple[str, int]]) -> str:
            repository = InMemoryRepository()
            processor = ShadowScoringProcessor(FakeModel(), repository, synthetic_tenant_id=TENANT,
                                               expected_sensor_count=2)
            for offset, (device, sequence) in enumerate(order):
                key, raw = event(sequence, device_id=device)
                result = processor.process(INPUT_TOPIC, key, raw, partition=0, offset=offset)
            self.assertEqual(result.status, "shadow_scored")
            self.assertEqual(len(repository.predictions), 1)
            return repository.predictions[0].feature_digest

        in_order = [(device, sequence) for sequence in range(23)
                    for device in (DEVICE, device_b)]
        in_order.extend(((DEVICE, 23), (device_b, 23)))
        reordered = [(device, sequence) for sequence in range(23)
                     for device in (DEVICE, device_b)
                     if (device, sequence) != (device_b, 22)]
        reordered.extend(((device_b, 23), (device_b, 22), (DEVICE, 23)))
        self.assertEqual(run(reordered), run(in_order))

    def test_every_expected_sensor_needs_six_hours_of_history(self) -> None:
        repository = InMemoryRepository()
        processor = ShadowScoringProcessor(FakeModel(), repository, synthetic_tenant_id=TENANT,
                                           expected_sensor_count=2)
        second_device = "12121212-1212-4121-8121-121212121212"
        for seq in range(24):
            key, raw = event(seq, device_id=DEVICE)
            result = processor.process(INPUT_TOPIC, key, raw, partition=0, offset=seq)
        key, raw = event(23, device_id=second_device)
        result = processor.process(INPUT_TOPIC, key, raw, partition=1, offset=23)
        self.assertEqual(result.status, "insufficient_history")
        self.assertEqual(repository.predictions, [])

    def test_inbox_retention_pruning_is_rate_limited(self) -> None:
        for seq in range(2):
            self.process(seq)
        self.assertEqual(len(self.repository.inbox_prune_calls), 1)

    def test_full_inbox_prune_batch_schedules_a_bounded_followup(self) -> None:
        self.repository.inbox_prune_rows = 1_000
        self.process(0)
        first_deadline = self.processor._next_inbox_prune_at
        self.assertIsNotNone(first_deadline)
        self.assertLessEqual(first_deadline, datetime.now(timezone.utc) + timedelta(seconds=61))
        self.processor._next_inbox_prune_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.process(1)
        self.assertEqual(len(self.repository.inbox_prune_calls), 2)

    def test_failed_tenant_transaction_does_not_advance_prune_deadline(self) -> None:
        self.repository.inbox_prune_rows = 1_000
        self.process(0)
        expired_deadline = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.processor._next_inbox_prune_at = expired_deadline
        second_device = "12121212-1212-4121-8121-121212121212"
        key, raw = event(1, device_id=second_device)
        with self.assertRaises(BinDeviceLimitExceeded):
            self.processor.process(INPUT_TOPIC, key, raw, partition=0, offset=1)
        self.assertEqual(self.processor._next_inbox_prune_at, expired_deadline)

    def test_published_shadow_retention_is_tenant_scoped_and_rate_limited(self) -> None:
        self.process(0)
        self.assertEqual(len(self.repository.shadow_prune_calls), 1)
        cutoff = self.repository.shadow_prune_calls[0]
        self.assertLessEqual(cutoff, datetime.now(timezone.utc) - timedelta(days=29, hours=23))
        self.process(1)
        self.assertEqual(len(self.repository.shadow_prune_calls), 1)

    def test_full_shadow_retention_batch_schedules_bounded_followup(self) -> None:
        self.repository.shadow_prune_rows = 1_000
        self.process(0)
        first_deadline = self.processor._next_shadow_prune_at
        self.assertIsNotNone(first_deadline)
        self.assertLessEqual(first_deadline, datetime.now(timezone.utc) + timedelta(seconds=61))
        self.processor._next_shadow_prune_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.process(1)
        self.assertEqual(len(self.repository.shadow_prune_calls), 2)

    def test_scores_only_after_six_hours(self) -> None:
        for seq in range(23):
            self.assertEqual(self.process(seq).status, "insufficient_history")
        result = self.process(23)
        self.assertEqual(result.status, "shadow_scored")
        self.assertEqual(result.probability, 0.25)
        self.assertEqual(len(self.repository.predictions), 1)
        self.assertEqual(self.repository.predictions[0].status, "shadow")
        self.assertEqual(self.repository.predictions[0].data_origin, "synthetic_grain_sim")
        key, raw = event(24, observed_at=datetime(2026, 1, 1, tzinfo=timezone.utc)
                         + timedelta(minutes=15 * 23, seconds=7))
        replacement = self.processor.process(INPUT_TOPIC, key, raw, partition=0, offset=24)
        self.assertEqual(replacement.status, "shadow_prediction_exists")
        self.assertEqual(len(self.repository.predictions), 1)

    def test_replay_is_idempotent_and_other_tenants_are_rejected(self) -> None:
        key, raw = event(0)
        first = self.processor.process(INPUT_TOPIC, key, raw, partition=0, offset=1)
        again = self.processor.process(INPUT_TOPIC, key, raw, partition=0, offset=2)
        self.assertEqual(first.status, "insufficient_history")
        self.assertEqual(again.status, "duplicate")
        self.assertEqual(self.process(0, tenant_id="99999999-9999-4999-8999-999999999999").status,
                         "tenant_rejected")
        self.assertEqual(len(self.repository.quarantined), 1)

    def test_transaction_rolls_back_in_memory_state(self) -> None:
        key, raw = event(0)
        parsed = parse_telemetry_recorded(key, raw)
        with self.assertRaises(RuntimeError):
            with self.repository.tenant_transaction(TENANT) as transaction:
                transaction.claim_event(parsed, topic=INPUT_TOPIC, partition=0, offset=0)
                transaction.load_bin_state(BIN)
                raise RuntimeError("rollback probe")
        self.assertEqual(self.process(0).status, "insufficient_history")

    def test_invalid_utf8_key_is_quarantined_without_crashing(self) -> None:
        _, raw = event(0)
        result = self.processor.process(INPUT_TOPIC, b"\xff", raw, partition=0, offset=6)
        self.assertEqual(result.status, "quarantined")
        self.assertEqual(self.repository.quarantined[-1]["reason"], "contract:ContractError")

    def test_tombstone_is_quarantined_without_crashing(self) -> None:
        result = self.processor.process(INPUT_TOPIC, f"{TENANT}:{DEVICE}", None,
                                        partition=0, offset=5)
        self.assertEqual(result.status, "quarantined")
        self.assertEqual(self.repository.quarantined[-1]["reason"], "contract:null_value")

    def test_unbound_bin_is_recorded_without_scoring(self) -> None:
        key, raw = event(0, bin_id=None)
        result = self.processor.process(INPUT_TOPIC, key, raw, partition=0, offset=4)
        self.assertEqual(result.status, "unbound_bin")
        self.assertEqual(self.repository.predictions, [])

    def test_missing_sensor_measurements_do_not_count_as_usable_or_current(self) -> None:
        window_end = datetime(2026, 1, 2, tzinfo=timezone.utc)
        as_of = window_end + timedelta(minutes=1)
        rows = []
        for sequence in range(24):
            observed_at = window_end - timedelta(minutes=15 * (23 - sequence))
            rows.append({
                "slot": _wire_time(observed_at),
                "observed_at": _wire_time(observed_at),
                "received_at": _wire_time(as_of),
                "temperature_c": 20.0,
                "relative_humidity_percent": None if sequence == 23 else 60.0,
            })

        _, usable_sensors, current_sensors = _sequence(
            {"devices": {DEVICE: rows}}, window_end=window_end, as_of=as_of,
        )

        self.assertEqual(usable_sensors, 0)
        self.assertEqual(current_sensors, 0)


class DeploymentGateTests(unittest.TestCase):
    def test_histogram_edges_keep_existing_left_inclusive_bin_assignment(self) -> None:
        self.assertEqual(
            _histogram_counts([-1.0, 0.25, 0.2501, 0.5, 0.75, 1.0], [0.25, 0.5, 0.75]),
            [2, 2, 1, 1],
        )

    def test_rolling_psi_is_bounded_rate_limited_and_detects_distribution_shift(self) -> None:
        monitor = RollingPSIMonitor(edges=[0.25, 0.5, 0.75],
                                    reference_proportions=[0.25] * 4,
                                    minimum_samples=4, window_size=6, update_every=2)
        self.assertIsNone(monitor.observe(0.1))
        self.assertIsNone(monitor.observe(0.2))
        self.assertIsNone(monitor.observe(0.3))
        shifted = monitor.observe(0.4)
        self.assertIsNotNone(shifted)
        self.assertGreater(shifted, 0.25)
        self.assertEqual(monitor.current_psi, shifted)
        self.assertIsNone(monitor.observe(0.5))
        refreshed = monitor.observe(0.6)
        self.assertIsNotNone(refreshed)
        self.assertLessEqual(len(monitor._bins), 6)
        with self.assertRaisesRegex(DeploymentGateError, "bounded PSI window"):
            RollingPSIMonitor(edges=[0.25, 0.5], reference_proportions=[1 / 3] * 3,
                              minimum_samples=1, window_size=100_001, update_every=1)
        with self.assertRaisesRegex(DeploymentGateError, "bounded PSI window"):
            RollingPSIMonitor(edges=[0.25, 0.5], reference_proportions=[1 / 3] * 3,
                              minimum_samples=1, window_size=4, update_every=5)

    def test_psi_fails_closed_on_invalid_reference_or_observation(self) -> None:
        with self.assertRaisesRegex(DeploymentGateError, "sum to one"):
            RollingPSIMonitor(edges=[0.25, 0.5], reference_proportions=[0.2, 0.2, 0.2],
                              minimum_samples=2, window_size=2, update_every=1)
        monitor = RollingPSIMonitor(edges=[0.25, 0.5], reference_proportions=[1 / 3] * 3,
                                    minimum_samples=1, window_size=2, update_every=1)
        with self.assertRaisesRegex(DeploymentGateError, "finite"):
            monitor.observe(float("nan"))
        self.assertGreaterEqual(population_stability_index(
            [0.1, 0.3, 0.6, 0.9], [0.1, 0.3, 0.6, 0.9], [0.25, 0.5, 0.75],
        ), 0.0)

    def test_nonfinite_guardrail_values_force_rollback(self) -> None:
        baseline = GuardrailSnapshot(0.0, 0.0, 0.0, 0.0, 0.0)
        for field in ("missing_prediction_rate", "tier_a_p99_ms", "consumer_lag_seconds",
                      "watermark_stalled_seconds", "prediction_psi"):
            with self.subTest(field=field):
                reasons = rollback_reasons(replace(baseline, **{field: float("nan")}))
                self.assertIn(f"{field}_non_finite", reasons)
        self.assertEqual(rollback_reasons(baseline), ())
        self.assertIn("consumer_lag", rollback_reasons(replace(baseline, consumer_lag_seconds=301)))

    def test_promotion_rejects_nonfinite_export_parity(self) -> None:
        evidence = PromotionEvidence(
            real_ground_truth=True, pooled_consent_count=50, independent_sites=5,
            independent_weather_years=3, test_examples=2_000,
            export_parity_max_abs_error=0.0, model_card_present=True,
            human_approval_id="approval-1", minimum_quality_gate_passed=True,
        )
        require_promotion_evidence(evidence)
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value), self.assertRaisesRegex(DeploymentGateError, "export parity"):
                require_promotion_evidence(replace(evidence, export_parity_max_abs_error=value))


class RegistryTests(unittest.TestCase):
    def test_bundle_load_and_feature_mismatch_fail_closed(self) -> None:
        root = Path(__file__).resolve().parents[3] / "evidence" / "model-registry"
        bundles = list(root.glob("greenguard.hotspot-transition.classifier/*"))
        i4_report = json.loads((root.parent / "intelligence" / "i4-transformer-comparison.json").read_text())
        expected_digest = i4_report["model_artifacts"]["transformer"]["sha256"]
        expected_version = derive_model_version(expected_digest, i4_report["drift_reference"])
        self.assertGreaterEqual(len(bundles), 1)
        bundles = [bundle for bundle in bundles if bundle.name == expected_version]
        self.assertEqual(len(bundles), 1)
        manifest = json.loads((bundles[0] / "manifest.json").read_text())
        registry = ModelRegistry(str(root), allow_synthetic_shadow=True)
        loaded = registry.load(manifest["model_name"], manifest["model_version"])
        self.assertTrue(loaded.manifest.synthetic_only)
        self.assertFalse(loaded.manifest.production_eligible)
        self.assertEqual(loaded.manifest.feature_set_version, "telemetry-sequence-v1-24h-15m")

        with tempfile.TemporaryDirectory() as temporary:
            altered_root = Path(temporary)
            destination = altered_root / manifest["model_name"] / manifest["model_version"]
            destination.mkdir(parents=True)
            for filename in ("weights.pt", "golden.json", "drift-reference.json"):
                shutil.copyfile(bundles[0] / filename, destination / filename)
            manifest["feature_set_version"] = "unknown-incompatible-features"
            (destination / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ModelBundleError, "feature set"):
                ModelRegistry(altered_root, allow_synthetic_shadow=True).load(
                    manifest["model_name"], manifest["model_version"]
                )

    def test_bundle_rejects_nonfinite_golden_and_model_probabilities(self) -> None:
        root = Path(__file__).resolve().parents[3] / "evidence" / "model-registry"
        i4_report = json.loads((root.parent / "intelligence" / "i4-transformer-comparison.json").read_text())
        expected_digest = i4_report["model_artifacts"]["transformer"]["sha256"]
        expected_version = derive_model_version(expected_digest, i4_report["drift_reference"])
        bundles = [path for path in root.glob("greenguard.hotspot-transition.classifier/*")
                   if path.name == expected_version]
        self.assertEqual(len(bundles), 1)
        bundle = bundles[0]
        manifest = json.loads((bundle / "manifest.json").read_text())

        with tempfile.TemporaryDirectory() as temporary:
            copied_root = Path(temporary)
            destination = copied_root / manifest["model_name"] / manifest["model_version"]
            destination.mkdir(parents=True)
            for filename in (manifest["artifact_file"], manifest["golden_file"],
                             manifest["drift_reference_file"]):
                shutil.copyfile(bundle / filename, destination / filename)
            golden_path = destination / manifest["golden_file"]
            golden = json.loads(golden_path.read_text())
            golden["probability"] = float("nan")
            golden_bytes = json.dumps(golden, allow_nan=True).encode()
            golden_path.write_bytes(golden_bytes)
            manifest["golden_input_sha256"] = hashlib.sha256(golden_bytes).hexdigest()
            (destination / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ModelBundleError, "golden probability"):
                ModelRegistry(copied_root, allow_synthetic_shadow=True).load(
                    manifest["model_name"], manifest["model_version"]
                )

        with patch.object(LoadedModel, "predict", return_value=np.asarray([np.nan], dtype=np.float32)):
            with self.assertRaisesRegex(ModelBundleError, "golden-vector output parity"):
                ModelRegistry(root, allow_synthetic_shadow=True).load(
                    manifest["model_name"], manifest["model_version"]
                )

    def test_runtime_requires_local_synthetic_environment_before_startup(self) -> None:
        old_environment = os.environ.get("ML_ENVIRONMENT")
        try:
            os.environ.pop("ML_ENVIRONMENT", None)
            os.environ["ML_SHADOW_ENABLED"] = "true"
            with self.assertRaisesRegex(RuntimeError, "local-synthetic"):
                run()
        finally:
            os.environ.pop("ML_SHADOW_ENABLED", None)
            if old_environment is not None:
                os.environ["ML_ENVIRONMENT"] = old_environment

    def test_invalid_synthetic_tenant_is_rejected_before_database_setup(self) -> None:
        with patch.dict(os.environ, {
            "ML_ENVIRONMENT": "local-synthetic",
            "ML_SHADOW_ENABLED": "true",
            "ML_SYNTHETIC_TENANT_ID": "not-a-uuid",
        }, clear=True), patch("ml_scoring.main.PostgresRepository") as repository:
            with self.assertRaisesRegex(RuntimeError, "canonical lowercase UUID"):
                run()
        repository.assert_not_called()


class OpenTelemetryLogBridgeTests(unittest.TestCase):
    def test_stdlib_service_logs_export_as_otel_records(self) -> None:
        exporter = InMemoryLogRecordExporter()
        provider = LoggerProvider()
        provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))
        handler = OpenTelemetryLoggingHandler(provider)
        logger = logging.Logger("greenguard.ml_scoring.test", level=logging.INFO)
        logger.addHandler(handler)
        try:
            logger.error("shadow outbox relay failed")
            records = exporter.get_finished_logs()
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0].log_record.body, "shadow outbox relay failed")
            self.assertEqual(records[0].log_record.severity_text, "ERROR")
        finally:
            logger.removeHandler(handler)
            provider.shutdown()

    def test_opentelemetry_sdk_logs_are_not_recursively_exported(self) -> None:
        exporter = InMemoryLogRecordExporter()
        provider = LoggerProvider()
        provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))
        handler = OpenTelemetryLoggingHandler(provider)
        logger = logging.Logger("opentelemetry.sdk.export.test", level=logging.ERROR)
        logger.addHandler(handler)
        try:
            logger.error("exporter internal diagnostic")
            self.assertFalse(exporter.get_finished_logs())
        finally:
            logger.removeHandler(handler)
            provider.shutdown()


class ReadinessGateTests(unittest.TestCase):
    def test_busy_probe_returns_unhealthy_without_waiting(self) -> None:
        previous = READY.is_set()
        READY.set()
        gate = threading.BoundedSemaphore(1)
        gate.acquire()
        try:
            self.assertFalse(_readiness_is_healthy(InMemoryRepository(), gate))
        finally:
            gate.release()
            if not previous:
                READY.clear()

    def test_probe_releases_gate_when_database_ping_raises(self) -> None:
        previous = READY.is_set()
        READY.set()
        gate = threading.BoundedSemaphore(1)

        class FailingRepository:
            def ping(self) -> bool:
                raise RuntimeError("database unavailable")

        try:
            self.assertFalse(_readiness_is_healthy(FailingRepository(), gate))
            self.assertTrue(gate.acquire(blocking=False))
            gate.release()
        finally:
            if not previous:
                READY.clear()

    def test_outbox_relay_failure_makes_readiness_unhealthy(self) -> None:
        previous = READY.is_set()
        READY.set()
        relay_failed = threading.Event()
        relay_failed.set()
        try:
            self.assertFalse(_readiness_is_healthy(
                InMemoryRepository(), threading.BoundedSemaphore(1), relay_failed,
            ))
        finally:
            if not previous:
                READY.clear()

    def test_healthy_outbox_relay_keeps_database_readiness_green(self) -> None:
        previous = READY.is_set()
        READY.set()
        try:
            self.assertTrue(_readiness_is_healthy(
                InMemoryRepository(), threading.BoundedSemaphore(1), threading.Event(),
            ))
        finally:
            if not previous:
                READY.clear()

    def test_persistent_outbox_delivery_failures_make_readiness_unhealthy(self) -> None:
        previous = READY.is_set()
        READY.set()
        relay_degraded = threading.Event()
        relay_degraded.set()
        try:
            self.assertFalse(_readiness_is_healthy(
                InMemoryRepository(), threading.BoundedSemaphore(1),
                threading.Event(), relay_degraded,
            ))
        finally:
            if not previous:
                READY.clear()

    def test_relay_degrades_after_retries_and_recovers_after_publish(self) -> None:
        class Counter:
            def __init__(self):
                self.values = []

            def add(self, value, _labels):
                self.values.append(value)

        stop = threading.Event()
        relay_failed = threading.Event()
        relay_degraded = threading.Event()
        published, failures = Counter(), Counter()
        attempts = 0

        def publish_once(*_args, **_kwargs):
            nonlocal attempts
            attempts += 1
            if attempts <= 3:
                raise RuntimeError("broker unavailable")
            stop.set()
            return 1

        class Producer:
            def flush(self, _timeout):
                return 0

        with patch("ml_scoring.main.publish_pending_once", side_effect=publish_once):
            _run_outbox_relay(
                object(), Producer(), TENANT, stop, published, failures,
                {"mode": "shadow"}, relay_failed, relay_degraded,
            )
        self.assertEqual(failures.values, [1, 1, 1])
        self.assertEqual(published.values, [1])
        self.assertFalse(relay_failed.is_set())
        self.assertFalse(relay_degraded.is_set())


class HealthServerTests(unittest.TestCase):
    def test_allowlisted_ipv6_loopback_binds_with_ipv6_family(self) -> None:
        try:
            server = _health_server(InMemoryRepository(), 0, host="::1")
        except OSError as exc:
            self.skipTest(f"IPv6 loopback unavailable: {exc}")
        try:
            self.assertEqual(server.server_address[0], "::1")
        finally:
            server.shutdown()
            server.server_close()


class BoundedTelemetryShutdownTests(unittest.TestCase):
    def test_provider_shutdown_is_abandoned_at_the_caller_deadline(self) -> None:
        release = threading.Event()

        class StalledProvider:
            def shutdown(self):
                release.wait(timeout=1)

        with patch("ml_scoring.main.LOG.error"):
            self.assertFalse(_shutdown_provider_bounded(
                StalledProvider(), "traces", timeout_seconds=0.01,
            ))
        release.set()

    def test_provider_shutdown_forwards_the_sdk_deadline(self) -> None:
        class Provider:
            kwargs = None

            def shutdown(self, **kwargs):
                self.kwargs = kwargs

        provider = Provider()
        self.assertTrue(_shutdown_provider_bounded(
            provider, "metrics", timeout_seconds=0.1, timeout_millis=2000,
        ))
        self.assertEqual(provider.kwargs, {"timeout_millis": 2000})


class LocalEndpointGuardTests(unittest.TestCase):
    def test_rejects_nonlocal_hosts_advertised_by_kafka_metadata(self) -> None:
        validate_local_kafka_metadata(SimpleNamespace(
            brokers={1: SimpleNamespace(host="localhost"), 2: SimpleNamespace(host="127.0.0.1")},
        ))
        for brokers in ({}, {1: SimpleNamespace(host="kafka")},
                         {1: SimpleNamespace(host="broker.example.com")}):
            with self.subTest(brokers=brokers), self.assertRaisesRegex(
                    RuntimeError, "Kafka metadata advertised"):
                validate_local_kafka_metadata(SimpleNamespace(brokers=brokers))

    def test_accepts_only_local_database_and_kafka_endpoints(self) -> None:
        libpq_overrides = {name: "" for name in
                           ("PGHOST", "PGHOSTADDR", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE")}
        with patch.dict(os.environ, libpq_overrides):
            validate_local_endpoints("postgresql://user:pass@localhost:5432/greenguard_ml",
                                     "127.0.0.1:9092,localhost:9093")
        with self.assertRaisesRegex(RuntimeError, "database must be local"):
            validate_local_endpoints("postgresql://user:pass@db.example.com/greenguard_ml",
                                     "localhost:9092")
        with self.assertRaisesRegex(RuntimeError, "database must be local"):
            validate_local_endpoints("postgresql://user:pass@localhost/greenguard_ml?host=db.prod.example.com&dbname=prod",
                                     "localhost:9092")
        with patch.dict(os.environ, {"PGHOSTADDR": "192.0.2.1"}):
            with self.assertRaisesRegex(RuntimeError, "database must be local"):
                validate_local_endpoints("postgresql://user:pass@localhost/greenguard_ml",
                                         "localhost:9092")
        for broker in ("broker.example.com:9092", "kafka:9093"):
            with self.subTest(broker=broker), self.assertRaisesRegex(RuntimeError, "Kafka brokers must be local"):
                validate_local_endpoints("postgresql://user:pass@localhost/greenguard_ml",
                                         broker)


class InputQualityMetricTests(unittest.TestCase):
    def test_psi_is_exported_as_observable_gauge_without_tenant_labels(self):
        reader = InMemoryMetricReader()
        provider = MeterProvider(metric_readers=[reader])
        latest = {("temperature_c", "model", "version", "shadow"): 0.42}
        register_psi_gauge(provider.get_meter("test"), latest, threading.Lock())
        data = reader.get_metrics_data()
        points = data.resource_metrics[0].scope_metrics[0].metrics[0].data.data_points
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0].value, 0.42)
        self.assertEqual(dict(points[0].attributes), {
            "feature": "temperature_c", "model.name": "model",
            "model.version": "version", "mode": "shadow",
        })
        provider.shutdown()

    class Recorder:
        def __init__(self):
            self.values = []

        def record(self, value, attributes):
            self.values.append((value, attributes))

        def add(self, value, attributes):
            self.values.append((value, attributes))

    def test_measurement_metrics_have_only_bounded_model_and_feature_labels(self):
        key, raw = event(1)
        telemetry = parse_telemetry_recorded(key, raw)
        temperature, humidity, missing = (self.Recorder() for _ in range(3))
        labels = {"model.name": "test-model", "model.version": "v1", "mode": "shadow"}
        record_input_quality(telemetry, "shadow_scored", labels=labels,
                             temperature=temperature, humidity=humidity, missing=missing)
        self.assertEqual(temperature.values, [(25.5, labels)])
        self.assertEqual(humidity.values, [(65.0, labels)])
        self.assertEqual(missing.values, [])

        body = json.loads(raw)
        del body["payload"]["measurements"]["relative_humidity_percent"]
        incomplete = parse_telemetry_recorded(key, json.dumps(body))
        record_input_quality(incomplete, "insufficient_history", labels=labels,
                             temperature=temperature, humidity=humidity, missing=missing)
        self.assertEqual(missing.values, [(1, {"feature": "relative_humidity_percent", **labels})])
        before = (len(temperature.values), len(humidity.values), len(missing.values))
        record_input_quality(telemetry, "duplicate", labels=labels,
                             temperature=temperature, humidity=humidity, missing=missing)
        self.assertEqual(before, (len(temperature.values), len(humidity.values), len(missing.values)))

    def test_online_quality_path_emits_psi_only_when_reference_window_is_ready(self):
        key, raw = event(1)
        telemetry = parse_telemetry_recorded(key, raw)
        reference = {
            "minimum_samples": 1, "window_size": 4, "update_every": 1,
            "features": {
                "temperature_c": {"edges": [0.0, 10.0], "reference_proportions": [0.25, 0.25, 0.5]},
                "relative_humidity_percent": {"edges": [0.0, 50.0], "reference_proportions": [0.25, 0.25, 0.5]},
            },
        }
        psi = record_input_quality(
            telemetry, "shadow_scored", labels={"model.name": "m", "model.version": "v1", "mode": "shadow"},
            temperature=self.Recorder(), humidity=self.Recorder(), missing=self.Recorder(),
            drift_monitors=build_drift_monitors(reference),
        )
        self.assertEqual({name for name, _ in psi}, {"temperature_c", "relative_humidity_percent"})
        self.assertTrue(all(value >= 0 for _, value in psi))


class ShadowEventTests(unittest.TestCase):
    def test_prediction_event_is_stable_shadow_only_and_source_linked(self):
        key, raw = event(23)
        source = parse_telemetry_recorded(key, raw)
        prediction_record = ShadowPrediction(
            prediction_id="12121212-1212-4121-8121-121212121212", tenant_id=TENANT,
            subject_id=BIN, window_end="2026-01-01T05:45:00.000000Z",
            model_name="synthetic-test", model_version="test-v1",
            feature_set_version="telemetry-sequence-v1-24h-15m", revision=0,
            probability=0.25, feature_digest="a" * 64,
            correlation_id=source.correlation_id, causation_id=source.event_id,
            traceparent=source.traceparent,
        )
        occurred = datetime(2026, 1, 1, tzinfo=timezone.utc)
        first = build_shadow_prediction_event(prediction_record, source, occurred)
        second = build_shadow_prediction_event(prediction_record, source, occurred)
        self.assertEqual(first, second)
        self.assertEqual(first["event_type"], "ml.prediction.shadowed")
        self.assertEqual(first["causation_id"], source.event_id)
        self.assertEqual(first["payload"]["source_event_id"], source.event_id)
        self.assertEqual(first["payload"]["mode"], "shadow")
        self.assertIs(first["payload"]["production_eligible"], False)
        with self.assertRaisesRegex(ValueError, "tenant must match"):
            build_shadow_prediction_event(replace(prediction_record, tenant_id="99999999-9999-4999-8999-999999999999"),
                                          source, occurred)


class ShadowOutboxTests(unittest.TestCase):
    class FakeProducer:
        def __init__(self, error=None):
            self.error = error
            self.records = []

        def produce(self, topic, *, key, value, on_delivery):
            self.records.append((topic, key, json.loads(value)))
            self.callback = on_delivery

        def flush(self, _timeout):
            self.callback(self.error, object())
            return 0

    def setUp(self):
        self.repository = InMemoryRepository()
        key, raw = event(23)
        source = parse_telemetry_recorded(key, raw)
        prediction = ShadowPrediction(
            prediction_id="12121212-1212-4121-8121-121212121212", tenant_id=TENANT,
            subject_id=BIN, window_end="2026-01-01T05:45:00.000000Z",
            model_name="synthetic-test", model_version="test-v1",
            feature_set_version="telemetry-sequence-v1-24h-15m", revision=0,
            probability=0.25, feature_digest="a" * 64,
            correlation_id=source.correlation_id, causation_id=source.event_id,
            traceparent=source.traceparent,
        )
        event_body = build_shadow_prediction_event(prediction, source, datetime(2026, 1, 1, tzinfo=timezone.utc))
        with self.repository.tenant_transaction(TENANT) as transaction:
            self.assertTrue(transaction.write_shadow_prediction(prediction, event_body))

    def _add_second_prediction(self):
        key, raw = event(24)
        source = parse_telemetry_recorded(key, raw)
        prediction = ShadowPrediction(
            prediction_id="13131313-1313-4131-8131-131313131313", tenant_id=TENANT,
            subject_id=BIN, window_end="2026-01-01T06:00:00.000000Z",
            model_name="synthetic-test", model_version="test-v1",
            feature_set_version="telemetry-sequence-v1-24h-15m", revision=0,
            probability=0.35, feature_digest="b" * 64,
            correlation_id=source.correlation_id, causation_id=source.event_id,
            traceparent=source.traceparent,
        )
        event_body = build_shadow_prediction_event(
            prediction, source, datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        with self.repository.tenant_transaction(TENANT) as transaction:
            self.assertTrue(transaction.write_shadow_prediction(prediction, event_body))

    def test_publish_waits_for_ack_and_marks_row_once(self):
        producer = self.FakeProducer()
        self.assertEqual(publish_pending_once(self.repository, producer, TENANT), 1)
        self.assertEqual(len(producer.records), 1)
        self.assertEqual(producer.records[0][0], "greenguard.ml.prediction.shadow.v1")
        self.assertEqual(producer.records[0][2]["event_type"], "ml.prediction.shadowed")
        self.assertEqual(producer.records[0][1], f"{TENANT}:{producer.records[0][2]['event_id']}")
        self.assertEqual(publish_pending_once(self.repository, producer, TENANT), 0)
        self.assertEqual(len(producer.records), 1)

    def test_failed_delivery_releases_lease_for_retry(self):
        self._add_second_prediction()
        failed = self.FakeProducer(error=RuntimeError("broker unavailable"))
        with self.assertRaisesRegex(RuntimeError, "broker unavailable"):
            publish_pending_once(self.repository, failed, TENANT, batch_size=2, lease_seconds=60)
        succeeded = self.FakeProducer()
        self.assertEqual(publish_pending_once(
            self.repository, succeeded, TENANT, batch_size=2, lease_seconds=60,
        ), 2)

    def test_fatal_delivery_error_is_distinguished_and_row_remains_retryable(self):
        class FatalKafkaError(RuntimeError):
            def fatal(self):
                return True

        fatal = self.FakeProducer(error=FatalKafkaError("producer fenced"))
        with self.assertRaisesRegex(FatalKafkaProducerError, "fatal producer error"):
            publish_pending_once(self.repository, fatal, TENANT)
        self.assertEqual(publish_pending_once(self.repository, self.FakeProducer(), TENANT), 1)

    def test_fatal_produce_exception_is_distinguished(self):
        class FatalKafkaError(RuntimeError):
            def fatal(self):
                return True

        class FatalProduce(self.FakeProducer):
            def produce(self, *_args, **_kwargs):
                raise FatalKafkaError("producer fenced")

        with self.assertRaisesRegex(FatalKafkaProducerError, "fatal state"):
            publish_pending_once(self.repository, FatalProduce(), TENANT)
        self.assertEqual(publish_pending_once(self.repository, self.FakeProducer(), TENANT), 1)

    def test_shutdown_releases_unstarted_rows_in_the_leased_batch(self):
        self._add_second_prediction()
        stop = threading.Event()
        stop.set()
        producer = self.FakeProducer()
        self.assertEqual(publish_pending_once(
            self.repository, producer, TENANT, batch_size=2, lease_seconds=60, stop=stop,
        ), 0)
        self.assertEqual(producer.records, [])
        succeeded = self.FakeProducer()
        self.assertEqual(publish_pending_once(
            self.repository, succeeded, TENANT, batch_size=2, lease_seconds=60,
        ), 2)

    def test_shutdown_after_ack_keeps_published_row_and_releases_the_rest(self):
        self._add_second_prediction()
        stop = threading.Event()

        class StopAfterAck(self.FakeProducer):
            def flush(inner_self, timeout):
                super(StopAfterAck, inner_self).flush(timeout)
                stop.set()
                return 0

        first = StopAfterAck()
        self.assertEqual(publish_pending_once(
            self.repository, first, TENANT, batch_size=2, lease_seconds=60, stop=stop,
        ), 1)
        second = self.FakeProducer()
        self.assertEqual(publish_pending_once(self.repository, second, TENANT), 1)
        first_ids = {record[2]["aggregate_id"] for record in first.records}
        second_ids = {record[2]["aggregate_id"] for record in second.records}
        self.assertTrue(first_ids.isdisjoint(second_ids))

    def test_rejects_a_lease_shorter_than_the_delivery_batch_bound(self):
        with self.assertRaisesRegex(ValueError, "lease.*shorter than batch"):
            publish_pending_once(
                self.repository, self.FakeProducer(), TENANT,
                batch_size=2, lease_seconds=30, delivery_timeout_seconds=10,
            )

    def test_single_row_lease_matches_shared_database_mark_timeout(self):
        with self.assertRaisesRegex(ValueError, "lease.*shorter than batch"):
            publish_pending_once(
                self.repository, self.FakeProducer(), TENANT,
                batch_size=1, lease_seconds=29, delivery_timeout_seconds=10,
            )
        self.assertEqual(publish_pending_once(
            self.repository, self.FakeProducer(), TENANT,
            batch_size=1, lease_seconds=30, delivery_timeout_seconds=10,
        ), 1)

    def test_producer_message_timeout_matches_delivery_flush_bound(self):
        config = _outbox_producer_config({
            "bootstrap.servers": "localhost:9092",
            "security.protocol": "PLAINTEXT",
            "client.id": "test-scorer",
            "socket.timeout.ms": 5_000,
            "socket.connection.setup.timeout.ms": 5_000,
            "request.timeout.ms": 10_000,
            "unrelated.secret": "must-not-propagate",
        })
        self.assertEqual(config["message.timeout.ms"], 10_000)
        self.assertEqual(config["socket.timeout.ms"], 5_000)
        self.assertEqual(config["socket.connection.setup.timeout.ms"], 5_000)
        self.assertEqual(config["request.timeout.ms"], 10_000)
        self.assertNotIn("unrelated.secret", config)
        self.assertTrue(config["enable.idempotence"])
        self.assertEqual(config["acks"], "all")


class BoundedStateTests(unittest.TestCase):
    def test_rejects_more_devices_than_the_bin_limit(self) -> None:
        repository = InMemoryRepository()
        processor = ShadowScoringProcessor(FakeModel(), repository, synthetic_tenant_id=TENANT,
                                           expected_sensor_count=1)
        key1, raw1 = event(0, device_id=DEVICE)
        processor.process(INPUT_TOPIC, key1, raw1, partition=0, offset=0)
        other_device = "12121212-1212-4121-8121-121212121212"
        key2, raw2 = event(1, device_id=other_device)
        with self.assertRaises(BinDeviceLimitExceeded):
            processor.process(INPUT_TOPIC, key2, raw2, partition=0, offset=1)


class RepositoryConfigurationTests(unittest.TestCase):
    def test_drift_status_is_tenant_scoped_and_transactional(self) -> None:
        repository = InMemoryRepository()
        with repository.tenant_transaction(TENANT) as transaction:
            transaction.upsert_drift_status("model", "v1", "temperature_c", 0.3, 512)
            self.assertEqual(transaction.load_drift_status("model", "v1"),
                             {"temperature_c": (0.3, 512)})
        with repository.tenant_transaction("99999999-9999-4999-8999-999999999999") as transaction:
            self.assertEqual(transaction.load_drift_status("model", "v1"), {})

    def test_drift_window_checkpoint_is_persisted_and_tenant_scoped(self) -> None:
        from ml_scoring.deployment import RollingPSIMonitor

        repository = InMemoryRepository()
        monitor = RollingPSIMonitor(edges=[1.0, 2.0], reference_proportions=[.25, .5, .25],
                                    minimum_samples=2, window_size=4, update_every=1)
        monitor.observe(1.5)
        monitor.observe(3.0)
        state = monitor.export_state()
        with repository.tenant_transaction(TENANT) as transaction:
            transaction.upsert_drift_status("model", "v1", "temperature_c",
                                             state["current_psi"], len(state["bins"]), state)
            self.assertEqual(transaction.load_drift_window("model", "v1", "temperature_c"), state)
        with repository.tenant_transaction("99999999-9999-4999-8999-999999999999") as transaction:
            self.assertIsNone(transaction.load_drift_window("model", "v1", "temperature_c"))

    def test_drift_status_rejects_unbounded_or_invalid_values(self) -> None:
        repository = InMemoryRepository()
        with repository.tenant_transaction(TENANT) as transaction:
            for values in (("model", "v1", "other", 0.1, 10),
                           ("model", "v1", "temperature_c", float("nan"), 10),
                           ("model", "v1", "temperature_c", 0.1, 0),
                           ("model", "v1", "temperature_c", True, 10),
                           ("model", "v1", "temperature_c", 0.1, True),
                           ("model", "v1", "temperature_c", 0.1, 100_001),
                           ("m" * 129, "v1", "temperature_c", 0.1, 10)):
                with self.subTest(values=values), self.assertRaises(ValueError):
                    transaction.upsert_drift_status(*values)

    def test_postgres_connection_pool_has_a_hard_limit(self) -> None:
        with patch("psycopg_pool.ConnectionPool") as pool_constructor:
            repository = PostgresRepository("postgresql://user:pass@localhost/greenguard_ml")
            kwargs = pool_constructor.call_args.kwargs
            self.assertEqual(kwargs["min_size"], 1)
            self.assertEqual(kwargs["max_size"], 4)
            self.assertEqual(kwargs["max_waiting"], 16)
            self.assertEqual(kwargs["timeout"], 5)
            self.assertEqual(kwargs["kwargs"], {
                "connect_timeout": 5,
                "keepalives": 1,
                "keepalives_idle": 5,
                "keepalives_interval": 2,
                "keepalives_count": 3,
                "tcp_user_timeout": 8_000,
                "options": "-c statement_timeout=5000",
            })
            self.assertEqual(kwargs["check"], pool_constructor.check_connection)
            pool_constructor.return_value.close.assert_not_called()
            repository.close()
            pool_constructor.return_value.close.assert_called_once_with(timeout=5)

    def test_malformed_persisted_state_is_a_deterministic_scoring_error(self) -> None:
        repository = InMemoryRepository()
        repository._states[(TENANT, BIN)] = {
            "devices": {DEVICE: [{"observed_at": "not-a-timestamp"}]}
        }
        processor = ShadowScoringProcessor(FakeModel(), repository, synthetic_tenant_id=TENANT,
                                           expected_sensor_count=1)
        key, raw = event(0)
        with self.assertRaises(CorruptBinWindowState):
            processor.process(INPUT_TOPIC, key, raw, partition=0, offset=99)


class KafkaCommitTests(unittest.TestCase):
    def test_nonfatal_rebalance_commit_error_allows_safe_replay(self) -> None:
        class ConsumerStub:
            def commit(self, **kwargs):
                raise KafkaException(KafkaError(KafkaError._ALL_BROKERS_DOWN))

        self.assertFalse(commit_offset_after_processing(ConsumerStub(), object()))

    def test_fatal_commit_error_still_fails_the_consumer(self) -> None:
        class FatalError:
            @staticmethod
            def fatal() -> bool:
                return True

        class ConsumerStub:
            def commit(self, **kwargs):
                raise KafkaException(FatalError())

        with self.assertRaises(KafkaException):
            commit_offset_after_processing(ConsumerStub(), object())


if __name__ == "__main__":
    unittest.main()
