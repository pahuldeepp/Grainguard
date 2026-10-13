"""Torch-free split, metric and immutable synthetic comparison contract."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

import numpy as np

class SequenceDataError(ValueError):
    """Raised when a corpus violates the narrow I3 input contract."""


@dataclass(frozen=True)
class TemporalSplit:
    """Chronological evaluation boundaries with input+label horizon purging."""

    train_end: datetime
    validation_start: datetime
    validation_end: datetime
    test_start: datetime
    test_end: datetime
    context: timedelta = timedelta(hours=24)
    label_horizon: timedelta = timedelta(hours=48)
    train_seeds: tuple[int, ...] = ()
    validation_seeds: tuple[int, ...] = ()
    test_seeds: tuple[int, ...] = ()

    def __post_init__(self) -> None:
        bounds = (self.train_end, self.validation_start, self.validation_end,
                  self.test_start, self.test_end)
        if any(value.tzinfo is None or value.utcoffset() != timedelta(0) for value in bounds):
            raise SequenceDataError("temporal split boundaries must be timezone-aware UTC values")
        if self.context <= timedelta(0) or self.label_horizon <= timedelta(0):
            raise SequenceDataError("context and label horizon must both be positive")
        seed_groups = (set(self.train_seeds), set(self.validation_seeds), set(self.test_seeds))
        if any(seed_groups) and any(not group for group in seed_groups):
            raise SequenceDataError("temporal seed filtering requires nonempty seeds for all splits")
        if sum(map(len, seed_groups)) != len(set().union(*seed_groups)):
            raise SequenceDataError("a simulator seed appears in multiple temporal splits")
        if any(isinstance(seed, bool) or not isinstance(seed, int) or seed < 0
               for group in seed_groups for seed in group):
            raise SequenceDataError("temporal split seed IDs must be non-negative integers")
        if self.context != timedelta(hours=24) or self.label_horizon != timedelta(hours=48):
            raise SequenceDataError("comparison requires the actual 24h input context and 48h target horizon")
        purge = self.context + self.label_horizon
        if self.validation_start - self.train_end < purge:
            raise SequenceDataError("train/validation gap must purge the full input context and target horizon")
        if self.test_start - self.validation_end < purge:
            raise SequenceDataError("validation/test gap must purge the full input context and target horizon")
        if not self.validation_start < self.validation_end < self.test_start < self.test_end:
            raise SequenceDataError("temporal split boundaries are not ordered")

    def as_dict(self) -> dict[str, str | float]:
        return {
            "train_start": "first eligible corpus timestamp", "train_end_exclusive": self.train_end.isoformat(),
            "validation_start_inclusive": self.validation_start.isoformat(),
            "validation_end_exclusive": self.validation_end.isoformat(),
            "test_start_inclusive": self.test_start.isoformat(), "test_end_exclusive": self.test_end.isoformat(),
            "context_hours": self.context.total_seconds() / 3600,
            "label_horizon_hours": self.label_horizon.total_seconds() / 3600,
            "purge_gap_hours": (self.context + self.label_horizon).total_seconds() / 3600,
            "train_seeds": list(self.train_seeds),
            "validation_seeds": list(self.validation_seeds),
            "test_seeds": list(self.test_seeds),
        }


def split_by_time(as_ofs: Iterable[datetime], seeds: Iterable[int],
                  split: TemporalSplit) -> dict[str, np.ndarray]:
    """Select chronological, optionally run-disjoint cohorts with actual purge checks."""
    timestamps = tuple(as_ofs)
    seed_values = tuple(seeds)
    if len(seed_values) != len(timestamps):
        raise SequenceDataError("each sample timestamp must have one seed ID")
    if any(value.tzinfo is None or value.utcoffset() != timedelta(0) for value in timestamps):
        raise SequenceDataError("all sample timestamps must be UTC")
    seed_filter = {
        "train": set(split.train_seeds), "validation": set(split.validation_seeds),
        "test": set(split.test_seeds),
    }
    indices = {
        "train": np.asarray([i for i, value in enumerate(timestamps)
                             if value < split.train_end
                             and (not seed_filter["train"] or seed_values[i] in seed_filter["train"])], dtype=np.int64),
        "validation": np.asarray([i for i, value in enumerate(timestamps)
                                   if split.validation_start <= value < split.validation_end
                                   and (not seed_filter["validation"] or seed_values[i] in seed_filter["validation"])], dtype=np.int64),
        "test": np.asarray([i for i, value in enumerate(timestamps)
                            if split.test_start <= value < split.test_end
                            and (not seed_filter["test"] or seed_values[i] in seed_filter["test"])], dtype=np.int64),
    }
    if any(not len(values) for values in indices.values()):
        raise SequenceDataError("each chronological split must contain examples")
    train_last = max(timestamps[index] for index in indices["train"])
    validation_first = min(timestamps[index] for index in indices["validation"])
    validation_last = max(timestamps[index] for index in indices["validation"])
    test_first = min(timestamps[index] for index in indices["test"])
    purge = split.context + split.label_horizon
    if validation_first - train_last < purge or test_first - validation_last < purge:
        raise SequenceDataError("selected samples overlap the preceding input/label interval")
    return indices


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def binary_metrics(labels: Any, probabilities: Any) -> dict[str, Any]:
    """One float64 Brier implementation for every model; no tuned threshold."""
    y = np.asarray(labels, dtype=np.float64)
    p = np.asarray(probabilities, dtype=np.float64)
    if y.ndim != 1 or not y.size or y.shape != p.shape:
        raise SequenceDataError("metrics need equally sized non-empty vectors")
    if not np.all(np.isin(y, (0, 1))) or not np.all(np.isfinite(p)) or np.any((p < 0) | (p > 1)):
        raise SequenceDataError("metrics need binary labels and finite probabilities in [0, 1]")
    return {"n": int(y.size), "positive_rate": float(y.mean()),
            "class_degenerate": bool(np.unique(y).size < 2),
            "brier": float(np.mean(np.square(y - p)))}


def naive_prevalence_metrics(train_labels: Any, test_labels: Any) -> dict[str, Any]:
    """Score a constant probability learned only from training prevalence."""
    train = np.asarray(train_labels, dtype=np.float64)
    test = np.asarray(test_labels, dtype=np.float64)
    if train.ndim != 1 or not train.size or not np.all(np.isin(train, (0, 1))):
        raise SequenceDataError("prevalence baseline needs non-empty binary training labels")
    probability = float(train.mean())
    metrics = binary_metrics(test, np.full(test.shape, probability, dtype=np.float64))
    return {"fit_split": "train", "probability": probability, "test": metrics}


def frozen_comparison(corpora: Iterable[Path], definition: dict, rows: dict) -> dict:
    """Bind cohort IDs, timestamps, targets, and verified corpus bytes before training."""
    manifests = {}
    for directory in corpora:
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        for name, details in manifest["files"].items():
            path = (directory / name).resolve()
            if not path.is_relative_to(directory.resolve()) or not path.is_file():
                raise SequenceDataError("invalid frozen corpus file")
            if hashlib.sha256(path.read_bytes()).hexdigest() != details["sha256"]:
                raise SequenceDataError(f"frozen corpus checksum mismatch: {name}")
        run = str(manifest["run_pk"])
        if run in manifests:
            raise SequenceDataError("duplicate run in frozen corpus")
        manifests[run] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    selected = {}
    for name in ("train", "validation", "test"):
        selected[name] = [[run, at.isoformat(), int(label)] for run, at, label in sorted(rows[name])]
        keys = [(row[0], row[1]) for row in selected[name]]
        if len(keys) != len(set(keys)):
            raise SequenceDataError("duplicate frozen example")
    return {"schema_version": "synthetic-i4-frozen-comparison-v1", "synthetic_only": True,
            "production_eligible": False, "split_definition": definition,
            "corpus_manifest_sha256": dict(sorted(manifests.items())), "selected_rows": selected,
            "split_fingerprints": {name: _digest([row[:2] for row in entries]) for name, entries in selected.items()},
            "label_fingerprints": {name: _digest(entries) for name, entries in selected.items()}}


def verify_frozen_comparison(actual: dict, expected: dict) -> None:
    if actual != expected:
        raise SequenceDataError("frozen comparison differs in corpus bytes, split rows, labels, or boundaries")
