"""Synthetic-only, direct multi-horizon sensor forecasting research experiment.

This module is intentionally separate from the 48-hour hotspot-onset classifier.
It forecasts future bin-mean temperature and relative humidity from the existing
24-hour / 16-sensor sequence export. Nothing here is production eligible.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from ml.deep_learning.sequence_models import SequenceDataError, load_corpora

HORIZONS_HOURS = (6, 24, 72)
TARGETS = ("temperature_c", "relative_humidity_percent")
QUANTILES = (0.1, 0.5, 0.9)
CONTEXT_HOURS = 24
PURGE_HOURS = CONTEXT_HOURS + max(HORIZONS_HOURS)
EXPECTED_SENSORS = 16
FEATURES_PER_SENSOR = 3
CONTEXT_STEPS = 96
START = datetime(2025, 1, 1, tzinfo=timezone.utc)


class ForecastDataError(ValueError):
    """Raised for malformed or temporally unsafe synthetic forecast data."""


@dataclass(frozen=True)
class ForecastRows:
    x: np.ndarray  # [N, 96, 48], exactly the existing sequence input contract
    y: np.ndarray  # [N, 3 horizons, 2 targets]
    seeds: np.ndarray
    run_ids: tuple[str, ...]
    as_ofs: tuple[datetime, ...]
    observed_counts: np.ndarray  # [N, 3], bins with uncensored target readings
    censored_candidates: dict[str, int]


@dataclass(frozen=True)
class TemporalSeedSplit:
    train_seeds: tuple[int, ...]
    validation_seeds: tuple[int, ...]
    test_seeds: tuple[int, ...]
    train_end: datetime
    validation_start: datetime
    validation_end: datetime
    test_start: datetime
    test_end: datetime


def validate_split(split: TemporalSeedSplit, seeds: Iterable[int]) -> None:
    cohorts = (set(split.train_seeds), set(split.validation_seeds), set(split.test_seeds))
    if any(not group for group in cohorts):
        raise ForecastDataError("train, validation, and test need independent simulator seeds")
    if any(cohorts[i] & cohorts[j] for i in range(3) for j in range(i + 1, 3)):
        raise ForecastDataError("simulator seeds must be disjoint between cohorts")
    if set.union(*cohorts) != set(int(value) for value in seeds):
        raise ForecastDataError("split seeds must exactly cover all supplied runs")
    if split.validation_start - split.train_end < timedelta(hours=PURGE_HOURS):
        raise ForecastDataError("train/validation gap must purge 24h context plus 72h targets")
    if split.test_start - split.validation_end < timedelta(hours=PURGE_HOURS):
        raise ForecastDataError("validation/test gap must purge 24h context plus 72h targets")
    if not split.train_end < split.validation_start <= split.validation_end < split.test_start <= split.test_end:
        raise ForecastDataError("temporal boundaries must be strictly ordered")


def _timestamp(value: Any, field: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ForecastDataError(f"invalid timestamp for {field}") from exc
    else:
        raise ForecastDataError(f"{field} must be a UTC ISO timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ForecastDataError(f"{field} must be UTC")
    return parsed.astimezone(timezone.utc)


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    except (OSError, json.JSONDecodeError) as exc:
        raise ForecastDataError(f"invalid simulator file: {path}") from exc
    if not rows or any(not isinstance(row, dict) for row in rows):
        raise ForecastDataError(f"simulator file is empty or malformed: {path}")
    return rows


def _future_bin_means(simulator_dir: Path) -> dict[datetime, np.ndarray]:
    manifest = json.loads((simulator_dir / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("synthetic_only") is not True or manifest.get("label_not_spoilage") is not True:
        raise ForecastDataError("forecast targets require declared synthetic non-spoilage simulator data")
    if manifest.get("device_count") != EXPECTED_SENSORS:
        raise ForecastDataError("forecast targets require all 16 simulator sensors")
    path = simulator_dir / "readings.jsonl"
    if manifest.get("files", {}).get("readings.jsonl") != _sha(path):
        raise ForecastDataError("simulator reading checksum mismatch")
    grouped: dict[datetime, list[tuple[float, float]]] = {}
    for row in _read_jsonl(path):
        payload = row.get("payload")
        if row.get("event_type") != "telemetry.recorded" or not isinstance(payload, dict):
            raise ForecastDataError("unexpected telemetry envelope in simulator targets")
        observed = _timestamp(payload.get("observed_at"), "observed_at")
        received = _timestamp(payload.get("received_at"), "received_at")
        if received < observed:
            raise ForecastDataError("simulator received_at precedes observed_at")
        measurements = payload.get("measurements")
        if not isinstance(measurements, dict):
            raise ForecastDataError("simulator target measurements are missing")
        try:
            temp = float(measurements["temperature_c"])
            humidity = float(measurements["relative_humidity_percent"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ForecastDataError("forecast target is missing a continuous sensor value") from exc
        if not np.isfinite(temp) or not np.isfinite(humidity):
            raise ForecastDataError("forecast target contains a non-finite sensor value")
        grouped.setdefault(observed, []).append((temp, humidity))
    result: dict[datetime, np.ndarray] = {}
    for observed, values in grouped.items():
        if len(values) != EXPECTED_SENSORS:
            # Marking an incomplete timestamp as absent makes target censoring explicit.
            continue
        result[observed] = np.asarray(values, dtype=np.float64).mean(axis=0)
    return result


def targets_after_as_of(as_of: datetime, future: dict[datetime, np.ndarray]) -> tuple[np.ndarray | None, list[int]]:
    """Return exact future targets, preserving missing horizons as censored."""
    values = []
    counts = []
    for horizon in HORIZONS_HOURS:
        target_at = as_of + timedelta(hours=horizon)
        if target_at <= as_of:
            raise ForecastDataError("future target cutoff is not strictly after as_of")
        target = future.get(target_at)
        values.append(target)
        counts.append(EXPECTED_SENSORS if target is not None else 0)
    if any(value is None for value in values):
        return None, counts
    result = np.stack(values)
    if result.shape != (len(HORIZONS_HOURS), len(TARGETS)) or not np.isfinite(result).all():
        raise ForecastDataError("future target must contain finite temperature/RH bin means")
    return result, counts


def load_forecast_corpora(corpus_and_simulator_dirs: Iterable[tuple[Path, Path]]) -> ForecastRows:
    """Join the existing 96-step corpus to future-only continuous simulator targets.

    Targets are exact 15-minute-grid bin means at as_of + 6/24/72 hours. Rows
    with unavailable future horizons are censored and excluded; no target is
    forward-filled, interpolated, or taken at/before as_of.
    """
    pairs = tuple((Path(corpus), Path(simulator)) for corpus, simulator in corpus_and_simulator_dirs)
    if not pairs:
        raise ForecastDataError("at least one isolated simulator/corpus pair is required")
    sequence_sets = []
    for corpus_dir, simulator_dir in pairs:
        loaded = load_corpora((corpus_dir,))
        future = _future_bin_means(simulator_dir)
        if not loaded.x.shape[1:] == (CONTEXT_STEPS, EXPECTED_SENSORS * FEATURES_PER_SENSOR):
            raise ForecastDataError("sequence input shape must remain [96, 48]")
        run_as_ofs = tuple(_timestamp(value, "sequence.as_of") for value in loaded.as_ofs)
        import pyarrow.parquet as pq
        seq_rows = pq.read_table(corpus_dir / "sequence_windows.parquet").to_pylist()
        seq_by_as_of: dict[Any, list[dict[str, Any]]] = {}
        for row in seq_rows:
            seq_by_as_of.setdefault(row["as_of"], []).append(row)
        for row_index, as_of in enumerate(run_as_ofs):
            # Existing sequence windows are exclusive of as_of; assert timestamps
            # from source parquet, not merely the feature vector shape.
            run_rows = seq_by_as_of.get(loaded.as_ofs[row_index], [])
            expected_run = loaded.run_ids[row_index]
            if len(run_rows) != EXPECTED_SENSORS or any(str(row["run_pk"]) != expected_run for row in run_rows):
                raise ForecastDataError("each forecast sample needs one complete 16-sensor source window")
            if any(any(_timestamp(ts, "sequence.step_timestamp") >= as_of for ts in row["step_timestamps"])
                   for row in run_rows):
                raise ForecastDataError("sequence input contains a timestamp at or after as_of")
            if any(any(row["missing_mask"]) and not all(
                    row["temperature_c"][i] is None and row["relative_humidity_percent"][i] is None
                    for i, missing in enumerate(row["missing_mask"]) if missing)
                    for row in run_rows):
                raise ForecastDataError("masked context values must be explicitly absent")
        targets = []
        valid_indexes = []
        count_rows = []
        censored = {str(horizon): 0 for horizon in HORIZONS_HOURS}
        for index, as_of in enumerate(run_as_ofs):
            target, horizon_counts = targets_after_as_of(as_of, future)
            for horizon, count in zip(HORIZONS_HOURS, horizon_counts, strict=True):
                if count == 0:
                    censored[str(horizon)] += 1
            if target is not None:
                valid_indexes.append(index)
                targets.append(target)
                count_rows.append(horizon_counts)
        if not valid_indexes:
            raise ForecastDataError("no complete uncensored multi-horizon rows remain")
        sequence_sets.append((loaded, run_as_ofs, np.asarray(valid_indexes), np.stack(targets),
                              np.asarray(count_rows), censored))

    return ForecastRows(
        x=np.concatenate([loaded.x[indexes] for loaded, _, indexes, *_ in sequence_sets]),
        y=np.concatenate([target for _, _, _, target, *_ in sequence_sets]),
        seeds=np.concatenate([loaded.seeds[indexes] for loaded, _, indexes, *_ in sequence_sets]),
        run_ids=tuple(run_id for loaded, _, indexes, *_ in sequence_sets for run_id in np.asarray(loaded.run_ids)[indexes]),
        as_ofs=tuple(as_of for _, times, indexes, *_ in sequence_sets for as_of in (times[i] for i in indexes)),
        observed_counts=np.concatenate([counts for *_, counts, _ in sequence_sets]),
        censored_candidates={str(h): sum(item[5][str(h)] for item in sequence_sets) for h in HORIZONS_HOURS},
    )


@dataclass(frozen=True)
class IndexSplit:
    train: np.ndarray
    validation: np.ndarray
    test: np.ndarray


def temporal_seed_split(rows: ForecastRows, split: TemporalSeedSplit) -> IndexSplit:
    validate_split(split, rows.seeds)
    cohorts = (
        ("train", set(split.train_seeds), None, split.train_end),
        ("validation", set(split.validation_seeds), split.validation_start, split.validation_end),
        ("test", set(split.test_seeds), split.test_start, split.test_end),
    )
    indexes: dict[str, np.ndarray] = {}
    for name, seed_set, start, end in cohorts:
        indexes[name] = np.asarray([
            index for index, (seed, at) in enumerate(zip(rows.seeds, rows.as_ofs, strict=True))
            if int(seed) in seed_set and (start is None or at >= start) and at <= end
        ], dtype=np.int64)
        if not len(indexes[name]):
            raise ForecastDataError(f"{name} temporal cohort has no samples")
    train_max = max(rows.as_ofs[i] for i in indexes["train"])
    validation_min = min(rows.as_ofs[i] for i in indexes["validation"])
    validation_max = max(rows.as_ofs[i] for i in indexes["validation"])
    test_min = min(rows.as_ofs[i] for i in indexes["test"])
    if validation_min - train_max < timedelta(hours=PURGE_HOURS):
        raise ForecastDataError("selected train/validation rows violate the 96-hour purge")
    if test_min - validation_max < timedelta(hours=PURGE_HOURS):
        raise ForecastDataError("selected validation/test rows violate the 96-hour purge")
    return IndexSplit(indexes["train"], indexes["validation"], indexes["test"])


@dataclass(frozen=True)
class InputNormalizer:
    mean: np.ndarray
    scale: np.ndarray

    @classmethod
    def fit(cls, train: np.ndarray) -> "InputNormalizer":
        if train.ndim != 3 or not len(train):
            raise ForecastDataError("normalizer requires [N,T,F] training inputs")
        mean = train.mean(axis=(0, 1), dtype=np.float64).astype(np.float32)
        scale = train.std(axis=(0, 1), dtype=np.float64).astype(np.float32)
        scale[scale < 1e-6] = 1.0
        return cls(mean, scale)

    def transform(self, values: np.ndarray) -> np.ndarray:
        if values.shape[-1] != len(self.mean):
            raise ForecastDataError("normalizer feature count mismatch")
        transformed = (values - self.mean[None, None, :]) / self.scale[None, None, :]
        # Missing-value indicators stay binary, not standardized.
        transformed[..., 2::FEATURES_PER_SENSOR] = values[..., 2::FEATURES_PER_SENSOR]
        return transformed.astype(np.float32)


@dataclass(frozen=True)
class TargetNormalizer:
    mean: np.ndarray
    scale: np.ndarray

    @classmethod
    def fit(cls, train: np.ndarray) -> "TargetNormalizer":
        mean = train.mean(axis=0, dtype=np.float64).astype(np.float32)
        scale = train.std(axis=0, dtype=np.float64).astype(np.float32)
        scale[scale < 1e-6] = 1.0
        return cls(mean, scale)

    def transform(self, values: np.ndarray) -> np.ndarray:
        return ((values - self.mean) / self.scale).astype(np.float32)

    def inverse(self, values: np.ndarray) -> np.ndarray:
        if values.ndim != 4 or values.shape[1:3] != self.mean.shape or values.shape[-1] != len(QUANTILES):
            raise ForecastDataError("normalized forecasts must have shape [N,3,2,3]")
        return values * self.scale[None, :, :, None] + self.mean[None, :, :, None]


class LSTMForecaster(nn.Module):
    def __init__(self, hidden: int = 24):
        super().__init__()
        self.encoder = nn.LSTM(48, hidden, batch_first=True)
        self.head = nn.Linear(hidden, 18)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        _, (hidden, _) = self.encoder(x)
        return ordered_quantiles(self.head(hidden[-1]))


class TCNForecaster(nn.Module):
    def __init__(self, channels: int = 24):
        super().__init__()
        self.input = nn.Conv1d(48, channels, 1)
        self.blocks = nn.ModuleList([_CausalResidual(channels, dilation) for dilation in (1, 2, 4)])
        self.head = nn.Linear(channels, 18)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        values = self.input(x.transpose(1, 2))
        for block in self.blocks:
            values = block(values)
        return ordered_quantiles(self.head(values[:, :, -1]))


class _CausalResidual(nn.Module):
    def __init__(self, channels: int, dilation: int):
        super().__init__()
        padding = 2 * dilation
        self.conv1 = nn.Conv1d(channels, channels, 3, dilation=dilation)
        self.conv2 = nn.Conv1d(channels, channels, 3, dilation=dilation)
        self.padding = padding

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        one = torch.nn.functional.gelu(self.conv1(torch.nn.functional.pad(x, (self.padding, 0))))
        two = self.conv2(torch.nn.functional.pad(one, (self.padding, 0)))
        return torch.nn.functional.gelu(x + two)


class TransformerForecaster(nn.Module):
    def __init__(self, width: int = 48, heads: int = 4):
        super().__init__()
        self.project = nn.Linear(48, width)
        self.position = nn.Parameter(torch.zeros(1, CONTEXT_STEPS, width))
        layer = nn.TransformerEncoderLayer(width, heads, dim_feedforward=96, dropout=0.0,
                                           batch_first=True, norm_first=True, activation="gelu")
        self.encoder = nn.TransformerEncoder(layer, num_layers=2, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(width)
        self.head = nn.Linear(width, 18)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        values = self.encoder(self.project(x) + self.position)
        return ordered_quantiles(self.head(self.norm(values[:, -1])))


def ordered_quantiles(raw: torch.Tensor) -> torch.Tensor:
    values = raw.view(-1, len(HORIZONS_HOURS), len(TARGETS), 3)
    q10 = values[..., 0]
    q50 = q10 + torch.nn.functional.softplus(values[..., 1])
    q90 = q50 + torch.nn.functional.softplus(values[..., 2])
    result = torch.stack((q10, q50, q90), dim=-1)
    if not torch.all(result[..., 0] <= result[..., 1]) or not torch.all(result[..., 1] <= result[..., 2]):
        raise ForecastDataError("model quantile outputs must be ordered")
    return result


def pinball_loss(prediction: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    quantiles = torch.as_tensor(QUANTILES, dtype=prediction.dtype, device=prediction.device)
    error = target.unsqueeze(-1) - prediction
    return torch.maximum(quantiles * error, (quantiles - 1.0) * error).mean()


def metrics(actual: np.ndarray, predicted: np.ndarray,
            target_scales: np.ndarray | None = None) -> dict[str, Any]:
    """Report native per-target metrics plus train-scale-normalized pinball loss."""
    if predicted.shape != (*actual.shape, len(QUANTILES)):
        raise ForecastDataError("prediction shape must be [N,3,2,3]")
    scales = np.ones((len(HORIZONS_HOURS), len(TARGETS)), dtype=np.float64) if target_scales is None else np.asarray(target_scales, dtype=np.float64)
    if scales.shape != (len(HORIZONS_HOURS), len(TARGETS)) or not np.isfinite(scales).all() or np.any(scales <= 0):
        raise ForecastDataError("target scales must be finite positive train-only values shaped [3,2]")
    if np.any(predicted[..., 0] > predicted[..., 1]) or np.any(predicted[..., 1] > predicted[..., 2]):
        raise ForecastDataError("quantile ordering violation")
    output: dict[str, Any] = {"rows": int(len(actual)), "by_horizon_target": {}}
    all_losses = []
    normalized_group_losses = []
    for horizon_index, horizon in enumerate(HORIZONS_HOURS):
        for target_index, target_name in enumerate(TARGETS):
            y = actual[:, horizon_index, target_index]
            q = predicted[:, horizon_index, target_index, :]
            error = y[:, None] - q
            loss = np.maximum(np.asarray(QUANTILES) * error,
                              (np.asarray(QUANTILES) - 1) * error)
            pinball = loss.mean(axis=0)
            all_losses.extend(loss.ravel().tolist())
            normalized_error = error / scales[horizon_index, target_index]
            normalized_loss = np.maximum(np.asarray(QUANTILES) * normalized_error,
                                         (np.asarray(QUANTILES) - 1) * normalized_error)
            normalized_group_losses.append(float(normalized_loss.mean()))
            output["by_horizon_target"][f"{horizon}h_{target_name}"] = {
                "pinball_q10": float(pinball[0]), "pinball_q50": float(pinball[1]),
                "pinball_q90": float(pinball[2]), "pinball_mean": float(loss.mean()),
                "q50_mae": float(np.mean(np.abs(y - q[:, 1]))),
                "q10_coverage": float(np.mean(y <= q[:, 0])),
                "q90_coverage": float(np.mean(y <= q[:, 2])),
                "interval_80_coverage": float(np.mean((y >= q[:, 0]) & (y <= q[:, 2]))),
                "interval_mean_width": float(np.mean(q[:, 2] - q[:, 0])),
            }
    output["pooled_pinball_mean_native_units"] = float(np.mean(all_losses))
    output["macro_train_scale_normalized_pinball_mean"] = float(np.mean(normalized_group_losses))
    return output


def naive_predictions(x: np.ndarray, *, seasonal: bool) -> np.ndarray:
    """Use the last value or previous-day same-time value for each horizon."""
    if x.ndim != 3 or x.shape[1:] != (CONTEXT_STEPS, 48):
        raise ForecastDataError("naive baseline expects existing [N,96,48] windows")
    forecast = np.zeros((len(x), len(HORIZONS_HOURS), len(TARGETS)), dtype=np.float32)
    source_steps = (24, 0, 0) if seasonal else (-1, -1, -1)
    for horizon_index, step in enumerate(source_steps):
        values = x[:, step, :].reshape(len(x), EXPECTED_SENSORS, FEATURES_PER_SENSOR)
        observed = values[..., 2] < 0.5
        for target_index in range(len(TARGETS)):
            safe = np.where(observed, values[..., target_index], np.nan)
            with np.errstate(all="ignore"):
                means = np.nanmean(safe, axis=1)
            if np.isnan(means).any():
                raise ForecastDataError("naive input window has no observed sensor target")
            forecast[:, horizon_index, target_index] = means
    return np.repeat(forecast[..., None], len(QUANTILES), axis=-1)


def fit_model(model: nn.Module, train_x: np.ndarray, train_y: np.ndarray,
              validation_x: np.ndarray, validation_y: np.ndarray, *, epochs: int = 8,
              seed: int = 2401) -> tuple[nn.Module, dict[str, float]]:
    if epochs < 1 or epochs > 30:
        raise ForecastDataError("CPU research epoch budget must be between 1 and 30")
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)
    normalizer = InputNormalizer.fit(train_x)
    target_normalizer = TargetNormalizer.fit(train_y)
    tx = normalizer.transform(train_x)
    vx = normalizer.transform(validation_x)
    ty = target_normalizer.transform(train_y)
    vy = target_normalizer.transform(validation_y)
    train_loader = DataLoader(TensorDataset(torch.from_numpy(tx), torch.from_numpy(ty)),
                              batch_size=32, shuffle=True, generator=torch.Generator().manual_seed(seed))
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.0001)
    best_state = None
    best_validation = float("inf")
    for _ in range(epochs):
        model.train()
        for bx, by in train_loader:
            optimizer.zero_grad(set_to_none=True)
            loss = pinball_loss(model(bx), by)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
        model.eval()
        with torch.no_grad():
            validation_loss = float(pinball_loss(model(torch.from_numpy(vx)), torch.from_numpy(vy)))
        if validation_loss < best_validation:
            best_validation = validation_loss
            best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
    if best_state is None:
        raise ForecastDataError("training produced no validation checkpoint")
    model.load_state_dict(best_state)
    model.eval()
    # The training-only transforms are attached for transparent inference/reporting.
    model._forecast_input_normalizer = normalizer  # type: ignore[attr-defined]
    model._forecast_target_normalizer = target_normalizer  # type: ignore[attr-defined]
    return model, {"best_validation_pinball_normalized": best_validation,
                   "epochs_budget": float(epochs)}


def predict(model: nn.Module, x: np.ndarray) -> np.ndarray:
    normalizer = getattr(model, "_forecast_input_normalizer", None)
    target_normalizer = getattr(model, "_forecast_target_normalizer", None)
    if normalizer is None or target_normalizer is None:
        raise ForecastDataError("model is missing train-fitted normalization")
    model.eval()
    with torch.no_grad():
        normalized = model(torch.from_numpy(normalizer.transform(x))).cpu().numpy()
    result = target_normalizer.inverse(normalized)
    if np.any(result[..., 0] > result[..., 1]) or np.any(result[..., 1] > result[..., 2]):
        raise ForecastDataError("inverse-scaled forecast quantiles must be ordered")
    return result.astype(np.float64)


def default_experiment_split(seeds: Iterable[int]) -> TemporalSeedSplit:
    ids = tuple(sorted(int(seed) for seed in seeds))
    if len(ids) != 9:
        raise ForecastDataError("bounded default experiment requires exactly nine explicit synthetic seeds")
    return TemporalSeedSplit(
        train_seeds=ids[:3], validation_seeds=ids[3:6], test_seeds=ids[6:],
        train_end=START + timedelta(days=5),
        validation_start=START + timedelta(days=9), validation_end=START + timedelta(days=10),
        test_start=START + timedelta(days=14), test_end=START + timedelta(days=17),
    )


def run_forecast_experiment(rows: ForecastRows, split: TemporalSeedSplit, *, epochs: int = 8,
                            seed: int = 2401) -> dict[str, Any]:
    indexes = temporal_seed_split(rows, split)
    x_train, y_train = rows.x[indexes.train], rows.y[indexes.train]
    x_validation, y_validation = rows.x[indexes.validation], rows.y[indexes.validation]
    x_test, y_test = rows.x[indexes.test], rows.y[indexes.test]
    target_scale = TargetNormalizer.fit(y_train).scale.astype(np.float64)
    if len(set(rows.seeds[indexes.train]) & set(rows.seeds[indexes.test])):
        raise ForecastDataError("train/test simulator seeds overlap")
    factories = {
        "lstm": LSTMForecaster,
        "tcn": TCNForecaster,
        "transformer": TransformerForecaster,
    }
    results: dict[str, Any] = {
        "eligibility": "synthetic_offline_research_only_not_production_eligible",
        "target": "future bin-mean temperature and relative humidity",
        "target_origin": "synthetic grain simulator sensor readings; not measured grain condition or spoilage",
        "horizons_hours": list(HORIZONS_HOURS), "quantiles": list(QUANTILES),
        "input_shape": list(rows.x.shape[1:]), "purge_hours": PURGE_HOURS,
        "train_seed_ids": sorted(int(seed) for seed in set(rows.seeds[indexes.train])),
        "validation_seed_ids": sorted(int(seed) for seed in set(rows.seeds[indexes.validation])),
        "test_seed_ids": sorted(int(seed) for seed in set(rows.seeds[indexes.test])),
        "train_as_of_range": [min(rows.as_ofs[i] for i in indexes.train).isoformat(),
                               max(rows.as_ofs[i] for i in indexes.train).isoformat()],
        "validation_as_of_range": [min(rows.as_ofs[i] for i in indexes.validation).isoformat(),
                                   max(rows.as_ofs[i] for i in indexes.validation).isoformat()],
        "test_as_of_range": [min(rows.as_ofs[i] for i in indexes.test).isoformat(),
                              max(rows.as_ofs[i] for i in indexes.test).isoformat()],
        "sample_counts": {"train": len(indexes.train), "validation": len(indexes.validation),
                          "test": len(indexes.test)},
        "censored_candidates_by_horizon": rows.censored_candidates,
        "normalization": "input and target statistics fit only on train indices",
        "selection": "fixed architectures; best epoch selected only by validation pinball; test evaluated once",
        "models": {},
    }
    results["training_contract"] = {
        "base_seed": seed, "per_model_seeds": {"lstm": seed, "tcn": seed + 1, "transformer": seed + 2},
        "optimizer": "AdamW", "learning_rate": 0.001, "weight_decay": 0.0001,
        "batch_size": 32, "gradient_clip_norm": 1.0, "deterministic_algorithms": True,
    }
    results["models"]["persistence"] = metrics(y_test, naive_predictions(x_test, seasonal=False), target_scale)
    results["models"]["seasonal_naive_24h"] = metrics(y_test, naive_predictions(x_test, seasonal=True), target_scale)
    for offset, (name, factory) in enumerate(factories.items()):
        torch.manual_seed(seed + offset)
        model, fit = fit_model(factory(), x_train, y_train, x_validation, y_validation,
                               epochs=epochs, seed=seed + offset)
        results["models"][name] = {**metrics(y_test, predict(model, x_test), target_scale),
                                   "training": fit}
    return results
