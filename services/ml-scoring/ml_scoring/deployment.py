"""Fail-closed cohort selection, drift statistics, and promotion/rollback gates."""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
from dataclasses import asdict
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from collections import deque
from threading import Lock
from typing import Iterable


class DeploymentGateError(ValueError):
    """A rollout request does not satisfy its safety gates."""


MAX_PSI_WINDOW = 100_000
MAX_HISTOGRAM_EDGES = 1024


def _finite_number(value: object) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _bounded_values(values: Iterable[float], limit: int) -> list[float]:
    result = []
    for value in values:
        if len(result) >= limit:
            raise DeploymentGateError("input exceeds bounded sample limit")
        if not _finite_number(value):
            raise DeploymentGateError("inputs must be finite numbers")
        result.append(value)
    return result


@dataclass(frozen=True)
class CohortConfig:
    enabled: bool = False
    percentage: float = 0.0
    allowlist: frozenset[str] = frozenset()
    denylist: frozenset[str] = frozenset()
    mode: str = "shadow"

    def __post_init__(self) -> None:
        if type(self.enabled) is not bool:
            raise DeploymentGateError("cohort enabled must be a boolean")
        if (not _finite_number(self.percentage)
                or not 0.0 <= self.percentage <= 100.0):
            raise DeploymentGateError("cohort percentage must be from 0 through 100")
        for members in (self.allowlist, self.denylist):
            if (not isinstance(members, frozenset) or len(members) > 10_000
                    or any(not isinstance(value, str) or not 1 <= len(value) <= 128 for value in members)):
                raise DeploymentGateError("cohort membership must be a bounded immutable set")
        if self.mode not in {"shadow", "canary", "champion"}:
            raise DeploymentGateError("unsupported model serving mode")
        if self.mode != "shadow" and not self.enabled:
            raise DeploymentGateError("non-shadow rollout requires an enabled cohort")


def tenant_bucket(tenant_id: str, salt: str) -> float:
    if (not isinstance(tenant_id, str) or not 1 <= len(tenant_id) <= 128
            or not isinstance(salt, str) or not 1 <= len(salt) <= 128):
        raise DeploymentGateError("tenant and rollout salt are required")
    digest = hashlib.sha256(f"{salt}\0{tenant_id}".encode()).digest()
    value = int.from_bytes(digest[:8], "big")
    return value / 2**64 * 100.0


def select_mode(tenant_id: str, config: CohortConfig, *, salt: str,
                model_production_eligible: bool,
                promotion_evidence: PromotionEvidence | None = None) -> str:
    if tenant_id in config.denylist:
        return "shadow"
    if config.mode == "shadow" or not config.enabled:
        return "shadow"
    if model_production_eligible is not True:
        raise DeploymentGateError("unvalidated models cannot enter a tenant canary/champion cohort")
    if type(promotion_evidence) is not PromotionEvidence:
        raise DeploymentGateError("tenant canary/champion selection requires promotion evidence")
    require_promotion_evidence(promotion_evidence)
    eligible = tenant_id in config.allowlist or tenant_bucket(tenant_id, salt) < config.percentage
    return config.mode if eligible else "shadow"


def population_stability_index(reference: Iterable[float], observed: Iterable[float],
                                edges: list[float]) -> float:
    """PSI with fixed reference quantile edges and bounded eps smoothing."""
    reference_values = _bounded_values(reference, MAX_PSI_WINDOW)
    observed_values = _bounded_values(observed, MAX_PSI_WINDOW)
    edges = _bounded_values(edges, MAX_HISTOGRAM_EDGES)
    if not reference_values or not observed_values or len(edges) < 2:
        raise DeploymentGateError("PSI needs nonempty samples and at least two fixed bin edges")
    if any(not math.isfinite(x) for x in reference_values + observed_values + edges):
        raise DeploymentGateError("PSI inputs must be finite")
    if sorted(edges) != edges or len(set(edges)) != len(edges):
        raise DeploymentGateError("PSI edges must be strictly increasing")
    counts = _histogram_counts(reference_values, edges)
    total = len(reference_values)
    proportions = [count / total for count in counts]
    return population_stability_index_from_reference(proportions, observed_values, edges)


def _histogram_counts(values: Iterable[float], edges: list[float]) -> list[int]:
    counts = [0] * (len(edges) + 1)
    for value in values:
        counts[bisect_left(edges, value)] += 1
    return counts


def population_stability_index_from_reference(reference_proportions: Iterable[float],
                                               observed: Iterable[float],
                                               edges: list[float]) -> float:
    """Compare observations to immutable histogram proportions and fixed edges."""
    reference = _bounded_values(reference_proportions, MAX_HISTOGRAM_EDGES + 1)
    observed_values = _bounded_values(observed, MAX_PSI_WINDOW)
    edges = _bounded_values(edges, MAX_HISTOGRAM_EDGES)
    if (not observed_values or len(edges) < 2 or len(reference) != len(edges) + 1):
        raise DeploymentGateError("PSI needs observations and a complete reference histogram")
    if any(not math.isfinite(value) for value in reference + observed_values + edges):
        raise DeploymentGateError("PSI inputs must be finite")
    if sorted(edges) != edges or len(set(edges)) != len(edges):
        raise DeploymentGateError("PSI edges must be strictly increasing")
    if any(value < 0 for value in reference) or not math.isclose(sum(reference), 1.0, abs_tol=1e-6):
        raise DeploymentGateError("PSI reference proportions must be nonnegative and sum to one")
    counts = _histogram_counts(observed_values, edges)
    bins = len(counts)
    smoothing = 1e-6
    denominator = len(observed_values) + smoothing * bins
    expected = [(value + smoothing) / (sum(reference) + smoothing * bins) for value in reference]
    actual = [(count + smoothing) / denominator for count in counts]
    return sum((a - e) * math.log(a / e) for e, a in zip(expected, actual))


class RollingPSIMonitor:
    """Thread-safe bounded PSI window represented only by fixed histogram bins.

    The ring contains bin ordinals, never raw sensor values. Its checkpoint can
    therefore resume the exact existing sliding-window PSI calculation.
    """

    def __init__(self, *, edges: list[float], reference_proportions: list[float],
                 minimum_samples: int, window_size: int, update_every: int):
        if (any(type(value) is not int for value in (minimum_samples, window_size, update_every))
                or minimum_samples < 1 or window_size < minimum_samples or window_size > MAX_PSI_WINDOW
                or update_every < 1 or update_every > window_size):
            raise DeploymentGateError("invalid bounded PSI window configuration")
        # Validate the histogram before accepting it as model metadata.
        population_stability_index_from_reference(reference_proportions, [0.0], edges)
        self.edges = tuple(edges)
        self.reference_proportions = tuple(reference_proportions)
        self.minimum_samples = minimum_samples
        self.window_size = window_size
        self.update_every = update_every
        self._bins: deque[int] = deque(maxlen=window_size)
        self._bin_counts = [0] * (len(self.edges) + 1)
        self._lock = Lock()
        self._seen_count = 0
        self._last_update_count = 0
        self._current_psi: float | None = None

    def observe(self, value: float) -> float | None:
        if not _finite_number(value):
            raise DeploymentGateError("PSI observation must be finite")
        with self._lock:
            bin_index = bisect_left(self.edges, value)
            if len(self._bins) == self.window_size:
                self._bin_counts[self._bins[0]] -= 1
            self._bins.append(bin_index)
            self._bin_counts[bin_index] += 1
            self._seen_count += 1
            if (len(self._bins) < self.minimum_samples
                    or self._seen_count - self._last_update_count < self.update_every):
                return None
            self._current_psi = _population_stability_index_from_counts(
                self.reference_proportions, self._bin_counts,
            )
            self._last_update_count = self._seen_count
            return self._current_psi

    @property
    def current_psi(self) -> float | None:
        with self._lock:
            return self._current_psi

    @property
    def sample_count(self) -> int:
        """Number of observations represented by the current bounded window."""
        with self._lock:
            return len(self._bins)

    def export_state(self) -> dict[str, object]:
        """Return a bounded checkpoint containing bin ordinals, never values."""
        with self._lock:
            return {
                "version": 1,
                "window_size": self.window_size,
                "bins": tuple(self._bins),
                "counts": tuple(self._bin_counts),
                "seen_count": self._seen_count,
                "last_update_count": self._last_update_count,
                "current_psi": self._current_psi,
            }

    def restore_state(self, state: object) -> None:
        """Restore only a structurally valid checkpoint for this exact window."""
        if not isinstance(state, dict) or set(state) != {
            "version", "window_size", "bins", "counts", "seen_count",
            "last_update_count", "current_psi",
        }:
            raise DeploymentGateError("malformed persisted PSI window state")
        bins, counts = state["bins"], state["counts"]
        seen, last = state["seen_count"], state["last_update_count"]
        psi = state["current_psi"]
        bin_count = len(self.edges) + 1
        if (state["version"] != 1 or state["window_size"] != self.window_size
                or not isinstance(bins, (list, tuple)) or len(bins) > self.window_size
                or any(type(index) is not int or not 0 <= index < bin_count for index in bins)
                or not isinstance(counts, (list, tuple)) or len(counts) != bin_count
                or any(type(value) is not int or value < 0 for value in counts)
                or list(counts) != [bins.count(index) for index in range(bin_count)]
                or type(seen) is not int or seen < len(bins)
                or type(last) is not int or not 0 <= last <= seen
                or (psi is not None and (not _finite_number(psi) or psi < 0))
                or (psi is not None and (len(bins) < self.minimum_samples or last == 0))):
            raise DeploymentGateError("invalid persisted PSI window state")
        with self._lock:
            self._bins = deque(bins, maxlen=self.window_size)
            self._bin_counts = list(counts)
            self._seen_count = seen
            self._last_update_count = last
            self._current_psi = None if psi is None else float(psi)


def _population_stability_index_from_counts(reference: Iterable[float], counts: list[int]) -> float:
    reference_values = list(reference)
    if len(reference_values) != len(counts) or not counts or sum(counts) < 1:
        raise DeploymentGateError("PSI needs observations and a complete reference histogram")
    bins = len(counts)
    smoothing = 1e-6
    denominator = sum(counts) + smoothing * bins
    expected = [(value + smoothing) / (sum(reference_values) + smoothing * bins)
                for value in reference_values]
    actual = [(count + smoothing) / denominator for count in counts]
    return sum((a - e) * math.log(a / e) for e, a in zip(expected, actual))


@dataclass(frozen=True)
class GuardrailSnapshot:
    missing_prediction_rate: float
    tier_a_p99_ms: float
    consumer_lag_seconds: float
    watermark_stalled_seconds: float
    prediction_psi: float
    false_dismissals: int = 0
    advisory_count: int = 0
    confirmed_real_fault_annotations: int = 0


def rollback_reasons(snapshot: GuardrailSnapshot) -> tuple[str, ...]:
    metric_names = (
        "missing_prediction_rate", "tier_a_p99_ms", "consumer_lag_seconds",
        "watermark_stalled_seconds", "prediction_psi",
    )
    values = {name: getattr(snapshot, name) for name in metric_names}
    invalid = tuple(f"{name}_non_finite" for name, value in values.items()
                    if not _finite_number(value))
    if invalid:
        return invalid
    invalid = tuple(f"{name}_out_of_range" for name, value in values.items()
                    if value < 0 or (name == "missing_prediction_rate" and value > 1))
    counts = (snapshot.false_dismissals, snapshot.advisory_count, snapshot.confirmed_real_fault_annotations)
    if any(type(value) is not int or not 0 <= value <= 1_000_000_000 for value in counts):
        invalid += ("invalid_annotation_counts",)
    elif snapshot.false_dismissals > snapshot.advisory_count:
        invalid += ("invalid_annotation_counts",)
    if invalid:
        return invalid
    checks = (
        (snapshot.missing_prediction_rate > 0.01, "missing_prediction_rate"),
        (snapshot.tier_a_p99_ms > 50.0, "tier_a_p99_latency"),
        (snapshot.consumer_lag_seconds > 300.0, "consumer_lag"),
        (snapshot.watermark_stalled_seconds > 300.0, "watermark_stalled"),
        (snapshot.prediction_psi > 0.25, "prediction_psi"),
        (snapshot.confirmed_real_fault_annotations > 0, "real_fault_misannotation"),
        (snapshot.advisory_count >= 200 and snapshot.false_dismissals / max(snapshot.advisory_count, 1) > 0.40,
         "false_dismissal_rate"),
    )
    return invalid + tuple(reason for breached, reason in checks if breached)


@dataclass(frozen=True)
class PromotionEvidence:
    real_ground_truth: bool
    pooled_consent_count: int
    independent_sites: int
    independent_weather_years: int
    test_examples: int
    export_parity_max_abs_error: float | None
    model_card_present: bool
    human_approval_id: str | None
    minimum_quality_gate_passed: bool


def require_promotion_evidence(evidence: PromotionEvidence) -> None:
    if evidence.real_ground_truth is not True:
        raise DeploymentGateError("synthetic hotspot labels cannot promote a production model")
    if any(type(value) is not int or not 0 <= value <= 1_000_000_000 for value in (
            evidence.pooled_consent_count, evidence.independent_sites,
            evidence.independent_weather_years, evidence.test_examples)):
        raise DeploymentGateError("promotion counts must be bounded exact integers")
    if evidence.pooled_consent_count < 50:
        raise DeploymentGateError("pooled model promotion needs at least 50 consented tenants")
    if evidence.independent_sites < 5 or evidence.independent_weather_years < 3:
        raise DeploymentGateError("promotion needs independent site and weather-year holdouts")
    if evidence.test_examples < 2_000:
        raise DeploymentGateError("promotion needs the design's minimum untouched holdout sample")
    parity_error = evidence.export_parity_max_abs_error
    if (not _finite_number(parity_error)
            or parity_error < 0 or parity_error > 1e-4):
        raise DeploymentGateError("model export parity has not passed")
    if (evidence.model_card_present is not True or not isinstance(evidence.human_approval_id, str)
            or not evidence.human_approval_id.strip() or len(evidence.human_approval_id) > 128):
        raise DeploymentGateError("model card and recorded human manifest approval are required")
    if evidence.minimum_quality_gate_passed is not True:
        raise DeploymentGateError("model quality gates have not passed")


@dataclass(frozen=True)
class RehearsalObservation:
    """Caller-provided synthetic aggregate; never authenticated production evidence."""

    observation_id: str
    model_version: str
    artifact_sha256: str
    captured_at: float
    sample_count: int
    guardrails: GuardrailSnapshot


_LOCAL_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _local_id(value: str) -> None:
    if not isinstance(value, str) or not _LOCAL_ID.fullmatch(value):
        raise DeploymentGateError("invalid bounded local identifier")


def _canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


class LocalReleaseController:
    """Durable local synthetic rehearsals, with no deployment or serving authority.

    The file contains only model identities and aggregate evidence. A file lock
    serializes writers; expected_revision prevents stale-controller updates.
    Atomic replacement/fsync preserves the previous state on pre-replace failure.
    This controller is not wired to the scorer, GitOps, flags, or cloud APIs.
    Every serving mode remains shadow, including a champion rehearsal.
    """

    def __init__(self, path: Path | str, registry: object, *, enabled: bool = False,
                 environment: str = "disabled"):
        if enabled is not True or environment != "local-synthetic":
            raise DeploymentGateError("release rehearsals require explicit local-synthetic enablement")
        self.path = Path(path).absolute()
        self.registry = registry
        if not self.path.parent.is_dir() or self.path.is_symlink():
            raise DeploymentGateError("local rehearsal state needs an existing directory and regular file")

    @staticmethod
    def serving_mode() -> str:
        return "shadow"

    def _verify_model(self, version: str) -> dict[str, str]:
        _local_id(version)
        # Reuse actual checksum, immutable-version, golden-vector and synthetic
        # gates; a caller-supplied production_eligible boolean is insufficient.
        manifest = self.registry.load("greenguard.hotspot-transition.classifier", version).manifest
        if manifest.synthetic_only is not True or manifest.production_eligible is not False:
            raise DeploymentGateError("release rehearsal accepts only production-ineligible synthetic models")
        return {"model_version": manifest.model_version, "artifact_sha256": manifest.artifact_sha256,
                "feature_set_version": manifest.feature_set_version,
                "training_split_fingerprint": manifest.drift_reference["training_split_fingerprint"]}

    @contextmanager
    def _locked(self):
        lock_path = self.path.with_name(self.path.name + ".lock")
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise DeploymentGateError("local release state is busy; retry with a fresh revision") from exc
            yield
        finally:
            os.close(fd)

    def _read(self) -> dict:
        if not self.path.exists():
            return {"revision": 0}
        if self.path.is_symlink() or not self.path.is_file() or self.path.stat().st_size > 131_072:
            raise DeploymentGateError("local rehearsal state exceeds bounds or is not a regular file")
        try:
            state = json.loads(self.path.read_bytes())
            expected_keys = {"schema", "synthetic_only", "production_eligible", "serving_mode", "revision",
                             "stage", "baseline", "candidate", "percentage", "started_at", "observations",
                             "latest", "retraining", "audit"}
            if (not isinstance(state, dict) or set(state) != expected_keys
                    or state["schema"] != "greenguard-local-release-v1"
                    or state["synthetic_only"] is not True or state["production_eligible"] is not False
                    or state["serving_mode"] != "shadow" or type(state["revision"]) is not int
                    or not 1 <= state["revision"] <= 1_000_000_000
                    or state["stage"] not in {"shadow", "canary_rehearsal", "champion_rehearsal", "rolled_back"}
                    or not isinstance(state["observations"], list) or len(state["observations"]) > 128
                    or not isinstance(state["audit"], list) or len(state["audit"]) > 128):
                raise DeploymentGateError("invalid local rehearsal state")
            active = state["stage"] in {"canary_rehearsal", "champion_rehearsal"}
            percentage = state["percentage"]
            if (state["baseline"] is None or active and state["candidate"] is None
                    or not _finite_number(percentage)
                    or state["stage"] in {"shadow", "rolled_back"} and percentage != 0
                    or state["stage"] == "canary_rehearsal" and not 0 < percentage <= 10
                    or state["stage"] == "champion_rehearsal" and percentage != 100):
                raise DeploymentGateError("invalid rehearsal transition state")
            if active:
                self._time(state["started_at"])
            if state["latest"] is not None:
                latest = state["latest"]
                self._time(latest["captured_at"])
                if (type(latest["healthy"]) is not bool or type(latest["sample_count"]) is not int
                        or not 1 <= latest["sample_count"] <= 1_000_000):
                    raise DeploymentGateError("invalid persisted observation")
            ids = set()
            for previous in state["observations"]:
                _local_id(previous["id"])
                if (set(previous) != {"id", "sha256"} or previous["id"] in ids
                        or not isinstance(previous["sha256"], str) or not _SHA256.fullmatch(previous["sha256"])):
                    raise DeploymentGateError("invalid persisted observation inventory")
                ids.add(previous["id"])
            handoff = state["retraining"]
            if handoff is not None:
                if handoff["source"] != state["baseline"] or handoff["status"] not in {"requested", "verified_offline"}:
                    raise DeploymentGateError("invalid persisted retraining source/status")
                body = {key: value for key, value in handoff.items()
                        if key not in {"request_id", "status", "candidate_id"}}
                if hashlib.sha256(_canonical(body)).hexdigest() != handoff["request_id"]:
                    raise DeploymentGateError("persisted retraining handoff digest mismatch")
                if handoff["status"] == "verified_offline" and not _SHA256.fullmatch(handoff["candidate_id"]):
                    raise DeploymentGateError("invalid persisted retraining receipt")
            for identity in (state["baseline"], state["candidate"]):
                if identity is not None and self._verify_model(identity["model_version"]) != identity:
                    raise DeploymentGateError("registered artifact identity changed")
            return state
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise DeploymentGateError("local rehearsal state failed validation") from exc

    def snapshot(self) -> dict:
        with self._locked():
            return self._read()

    def rehearsal_selection(self, tenant_id: str, *, salt: str) -> dict:
        """Return a hypothetical cohort choice, always labelled shadow."""
        bucket = tenant_bucket(tenant_id, salt)
        state = self.snapshot()
        if state.get("revision") == 0:
            raise DeploymentGateError("cohort rehearsal requires an initialized baseline")
        selected = (state["stage"] in {"canary_rehearsal", "champion_rehearsal"}
                    and bucket < state["percentage"])
        return {"serving_mode": "shadow", "hypothetical_model":
                state["candidate"] if selected else state["baseline"]}

    def _update(self, expected_revision: int, operation) -> dict:
        if type(expected_revision) is not int or not 0 <= expected_revision < 1_000_000_000:
            raise DeploymentGateError("invalid expected revision")
        with self._locked():
            state = self._read()
            if state["revision"] != expected_revision:
                raise DeploymentGateError("stale local release revision")
            if not operation(state):
                return state
            state["revision"] += 1
            encoded = _canonical(state)
            if len(encoded) > 131_072:
                raise DeploymentGateError("local rehearsal state exceeds bounds")
            fd, staging = tempfile.mkstemp(prefix=".local-release-", dir=self.path.parent)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(staging, self.path)
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            finally:
                if os.path.exists(staging):
                    os.unlink(staging)
            return state

    @staticmethod
    def _audit(state: dict, action: str, reasons: tuple[str, ...] = (),
               approval_id: str | None = None) -> None:
        entry = {"revision": state["revision"] + 1, "action": action, "reasons": list(reasons)}
        if approval_id is not None:
            entry["approval_sha256"] = hashlib.sha256(approval_id.encode()).hexdigest()
        state["audit"] = (state["audit"] + [entry])[-128:]

    def initialize(self, baseline_version: str) -> dict:
        baseline = self._verify_model(baseline_version)

        def apply(state):
            state.update(schema="greenguard-local-release-v1", synthetic_only=True,
                         production_eligible=False, serving_mode="shadow", stage="shadow",
                         baseline=baseline, candidate=None, percentage=0.0, started_at=None,
                         observations=[], latest=None, retraining=None, audit=[])
            self._audit(state, "initialize_shadow")
            return True

        return self._update(0, apply)

    def stage_candidate(self, version: str, *, expected_revision: int) -> dict:
        candidate = self._verify_model(version)

        def apply(state):
            if state.get("stage") not in {"shadow", "rolled_back"}:
                raise DeploymentGateError("candidate staging requires inactive rehearsal")
            if candidate == state["baseline"]:
                raise DeploymentGateError("candidate must differ from the verified baseline")
            state.update(candidate=candidate, stage="shadow", latest=None, observations=[],
                         percentage=0.0, started_at=None)
            self._audit(state, "stage_synthetic_candidate")
            return True

        return self._update(expected_revision, apply)

    @staticmethod
    def _time(value: float) -> None:
        if not _finite_number(value) or not 0 <= value <= 1e12:
            raise DeploymentGateError("invalid bounded observation time")

    def start_canary(self, *, percentage: float, now: float, approval_id: str,
                     expected_revision: int) -> dict:
        self._time(now)
        _local_id(approval_id)
        if not _finite_number(percentage) or not 0 < percentage <= 10:
            raise DeploymentGateError("local canary rehearsal percentage must be above zero and at most ten")

        def apply(state):
            if state.get("stage") != "shadow" or state["candidate"] is None:
                raise DeploymentGateError("canary rehearsal needs a staged verified candidate")
            state.update(stage="canary_rehearsal", percentage=percentage, started_at=now,
                         latest=None, observations=[])
            self._audit(state, "start_canary_rehearsal", approval_id=approval_id)
            return True

        return self._update(expected_revision, apply)

    def observe(self, observation: RehearsalObservation, *, now: float,
                expected_revision: int) -> dict:
        self._time(now)
        self._time(observation.captured_at)
        _local_id(observation.observation_id)
        if (type(observation.sample_count) is not int or not 1 <= observation.sample_count <= 1_000_000
                or type(observation.guardrails) is not GuardrailSnapshot):
            raise DeploymentGateError("observation needs bounded samples and a guardrail snapshot")
        # Nonfinite float metrics must invalidate prior healthy evidence through
        # the persisted rollback decision, rather than failing before the update.
        if any(type(value) not in (int, float)
               or (abs(value) > 1e12 and (type(value) is int or math.isfinite(value)))
               for value in asdict(observation.guardrails).values()):
            raise DeploymentGateError("guardrail metrics must be bounded numeric aggregates")
        data = asdict(observation)
        # Invalid/nonfinite metrics cause rollback but cannot enter JSON as NaN.
        data["guardrails"] = {name: str(value) if type(value) in (float, int)
                              and not math.isfinite(value) else value
                              for name, value in data["guardrails"].items()}
        try:
            digest = hashlib.sha256(_canonical(data)).hexdigest()
        except (TypeError, ValueError) as exc:
            raise DeploymentGateError("invalid guardrail observation") from exc

        def apply(state):
            for previous in state.get("observations", []):
                if previous["id"] == observation.observation_id:
                    if previous["sha256"] != digest:
                        raise DeploymentGateError("observation replay changed its content")
                    return False
            if state.get("stage") not in {"canary_rehearsal", "champion_rehearsal"}:
                raise DeploymentGateError("observations require an active rehearsal")
            candidate = state["candidate"]
            if (observation.model_version != candidate["model_version"]
                    or observation.artifact_sha256 != candidate["artifact_sha256"]):
                raise DeploymentGateError("guardrails do not bind the rehearsed model artifact")
            if (observation.captured_at < state["started_at"] or
                    state["latest"] is not None and observation.captured_at <= state["latest"]["captured_at"]):
                raise DeploymentGateError("out-of-order observation")
            reasons = rollback_reasons(observation.guardrails)
            if not 0 <= now - observation.captured_at <= 300:
                reasons += ("stale_or_future_observation",)
            state["latest"] = {"captured_at": observation.captured_at,
                               "sample_count": observation.sample_count, "healthy": not reasons}
            state["observations"] = (state["observations"] + [
                {"id": observation.observation_id, "sha256": digest}])[-128:]
            if reasons:
                # The actual action is only this atomic local state transition.
                state.update(stage="rolled_back", percentage=0.0)
                self._audit(state, "rollback_rehearsal_to_baseline", reasons)
            else:
                self._audit(state, "healthy_rehearsal_observation")
            return True

        return self._update(expected_revision, apply)

    def promote_rehearsal(self, *, now: float, approval_id: str, expected_revision: int) -> dict:
        self._time(now)
        _local_id(approval_id)

        def apply(state):
            latest = state.get("latest")
            if (state.get("stage") != "canary_rehearsal" or latest is None or not latest["healthy"]
                    or latest["sample_count"] < 200 or now - state["started_at"] < 300
                    or not 0 <= now - latest["captured_at"] <= 300
                    or latest["captured_at"] - state["started_at"] < 300):
                raise DeploymentGateError("champion rehearsal needs fresh healthy evidence after the canary dwell")
            state.update(stage="champion_rehearsal", percentage=100.0)
            self._audit(state, "promote_champion_rehearsal", approval_id=approval_id)
            return True

        return self._update(expected_revision, apply)

    def rollback(self, *, approval_id: str, expected_revision: int) -> dict:
        _local_id(approval_id)

        def apply(state):
            if state.get("stage") == "rolled_back":
                return False
            if state.get("stage") not in {"canary_rehearsal", "champion_rehearsal"}:
                raise DeploymentGateError("rollback requires an active rehearsal")
            state.update(stage="rolled_back", percentage=0.0)
            self._audit(state, "rollback_rehearsal_to_baseline", ("manual_local_rollback",), approval_id)
            return True

        return self._update(expected_revision, apply)

    def request_retraining(self, *, feature: str, psi: float, sample_count: int,
                           now: float, expected_revision: int) -> dict:
        """Persist a digest-only handoff; no training job or promotion is launched."""
        self._time(now)
        if (feature not in {"temperature_c", "relative_humidity_percent"}
                or not _finite_number(psi) or not 0.25 < psi <= 100
                or type(sample_count) is not int or not 200 <= sample_count <= MAX_PSI_WINDOW):
            raise DeploymentGateError("retraining handoff needs a bounded, sampled feature drift breach")

        def apply(state):
            if state.get("revision") == 0:
                raise DeploymentGateError("retraining handoff requires an initialized baseline")
            body = {"source": state["baseline"], "feature": feature, "psi": psi,
                    "sample_count": sample_count, "captured_at": now,
                    "synthetic_only": True, "production_eligible": False,
                    "recipe": "ml.classical.retrain_synthetic_candidate.run"}
            request_id = hashlib.sha256(_canonical(body)).hexdigest()
            if state["retraining"] is not None and state["retraining"]["request_id"] == request_id:
                return False
            if state["retraining"] is not None and now <= state["retraining"]["captured_at"]:
                raise DeploymentGateError("out-of-order retraining handoff")
            state["retraining"] = {**body, "request_id": request_id, "status": "requested"}
            self._audit(state, "request_offline_synthetic_retraining")
            return True

        return self._update(expected_revision, apply)

    def record_retraining_result(self, package: Path | str, *, request_id: str,
                                 expected_revision: int) -> dict:
        """Verify an offline candidate receipt without registering or selecting it."""
        if not isinstance(request_id, str) or not _SHA256.fullmatch(request_id):
            raise DeploymentGateError("invalid retraining request digest")
        package = Path(package)
        manifest_path = package / "manifest.json"
        if (not package.is_dir() or package.is_symlink() or manifest_path.is_symlink()
                or not manifest_path.is_file() or manifest_path.stat().st_size > 65_536):
            raise DeploymentGateError("invalid bounded offline candidate package")
        try:
            manifest = json.loads(manifest_path.read_bytes())
            if (manifest["schema_version"] != "greenguard-offline-candidate-package-v1"
                    or manifest["data_origin"] != "synthetic_grain_sim"
                    or any(manifest[key] is not False for key in ("production_eligible", "promotion_eligible"))
                    or manifest["synthetic_only"] is not True or manifest["selected_model"] is not None
                    or manifest["champion"] is not None):
                raise DeploymentGateError("offline candidates cannot be eligible or selected")
            candidate_id = manifest.pop("candidate_id")
            if candidate_id != hashlib.sha256(_canonical(manifest)).hexdigest() or package.name != candidate_id:
                raise DeploymentGateError("offline candidate identity does not bind its manifest")
            files = manifest["files"]
            if (not isinstance(files, dict) or not 1 <= len(files) <= 16 or "evaluation.json" not in files
                    or {item.name for item in package.iterdir()} != set(files) | {"manifest.json"}):
                raise DeploymentGateError("offline candidate file inventory is invalid")
            total_bytes = 0
            for name, metadata in files.items():
                _local_id(name)
                path = package / name
                expected_bytes = metadata["bytes"]
                if (type(expected_bytes) is not int or not 1 <= expected_bytes <= 16_777_216
                        or path.is_symlink() or not path.is_file() or path.stat().st_size != expected_bytes):
                    raise DeploymentGateError("offline candidate artifact size/path is invalid")
                total_bytes += expected_bytes
                if total_bytes > 67_108_864:
                    raise DeploymentGateError("offline candidate exceeds total byte bound")
                if hashlib.sha256(path.read_bytes()).hexdigest() != metadata["sha256"]:
                    raise DeploymentGateError("offline candidate artifact checksum mismatch")
            evaluation_path = package / "evaluation.json"
            if evaluation_path.stat().st_size > 1_048_576:
                raise DeploymentGateError("offline candidate evaluation exceeds bounds")
            report = json.loads(evaluation_path.read_bytes())
            if (report["schema_version"] != "greenguard-offline-candidate-evaluation-v1"
                    or report["synthetic_only"] is not True or report["production_eligible"] is not False
                    or report["promotion_eligible"] is not False):
                raise DeploymentGateError("offline candidate evaluation must remain synthetic")
        except (OSError, TypeError, ValueError, KeyError) as exc:
            raise DeploymentGateError("offline candidate package failed verification") from exc

        def apply(state):
            handoff = state.get("retraining")
            if handoff is None or handoff["request_id"] != request_id:
                raise DeploymentGateError("offline candidate receipt needs the current retraining request")
            if handoff["status"] == "verified_offline":
                if handoff["candidate_id"] != candidate_id:
                    raise DeploymentGateError("retraining receipt replay changed its candidate")
                return False
            handoff.update(status="verified_offline", candidate_id=candidate_id)
            self._audit(state, "verify_offline_retraining_receipt")
            return True

        return self._update(expected_revision, apply)

    def require_production_promotion(self, evidence: PromotionEvidence) -> None:
        require_promotion_evidence(evidence)
        raise DeploymentGateError("production promotion is unavailable in the local synthetic controller")
