"""Synthetic-only release rehearsal controls; no deployment credentials or services."""
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from ml_scoring.deployment import (
    CohortConfig, DeploymentGateError, GuardrailSnapshot, LocalReleaseController,
    PromotionEvidence, RehearsalObservation, RollingPSIMonitor,
    population_stability_index, require_promotion_evidence, rollback_reasons, select_mode,
)


class SyntheticRegistry:
    """Test double for control transitions; actual registry is covered separately."""
    def __init__(self):
        self.corrupt = False
        self.production = False

    def load(self, name, version):
        if self.corrupt or version not in {"baseline-v1", "candidate-v2"}:
            raise ValueError("model checksum mismatch")
        return SimpleNamespace(manifest=SimpleNamespace(
            model_version=version, artifact_sha256=hashlib.sha256(version.encode()).hexdigest(),
            feature_set_version="telemetry-sequence-v1-24h-15m", synthetic_only=True,
            production_eligible=self.production,
            drift_reference={"training_split_fingerprint": "a" * 64},
        ))


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


class ReleaseLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "rehearsal.json"
        self.registry = SyntheticRegistry()
        self.controller = self.new_controller()
        self.controller.initialize("baseline-v1")
        self.healthy = GuardrailSnapshot(0.001, 25.0, 5.0, 1.0, 0.01)

    def new_controller(self):
        return LocalReleaseController(self.path, self.registry, enabled=True, environment="local-synthetic")

    def start(self):
        staged = self.controller.stage_candidate("candidate-v2", expected_revision=1)
        return self.controller.start_canary(percentage=5, now=1000, approval_id="rehearsal-approval",
                                            expected_revision=staged["revision"])

    def observation(self, **changes):
        return replace(RehearsalObservation("observation-1", "candidate-v2",
            hashlib.sha256(b"candidate-v2").hexdigest(), 1300, 200, self.healthy), **changes)

    def test_disabled_by_default_and_nonlocal_environments_rejected(self):
        with self.assertRaisesRegex(DeploymentGateError, "explicit local-synthetic"):
            LocalReleaseController(self.path, self.registry)
        for environment in ("production", "cluster-synthetic", "local", "disabled"):
            with self.subTest(environment=environment), self.assertRaises(DeploymentGateError):
                LocalReleaseController(self.path, self.registry, enabled=True, environment=environment)
        with self.assertRaises(DeploymentGateError):
            LocalReleaseController(self.path, self.registry, enabled="true", environment="local-synthetic")

    def test_rolling_psi_checkpoint_restores_exact_future_window_and_rejects_corruption(self):
        kwargs = dict(edges=[1.0, 2.0], reference_proportions=[.25, .5, .25],
                      minimum_samples=3, window_size=5, update_every=2)
        uninterrupted = RollingPSIMonitor(**kwargs)
        observed = [0.0, 1.5, 4.0, 1.8, .5, 3.0]
        for value in observed[:4]:
            uninterrupted.observe(value)
        checkpoint = uninterrupted.export_state()
        restarted = RollingPSIMonitor(**kwargs)
        restarted.restore_state(checkpoint)
        for value in observed[4:]:
            self.assertEqual(uninterrupted.observe(value), restarted.observe(value))
        self.assertEqual(uninterrupted.export_state(), restarted.export_state())
        corrupted = {**checkpoint, "counts": (0, 0, 0)}
        with self.assertRaises(DeploymentGateError):
            restarted.restore_state(corrupted)

    def test_canary_champion_and_rollback_rehearsal_are_durable_and_shadow(self):
        self.start()
        state = self.controller.observe(self.observation(), now=1301, expected_revision=3)
        self.assertTrue(state["latest"]["healthy"])
        restarted = self.new_controller()
        self.assertEqual(restarted.snapshot(), state)
        champion = restarted.promote_rehearsal(now=1302, approval_id="local-review", expected_revision=4)
        self.assertEqual(champion["stage"], "champion_rehearsal")
        selected = restarted.rehearsal_selection("synthetic-tenant", salt="test-only")
        self.assertEqual(selected["hypothetical_model"]["model_version"], "candidate-v2")
        self.assertEqual(selected["serving_mode"], "shadow")
        rolled = restarted.rollback(approval_id="local-stop", expected_revision=5)
        self.assertEqual(rolled["stage"], "rolled_back")
        self.assertEqual(rolled["percentage"], 0)
        self.assertEqual(restarted.rehearsal_selection("synthetic-tenant", salt="test-only")
                         ["hypothetical_model"]["model_version"], "baseline-v1")
        self.assertEqual(restarted.serving_mode(), "shadow")
        self.assertIn("approval_sha256", rolled["audit"][-1])
        self.assertEqual(restarted.rollback(approval_id="repeat", expected_revision=6), rolled)

    def test_canary_selection_is_stable_and_bounded(self):
        self.start()
        choices = [self.controller.rehearsal_selection(f"synthetic-{i}", salt="seed")
                   ["hypothetical_model"]["model_version"] for i in range(100)]
        self.assertGreater(choices.count("candidate-v2"), 0)
        self.assertLess(choices.count("candidate-v2"), 15)
        self.assertEqual(self.controller.rehearsal_selection("synthetic-1", salt="seed"),
                         self.controller.rehearsal_selection("synthetic-1", salt="seed"))
        for percentage in (0, -1, 11, float("nan"), True):
            with self.subTest(percentage=percentage), self.assertRaises(DeploymentGateError):
                self.controller.start_canary(percentage=percentage, now=1000, approval_id="review",
                                             expected_revision=3)

    def test_each_guardrail_breach_rolls_back_and_blocks_promotion(self):
        breaches = {"missing_prediction_rate": .02, "tier_a_p99_ms": 51,
                    "consumer_lag_seconds": 301, "watermark_stalled_seconds": 301,
                    "prediction_psi": .26, "confirmed_real_fault_annotations": 1}
        for metric, value in breaches.items():
            with self.subTest(metric=metric), tempfile.TemporaryDirectory() as root:
                control = LocalReleaseController(Path(root) / "state.json", self.registry,
                                                enabled=True, environment="local-synthetic")
                control.initialize("baseline-v1")
                control.stage_candidate("candidate-v2", expected_revision=1)
                control.start_canary(percentage=1, now=1000, approval_id="review", expected_revision=2)
                observation = self.observation(guardrails=replace(self.healthy, **{metric: value}))
                state = control.observe(observation, now=1300, expected_revision=3)
                self.assertEqual(state["stage"], "rolled_back")
                self.assertTrue(state["audit"][-1]["reasons"])
                self.assertEqual(control.rehearsal_selection("synthetic-tenant", salt="seed")
                                 ["hypothetical_model"]["model_version"], "baseline-v1")
                with self.assertRaises(DeploymentGateError):
                    control.promote_rehearsal(now=1301, approval_id="review", expected_revision=4)

    def test_nonfinite_negative_stale_and_future_observations_trigger_rollback(self):
        for metric, captured_at, now in (
            (float("nan"), 1300, 1300), (-1, 1300, 1300), (0.01, 1300, 1601), (0.01, 1300, 1299),
        ):
            with self.subTest(metric=metric, now=now), tempfile.TemporaryDirectory() as root:
                control = LocalReleaseController(Path(root) / "state.json", self.registry,
                                                enabled=True, environment="local-synthetic")
                control.initialize("baseline-v1")
                control.stage_candidate("candidate-v2", expected_revision=1)
                control.start_canary(percentage=1, now=1000, approval_id="review", expected_revision=2)
                observation = self.observation(captured_at=captured_at,
                                              guardrails=replace(self.healthy, prediction_psi=metric))
                self.assertEqual(control.observe(observation, now=now, expected_revision=3)
                                 ["stage"], "rolled_back")
                self.assertNotIn("NaN", (Path(root) / "state.json").read_text())

    def test_observation_replay_is_idempotent_and_conflicts_rejected(self):
        self.start()
        original = self.controller.observe(self.observation(), now=1301, expected_revision=3)
        self.assertEqual(self.controller.observe(self.observation(), now=1302, expected_revision=4), original)
        with self.assertRaisesRegex(DeploymentGateError, "replay changed"):
            self.controller.observe(self.observation(sample_count=201), now=1302, expected_revision=4)
        with self.assertRaisesRegex(DeploymentGateError, "out-of-order"):
            self.controller.observe(self.observation(observation_id="new-id", captured_at=1299),
                                    now=1302, expected_revision=4)
        self.assertEqual(self.controller.snapshot(), original)

    def test_nonfinite_metrics_after_healthy_evidence_persist_rollback_and_block_promotion(self):
        metrics = ("missing_prediction_rate", "tier_a_p99_ms", "consumer_lag_seconds",
                   "watermark_stalled_seconds", "prediction_psi")
        for metric in metrics:
            for value in (float("inf"), float("-inf"), float("nan")):
                with self.subTest(metric=metric, value=value), tempfile.TemporaryDirectory() as root:
                    path = Path(root) / "state.json"
                    control = LocalReleaseController(path, self.registry,
                                                    enabled=True, environment="local-synthetic")
                    control.initialize("baseline-v1")
                    control.stage_candidate("candidate-v2", expected_revision=1)
                    control.start_canary(percentage=1, now=1000, approval_id="review", expected_revision=2)
                    healthy = control.observe(self.observation(), now=1300, expected_revision=3)
                    self.assertTrue(healthy["latest"]["healthy"])
                    degraded = self.observation(observation_id="nonfinite", captured_at=1301,
                                               guardrails=replace(self.healthy, **{metric: value}))
                    rolled = control.observe(degraded, now=1301, expected_revision=4)
                    self.assertEqual(rolled["stage"], "rolled_back")
                    self.assertFalse(rolled["latest"]["healthy"])
                    self.assertEqual(rolled["latest"]["captured_at"], 1301)
                    self.assertIn(f"{metric}_non_finite", rolled["audit"][-1]["reasons"])
                    restarted = LocalReleaseController(path, self.registry,
                                                       enabled=True, environment="local-synthetic")
                    self.assertEqual(restarted.snapshot(), rolled)
                    with self.assertRaises(DeploymentGateError):
                        restarted.promote_rehearsal(now=1302, approval_id="review", expected_revision=5)
                    self.assertNotIn("NaN", path.read_text())
                    self.assertNotIn("Infinity", path.read_text())

    def test_observation_and_audit_history_are_bounded_and_evicted_replays_refused(self):
        self.start()
        revision = 3
        for index in range(130):
            now = 1300 + index
            result = self.controller.observe(self.observation(observation_id=f"observation-{index}",
                                                             captured_at=now),
                                             now=now, expected_revision=revision)
            revision = result["revision"]
        self.assertEqual(len(result["observations"]), 128)
        self.assertEqual(len(result["audit"]), 128)
        with self.assertRaisesRegex(DeploymentGateError, "out-of-order"):
            self.controller.observe(self.observation(observation_id="observation-0"), now=1430,
                                    expected_revision=revision)

    def test_retraining_handoff_tamper_and_symlinked_candidate_receipt_are_refused(self):
        request = self.controller.request_retraining(feature="temperature_c", psi=.3, sample_count=200,
                                                    now=1000, expected_revision=1)["retraining"]
        package = self.package()
        payload = (package / "evaluation.json").read_bytes()
        target = self.path.parent / "payload.json"
        target.write_bytes(payload)
        (package / "evaluation.json").unlink()
        (package / "evaluation.json").symlink_to(target)
        with self.assertRaises(DeploymentGateError):
            self.controller.record_retraining_result(package, request_id=request["request_id"], expected_revision=2)
        state = json.loads(self.path.read_bytes())
        state["retraining"]["psi"] = 0.4
        self.path.write_bytes(canonical(state))
        with self.assertRaisesRegex(DeploymentGateError, "failed validation"):
            self.controller.snapshot()

    def test_wrong_artifact_version_and_invalid_samples_fail_closed(self):
        self.start()
        for changes in ({"artifact_sha256": "f" * 64}, {"model_version": "baseline-v1"},
                        {"sample_count": True}, {"sample_count": 0}, {"sample_count": 1_000_001},
                        {"observation_id": "x" * 129}, {"captured_at": float("nan")},
                        {"guardrails": replace(self.healthy, prediction_psi="invalid")}):
            with self.subTest(changes=changes), self.assertRaises(DeploymentGateError):
                self.controller.observe(self.observation(**changes), now=1301, expected_revision=3)
        self.assertEqual(self.controller.snapshot()["revision"], 3)

    def test_promotion_requires_dwell_freshness_and_sample_floor(self):
        self.start()
        with self.assertRaises(DeploymentGateError):
            self.controller.promote_rehearsal(now=1300, approval_id="review", expected_revision=3)
        self.controller.observe(self.observation(captured_at=1100, sample_count=199), now=1101,
                                expected_revision=3)
        with self.assertRaises(DeploymentGateError):
            self.controller.promote_rehearsal(now=1300, approval_id="review", expected_revision=4)
        self.controller.observe(self.observation(observation_id="fresh", captured_at=1300), now=1301,
                                expected_revision=4)
        with self.assertRaises(DeploymentGateError):
            self.controller.promote_rehearsal(now=1601, approval_id="review", expected_revision=5)
        self.assertEqual(self.controller.promote_rehearsal(now=1302, approval_id="review",
                                                         expected_revision=5)["stage"], "champion_rehearsal")

    def test_rollback_also_applies_after_champion_rehearsal(self):
        self.start()
        self.controller.observe(self.observation(), now=1300, expected_revision=3)
        self.controller.promote_rehearsal(now=1300, approval_id="review", expected_revision=4)
        observation = self.observation(observation_id="degraded", captured_at=1301,
                                       guardrails=replace(self.healthy, consumer_lag_seconds=400))
        self.assertEqual(self.controller.observe(observation, now=1301, expected_revision=5)
                         ["stage"], "rolled_back")

    def test_stale_revision_and_concurrent_writers_do_not_lose_updates(self):
        self.controller.stage_candidate("candidate-v2", expected_revision=1)
        def start(_):
            try:
                return self.new_controller().start_canary(percentage=1, now=1000,
                                                          approval_id="review", expected_revision=2)["revision"]
            except DeploymentGateError:
                return "stale"
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(start, range(2))), [3, "stale"])
        with self.assertRaisesRegex(DeploymentGateError, "stale"):
            self.controller.rollback(approval_id="review", expected_revision=2)

    def test_atomic_write_failure_preserves_previous_state(self):
        before = self.path.read_bytes()
        with patch("ml_scoring.deployment.os.replace", side_effect=OSError("injected failure")):
            with self.assertRaises(OSError):
                self.controller.stage_candidate("candidate-v2", expected_revision=1)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob(".local-release-*")), [])

    def test_contended_file_lock_fails_immediately_without_mutating_state(self):
        before = self.path.read_bytes()
        with self.controller._locked():
            with self.assertRaisesRegex(DeploymentGateError, "busy"):
                self.new_controller().stage_candidate("candidate-v2", expected_revision=1)
        self.assertEqual(self.path.read_bytes(), before)

    def test_registry_reverification_rejects_changed_or_production_models(self):
        self.start()
        self.registry.corrupt = True
        with self.assertRaises(DeploymentGateError):
            self.controller.snapshot()
        self.registry.corrupt = False
        self.registry.production = True
        with self.assertRaises(DeploymentGateError):
            self.controller.snapshot()

    def test_corrupt_oversized_or_symlinked_state_is_refused(self):
        original = self.path.read_bytes()
        for state in ({"revision": 1}, {**json.loads(original), "serving_mode": "champion"},
                      {**json.loads(original), "percentage": float("nan")},
                      {**json.loads(original), "latest": {"captured_at": 1, "healthy": "true", "sample_count": 1}}):
            self.path.write_text(json.dumps(state))
            with self.assertRaises(DeploymentGateError):
                self.controller.snapshot()
        self.path.write_bytes(b" " * 131_073)
        with self.assertRaises(DeploymentGateError):
            self.controller.snapshot()
        self.path.unlink()
        target = self.path.with_name("target.json")
        target.write_bytes(original)
        self.path.symlink_to(target)
        with self.assertRaises(DeploymentGateError):
            self.new_controller()

    def test_request_retraining_records_digest_only_handoff_without_running_training(self):
        state = self.controller.request_retraining(feature="temperature_c", psi=.3, sample_count=200,
                                                  now=1000, expected_revision=1)
        request = state["retraining"]
        self.assertEqual(request["status"], "requested")
        self.assertEqual(request["recipe"], "ml.classical.retrain_synthetic_candidate.run")
        self.assertFalse(request["production_eligible"])
        self.assertEqual(request["source"]["training_split_fingerprint"], "a" * 64)
        self.assertEqual(self.controller.request_retraining(feature="temperature_c", psi=.3,
                         sample_count=200, now=1000, expected_revision=2), state)
        with self.assertRaises(DeploymentGateError):
            self.controller.request_retraining(feature="temperature_c", psi=.4, sample_count=200,
                                              now=999, expected_revision=2)
        for kwargs in ({"feature": "tenant-id"}, {"psi": float("nan")}, {"psi": .25},
                       {"sample_count": 199}, {"sample_count": 100_001}):
            arguments = dict(feature="temperature_c", psi=.3, sample_count=200, now=1001,
                             expected_revision=2)
            arguments.update(kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(DeploymentGateError):
                self.controller.request_retraining(**arguments)

    def package(self, **changes):
        report = {"schema_version": "greenguard-offline-candidate-evaluation-v1",
                  "synthetic_only": True, "production_eligible": False, "promotion_eligible": False}
        payload = canonical(report)
        manifest = {"schema_version": "greenguard-offline-candidate-package-v1",
                    "data_origin": "synthetic_grain_sim", "synthetic_only": True,
                    "production_eligible": False, "promotion_eligible": False,
                    "selected_model": None, "champion": None,
                    "files": {"evaluation.json": {"sha256": hashlib.sha256(payload).hexdigest(),
                                                   "bytes": len(payload)}}}
        manifest.update(changes)
        candidate_id = hashlib.sha256(canonical(manifest)).hexdigest()
        manifest["candidate_id"] = candidate_id
        package = self.path.parent / candidate_id
        package.mkdir(exist_ok=True)
        (package / "manifest.json").write_bytes(canonical(manifest))
        (package / "evaluation.json").write_bytes(payload)
        return package

    def test_verified_retraining_receipt_does_not_register_or_select_candidate(self):
        request = self.controller.request_retraining(feature="temperature_c", psi=.3, sample_count=200,
                                                    now=1000, expected_revision=1)["retraining"]
        package = self.package()
        result = self.controller.record_retraining_result(package, request_id=request["request_id"],
                                                         expected_revision=2)
        self.assertEqual(result["retraining"]["status"], "verified_offline")
        self.assertEqual(result["retraining"]["candidate_id"], package.name)
        self.assertIsNone(result["candidate"])
        self.assertEqual(result["stage"], "shadow")
        self.assertEqual(self.controller.record_retraining_result(package, request_id=request["request_id"],
                                                                  expected_revision=3), result)
        (package / "evaluation.json").write_bytes(b"corrupted")
        with self.assertRaisesRegex(DeploymentGateError, "failed verification"):
            self.controller.record_retraining_result(package, request_id=request["request_id"], expected_revision=3)

    def test_invalid_or_production_candidate_receipts_are_rejected(self):
        request = self.controller.request_retraining(feature="temperature_c", psi=.3, sample_count=200,
                                                    now=1000, expected_revision=1)["retraining"]
        for changes in ({"production_eligible": True}, {"synthetic_only": False}, {"champion": "model"},
                        {"files": {}}, {"promotion_eligible": True}):
            package = self.package(**changes)
            with self.subTest(changes=changes), self.assertRaises(DeploymentGateError):
                self.controller.record_retraining_result(package, request_id=request["request_id"],
                                                        expected_revision=2)
        with self.assertRaisesRegex(DeploymentGateError, "current retraining"):
            self.controller.record_retraining_result(self.package(), request_id="f" * 64, expected_revision=2)
        package = self.package()
        (package / "extra.json").write_text("{}")
        with self.assertRaises(DeploymentGateError):
            self.controller.record_retraining_result(package, request_id=request["request_id"], expected_revision=2)

    def test_production_promotion_unavailable_even_with_claimed_qualifying_evidence(self):
        evidence = PromotionEvidence(True, 50, 5, 3, 2000, 0.0, True, "approval", True)
        with self.assertRaisesRegex(DeploymentGateError, "unavailable"):
            self.controller.require_production_promotion(evidence)
        with self.assertRaisesRegex(DeploymentGateError, "synthetic"):
            self.controller.require_production_promotion(replace(evidence, real_ground_truth=False))


class BoundedReleasePredicateTests(unittest.TestCase):
    def test_tenant_canary_selection_requires_explicit_qualifying_promotion_evidence(self):
        config = CohortConfig(enabled=True, percentage=100, mode="canary")
        with self.assertRaisesRegex(DeploymentGateError, "requires promotion evidence"):
            select_mode("synthetic-tenant", config, salt="salt", model_production_eligible=True)
        evidence = PromotionEvidence(True, 50, 5, 3, 2000, 0.0, True, "approval", True)
        with self.assertRaisesRegex(DeploymentGateError, "synthetic"):
            select_mode("synthetic-tenant", config, salt="salt", model_production_eligible=True,
                        promotion_evidence=replace(evidence, real_ground_truth=False))
        self.assertEqual(select_mode("tenant", config, salt="salt", model_production_eligible=True,
                                    promotion_evidence=evidence), "canary")
        self.assertEqual(select_mode("tenant", CohortConfig(), salt="salt", model_production_eligible=False),
                         "shadow")
        denied = replace(config, denylist=frozenset({"tenant"}))
        self.assertEqual(select_mode("tenant", denied, salt="salt", model_production_eligible=False), "shadow")

    def test_counts_flags_and_negative_guardrails_fail_closed(self):
        healthy = GuardrailSnapshot(0, 0, 0, 0, 0)
        self.assertIn("prediction_psi_out_of_range", rollback_reasons(replace(healthy, prediction_psi=-1)))
        self.assertIn("invalid_annotation_counts", rollback_reasons(replace(healthy, advisory_count=True)))
        self.assertIn("invalid_annotation_counts", rollback_reasons(replace(healthy, false_dismissals=1)))
        self.assertIn("missing_prediction_rate_non_finite", rollback_reasons(replace(healthy, missing_prediction_rate=True)))
        evidence = PromotionEvidence(True, 50, 5, 3, 2000, 0.0, True, "approval", True)
        for kwargs in ({"test_examples": float("nan")}, {"pooled_consent_count": True},
                       {"model_card_present": "true"}, {"real_ground_truth": "true"},
                       {"human_approval_id": "  "}, {"minimum_quality_gate_passed": 1},
                       {"export_parity_max_abs_error": False}):
            with self.subTest(kwargs=kwargs), self.assertRaises(DeploymentGateError):
                require_promotion_evidence(replace(evidence, **kwargs))
        with self.assertRaises(DeploymentGateError):
            CohortConfig(enabled="true", mode="canary")
        with self.assertRaises(DeploymentGateError):
            select_mode("synthetic", CohortConfig(enabled=True, percentage=100, mode="canary"),
                        salt="salt", model_production_eligible="true")

    def test_histogram_samples_edges_and_window_settings_are_bounded(self):
        with self.assertRaisesRegex(DeploymentGateError, "bounded sample"):
            population_stability_index(range(100_001), [0], [0, 1])
        with self.assertRaisesRegex(DeploymentGateError, "bounded sample"):
            population_stability_index([0], [0], list(range(1025)))
        with self.assertRaises(DeploymentGateError):
            population_stability_index([True], [0], [0, 1])
        with self.assertRaises(DeploymentGateError):
            RollingPSIMonitor(edges=[0, 1], reference_proportions=[1/3] * 3,
                              minimum_samples=True, window_size=10, update_every=1)

    def test_real_registry_bundle_verification_is_used_and_tampering_fails_closed(self):
        from ml_scoring.registry import ModelRegistry
        import shutil
        import torch
        torch.set_num_threads(1)
        root = Path(__file__).resolve().parents[3] / "evidence" / "model-registry"
        bundles = sorted((root / "greenguard.hotspot-transition.classifier").glob("*/manifest.json"))
        bundles = [path for path in bundles if json.loads(path.read_bytes()).get("drift_reference_file")]
        self.assertTrue(bundles, "at least one immutable synthetic registry bundle is required")
        version = json.loads(bundles[0].read_bytes())["model_version"]
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            registry_root = directory / "registry"
            shutil.copytree(root / "greenguard.hotspot-transition.classifier" / version,
                            registry_root / "greenguard.hotspot-transition.classifier" / version)
            control = LocalReleaseController(directory / "state.json", ModelRegistry(registry_root,
                                             allow_synthetic_shadow=True), enabled=True, environment="local-synthetic")
            state = control.initialize(version)
            self.assertFalse(state["production_eligible"])
            artifact = registry_root / "greenguard.hotspot-transition.classifier" / version / "weights.pt"
            artifact.write_bytes(artifact.read_bytes() + b"tamper")
            with self.assertRaisesRegex(DeploymentGateError, "failed validation"):
                control.snapshot()


if __name__ == "__main__":
    unittest.main()
