"""Small CPU baselines over I1's synthetic 96-step sensor-window export.

The target is only the simulator's ``simulated_hotspot_onset_48h`` label. It is
not a spoilage outcome, calibrated physics label, or product prediction.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any, Iterable

import numpy as np
import pyarrow.parquet as pq
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from ml.deep_learning.comparison_contract import (
    SequenceDataError, TemporalSplit, binary_metrics, frozen_comparison, naive_prevalence_metrics,
    split_by_time, verify_frozen_comparison,
)

ROOT = Path(__file__).resolve().parents[2]
CONTEXT_STEPS = 96
SENSOR_COUNT = 16
VALUES_PER_SENSOR = 3  # temperature, relative humidity, missing indicator
INPUT_FEATURES = SENSOR_COUNT * VALUES_PER_SENSOR
TARGET = "simulated_hotspot_onset_48h"
TARGET_SEMANTICS = "a simulator hotspot false-to-true transition occurs within the following 48 hours; an already-active hotspot is negative"


@dataclass(frozen=True)
class SequenceExamples:
    x: np.ndarray
    y: np.ndarray
    seeds: np.ndarray
    run_ids: tuple[str, ...]
    as_ofs: tuple[Any, ...]


@dataclass(frozen=True)
class RunSplit:
    train: tuple[int, ...]
    validation: tuple[int, ...]
    test: tuple[int, ...]


def split_by_seed(seed_ids: Iterable[int], split: RunSplit) -> dict[str, np.ndarray]:
    """Assign complete simulator seeds to splits; never split rows/windows."""
    known = set(int(seed) for seed in seed_ids)
    groups = {"train": set(split.train), "validation": set(split.validation), "test": set(split.test)}
    if any(not values for values in groups.values()):
        raise SequenceDataError("each split needs at least one independent simulator seed")
    if any(isinstance(seed, bool) or seed < 0 for values in groups.values() for seed in values):
        raise SequenceDataError("seed IDs must be non-negative integers")
    if sum(map(len, groups.values())) != len(set().union(*groups.values())):
        raise SequenceDataError("a simulator seed appears in multiple splits")
    if set().union(*groups.values()) != known:
        raise SequenceDataError("split seeds must exactly cover the supplied complete runs")
    return {name: np.asarray(sorted(values), dtype=np.int64) for name, values in groups.items()}


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_corpus(corpus_dir: Path) -> tuple[int, list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        manifest = json.loads((corpus_dir / "manifest.json").read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SequenceDataError(f"invalid corpus manifest: {corpus_dir}") from exc
    if (manifest.get("synthetic_only") is not True or manifest.get("label_not_spoilage") is not True
            or manifest.get("label_name") != TARGET or manifest.get("split") != "unsplit_synthetic_run"):
        raise SequenceDataError("I3 accepts only unsplit synthetic hotspot corpora")
    if manifest.get("sequence_length") != CONTEXT_STEPS:
        raise SequenceDataError("I3 requires 96-step sequence windows")
    files = manifest.get("files", {})
    names = ("sequence_windows.parquet", "labels.parquet", "mount_context.parquet")
    for name in names:
        path = corpus_dir / name
        if not path.is_file() or files.get(name, {}).get("sha256") != _sha(path):
            raise SequenceDataError(f"missing or checksum-mismatched {name}")
    sequence_rows = pq.read_table(corpus_dir / names[0]).to_pylist()
    label_rows = pq.read_table(corpus_dir / names[1]).to_pylist()
    mounts = pq.read_table(corpus_dir / names[2]).to_pylist()
    return int(manifest["seed"]), sequence_rows, label_rows, mounts


def load_corpora(corpus_dirs: Iterable[Path]) -> SequenceExamples:
    """Join 16 per-device 96-step rows to one bin/time label.

    Model input is ``[examples, 96, 48]``: for each fixed cable/depth sensor,
    temperature, RH, and missing indicator. Mount coordinates determine the
    stable sensor order but are not model features. Ambient/lot metadata is not
    included in this prototype.
    """
    examples: list[np.ndarray] = []
    labels: list[int] = []
    seeds: list[int] = []
    run_ids: list[str] = []
    as_ofs: list[Any] = []
    seen_runs: set[str] = set()
    for directory in corpus_dirs:
        seed, rows, label_rows, mounts = _read_corpus(Path(directory))
        if not rows or len(mounts) != SENSOR_COUNT:
            raise SequenceDataError("each run needs sequence rows and all 16 mount records")
        run_pk = str(rows[0].get("run_pk"))
        if run_pk in seen_runs or any(str(row.get("run_pk")) != run_pk for row in rows):
            raise SequenceDataError("each corpus directory must contain exactly one unique run")
        seen_runs.add(run_pk)
        mount_by_device = {row["device_pk"]: row for row in mounts}
        if len(mount_by_device) != SENSOR_COUNT:
            raise SequenceDataError("mount device keys must be unique")
        ordered = sorted(mount_by_device, key=lambda key: (
            mount_by_device[key]["cable_label"], mount_by_device[key]["node_index"]))
        device_index = {device: index for index, device in enumerate(ordered)}
        labels_by_time = {row["as_of"]: row for row in label_rows}
        if len(labels_by_time) != len(label_rows) or any(
                row.get("label") != TARGET or row.get("label_not_spoilage") is not True
                or row.get("data_origin") != "synthetic_grain_sim" for row in label_rows):
            raise SequenceDataError("labels are duplicate, unsupported, or not synthetic hotspot labels")
        grouped: dict[Any, dict[str, dict[str, Any]]] = {}
        for row in rows:
            if row.get("data_origin") != "synthetic_grain_sim" or row.get("synthetic_only") is not True:
                raise SequenceDataError("sequence row is not marked synthetic")
            if row.get("sequence_length") != CONTEXT_STEPS or row.get("device_pk") not in device_index:
                raise SequenceDataError("sequence row does not match the 96-step/mount schema")
            if len(row.get("temperature_c", [])) != CONTEXT_STEPS or len(row.get("relative_humidity_percent", [])) != CONTEXT_STEPS or len(row.get("missing_mask", [])) != CONTEXT_STEPS:
                raise SequenceDataError("sequence arrays must all have exactly 96 values")
            sensor_rows = grouped.setdefault(row["as_of"], {})
            if row["device_pk"] in sensor_rows:
                raise SequenceDataError("duplicate sequence row for device and timestamp")
            sensor_rows[row["device_pk"]] = row
        for as_of in sorted(grouped):
            sensor_rows = grouped[as_of]
            if set(sensor_rows) != set(device_index):
                raise SequenceDataError("each bin/as_of sample must contain exactly one row per sensor")
            if as_of not in labels_by_time:
                raise SequenceDataError("sequence sample is missing its exact as_of target label")
            target = labels_by_time[as_of]
            if target.get("value") not in (True, False):
                raise SequenceDataError("target label must be boolean")
            window = np.zeros((CONTEXT_STEPS, INPUT_FEATURES), dtype=np.float32)
            for device, index in device_index.items():
                row = sensor_rows[device]
                temperatures = row["temperature_c"]
                humidities = row["relative_humidity_percent"]
                mask = row["missing_mask"]
                for step, missing in enumerate(mask):
                    offset = index * VALUES_PER_SENSOR
                    if not missing:
                        if temperatures[step] is None or humidities[step] is None:
                            raise SequenceDataError("unmasked sensor values must be present")
                        window[step, offset] = float(temperatures[step])
                        window[step, offset + 1] = float(humidities[step])
                    window[step, offset + 2] = float(bool(missing))
            examples.append(window)
            labels.append(int(target["value"]))
            seeds.append(seed)
            run_ids.append(run_pk)
            as_ofs.append(as_of)
    if not examples:
        raise SequenceDataError("no sequence windows found")
    return SequenceExamples(np.stack(examples), np.asarray(labels, dtype=np.float32),
                            np.asarray(seeds, dtype=np.int64), tuple(run_ids), tuple(as_ofs))


@dataclass(frozen=True)
class Normalizer:
    mean: np.ndarray
    scale: np.ndarray

    @classmethod
    def fit(cls, train_x: np.ndarray) -> "Normalizer":
        if train_x.ndim != 3 or train_x.shape[-1] != INPUT_FEATURES or not len(train_x):
            raise SequenceDataError("normalizer expects non-empty [N, 96, 48] training data")
        mean = np.mean(train_x, axis=(0, 1), dtype=np.float64).astype(np.float32)
        scale = np.std(train_x, axis=(0, 1), dtype=np.float64).astype(np.float32)
        scale[scale < 1e-6] = 1.0
        return cls(mean, scale)

    def transform(self, x: np.ndarray) -> np.ndarray:
        return ((x - self.mean[None, None, :]) / self.scale[None, None, :]).astype(np.float32)


class LSTMClassifier(nn.Module):
    def __init__(self, input_features: int = INPUT_FEATURES, hidden: int = 16):
        super().__init__()
        self.rnn = nn.LSTM(input_features, hidden, batch_first=True)
        self.output = nn.Linear(hidden, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        _, (hidden, _) = self.rnn(x)
        return self.output(hidden[-1]).squeeze(-1)


class CausalConv1d(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, kernel_size: int = 3, dilation: int = 1):
        super().__init__()
        self.left_padding = (kernel_size - 1) * dilation
        self.conv = nn.Conv1d(in_channels, out_channels, kernel_size, dilation=dilation)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.conv(nn.functional.pad(x, (self.left_padding, 0)))


class TCNBlock(nn.Module):
    def __init__(self, channels: int, dilation: int):
        super().__init__()
        self.first = CausalConv1d(channels, channels, dilation=dilation)
        self.second = CausalConv1d(channels, channels, dilation=dilation)
        self.activation = nn.GELU()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.activation(self.second(self.activation(self.first(x))))


class TCNClassifier(nn.Module):
    def __init__(self, input_features: int = INPUT_FEATURES, channels: int = 16):
        super().__init__()
        self.project = nn.Conv1d(input_features, channels, 1)
        self.blocks = nn.Sequential(TCNBlock(channels, 1), TCNBlock(channels, 2), TCNBlock(channels, 4))
        self.output = nn.Linear(channels, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        values = self.blocks(self.project(x.transpose(1, 2)))
        return self.output(values[:, :, -1]).squeeze(-1)


class ScaledDotProductAttention(nn.Module):
    """Explicit scaled dot-product attention with safe fully-masked rows.

    Boolean masks follow PyTorch SDPA semantics: True means the key is allowed.
    Attention accumulation and softmax use float32 for stable half precision.
    """

    def forward(self, query: torch.Tensor, key: torch.Tensor, value: torch.Tensor,
                attention_mask: torch.Tensor | None = None, *, is_causal: bool = False) -> torch.Tensor:
        if query.ndim != 4 or key.ndim != 4 or value.ndim != 4:
            raise SequenceDataError("attention expects [batch, heads, sequence, feature] tensors")
        if query.shape[:2] != key.shape[:2] or key.shape[:3] != value.shape[:3] or query.shape[-1] != key.shape[-1]:
            raise SequenceDataError("attention query/key/value dimensions do not match")
        compute_dtype = torch.float64 if query.dtype == torch.float64 else torch.float32
        q, k, v = query.to(compute_dtype), key.to(compute_dtype), value.to(compute_dtype)
        scores = torch.matmul(q, k.transpose(-2, -1)) / (query.shape[-1] ** 0.5)
        allowed = None
        if attention_mask is not None:
            if attention_mask.dtype == torch.bool:
                allowed = attention_mask
            else:
                scores = scores + attention_mask.to(compute_dtype)
        if is_causal:
            causal = torch.ones((query.shape[-2], key.shape[-2]), dtype=torch.bool,
                                device=query.device).tril()
            allowed = causal if allowed is None else (allowed & causal)
        if allowed is not None:
            scores = scores.masked_fill(~allowed, float("-inf"))
        # Additive and boolean/causal masks can jointly exclude every key.
        fully_masked = torch.isneginf(scores).all(dim=-1, keepdim=True)
        scores = scores.masked_fill(fully_masked, 0.0)
        weights = torch.softmax(scores, dim=-1).masked_fill(fully_masked, 0.0)
        result = torch.matmul(weights, v)
        return result.to(dtype=value.dtype)


class MultiHeadAttention(nn.Module):
    def __init__(self, width: int, heads: int, dropout: float = 0.0):
        super().__init__()
        if width % heads:
            raise SequenceDataError("attention width must be divisible by number of heads")
        self.width, self.heads, self.head_width = width, heads, width // heads
        self.qkv = nn.Linear(width, width * 3)
        self.output = nn.Linear(width, width)
        self.attention = ScaledDotProductAttention()
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, key_mask: torch.Tensor | None = None) -> torch.Tensor:
        batch, length, _ = x.shape
        qkv = self.qkv(x).reshape(batch, length, 3, self.heads, self.head_width)
        query, key, value = (qkv[:, :, index].transpose(1, 2) for index in range(3))
        mask = key_mask[:, None, None, :] if key_mask is not None else None
        attended = self.attention(query, key, value, mask)
        attended = attended.transpose(1, 2).reshape(batch, length, self.width)
        projected = self.output(self.dropout(attended))
        if key_mask is not None:
            projected = projected.masked_fill(~key_mask.any(dim=1)[:, None, None], 0.0)
        return projected


def sinusoidal_positions(length: int, width: int, *, device: torch.device | None = None,
                         dtype: torch.dtype = torch.float32) -> torch.Tensor:
    if length < 1 or width < 2:
        raise SequenceDataError("positional encoding needs positive length and width >= 2")
    positions = torch.arange(length, device=device, dtype=torch.float32).unsqueeze(1)
    scale = torch.exp(torch.arange(0, width, 2, device=device, dtype=torch.float32)
                      * (-torch.log(torch.tensor(10000.0, device=device)) / width))
    angles = positions * scale.unsqueeze(0)
    result = torch.zeros((length, width), device=device, dtype=torch.float32)
    result[:, 0::2] = torch.sin(angles)
    result[:, 1::2] = torch.cos(angles[:, :result[:, 1::2].shape[1]])
    return result.to(dtype=dtype)


class TransformerEncoderBlock(nn.Module):
    """Pre-norm transformer block built without nn.Transformer/MHA helpers."""

    def __init__(self, width: int = 32, heads: int = 4, dropout: float = 0.0):
        super().__init__()
        self.norm_attention = nn.LayerNorm(width)
        self.attention = MultiHeadAttention(width, heads, dropout)
        self.norm_feedforward = nn.LayerNorm(width)
        self.feedforward = nn.Sequential(
            nn.Linear(width, width * 4), nn.GELU(), nn.Dropout(dropout), nn.Linear(width * 4, width),
        )
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, key_mask: torch.Tensor) -> torch.Tensor:
        x = x + self.dropout(self.attention(self.norm_attention(x), key_mask))
        return x + self.dropout(self.feedforward(self.norm_feedforward(x)))


class TransformerClassifier(nn.Module):
    """Patch encoder for 24-hour sensor windows and synthetic hotspot labels.

    Sensor channels share one temporal encoder (channel independence). Context
    RevIN uses only the current 24-hour input; sensor attention combines the
    encoded channel summaries into one bin-level classifier output.
    """

    def __init__(self, patch_length: int = 8, patch_stride: int = 4,
                 width: int = 32, heads: int = 4, layers: int = 2,
                 maximum_steps: int = CONTEXT_STEPS):
        super().__init__()
        if patch_length < 1 or patch_stride < 1 or maximum_steps < patch_length:
            raise SequenceDataError("invalid patch/context dimensions")
        self.patch_length, self.patch_stride, self.maximum_steps = patch_length, patch_stride, maximum_steps
        self.maximum_patches = 1 + (maximum_steps - patch_length) // patch_stride
        self.patch_embedding = nn.Linear(patch_length * 3, width)
        self.blocks = nn.ModuleList(TransformerEncoderBlock(width, heads) for _ in range(layers))
        self.norm = nn.LayerNorm(width)
        self.sensor_score = nn.Linear(width, 1)
        self.output = nn.Sequential(nn.Linear(width * 2, width), nn.GELU(), nn.Linear(width, 1))

    def forward_with_status(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        if x.ndim != 3 or x.shape[1] < self.patch_length or x.shape[1] > self.maximum_steps or x.shape[2] % 3:
            raise SequenceDataError("Transformer input must be [batch, 8..96 steps, 3 features per sensor]")
        batch, steps, feature_count = x.shape
        sensors = feature_count // 3
        sensor_data = x.reshape(batch, steps, sensors, 3).permute(0, 2, 1, 3)
        values, missing = sensor_data[..., :2], sensor_data[..., 2] > 0.5

        # RevIN-style per-example/per-sensor normalization over observed context only.
        observed_mask = (~missing).unsqueeze(-1)
        if torch.any(observed_mask & ~torch.isfinite(values)):
            raise SequenceDataError("unmasked Transformer sensor values must be finite")
        observed = observed_mask.to(values.dtype)
        values = torch.where(observed_mask, values, torch.zeros_like(values))
        count = observed.sum(dim=2, keepdim=True).clamp_min(1.0)
        mean = (values * observed).sum(dim=2, keepdim=True) / count
        variance = (((values - mean) * observed) ** 2).sum(dim=2, keepdim=True) / count
        scale = variance.sqrt().clamp_min(1e-5)
        normalized_values = ((values - mean) / scale) * observed
        sensor_features = torch.cat((normalized_values, missing.unsqueeze(-1).to(values.dtype)), dim=-1)

        # [B,S,T,3] -> [B*S,P,patch*3].
        patches = sensor_features.unfold(2, self.patch_length, self.patch_stride)
        patch_count = patches.shape[2]
        patches = patches.permute(0, 1, 2, 4, 3).reshape(batch * sensors, patch_count, -1)
        missing_patches = missing.unfold(2, self.patch_length, self.patch_stride).all(dim=-1)
        valid_patches = ~missing_patches.reshape(batch * sensors, patch_count)
        encoded = self.patch_embedding(patches)
        encoded = encoded + sinusoidal_positions(patch_count, encoded.shape[-1], device=x.device,
                                                 dtype=encoded.dtype).unsqueeze(0)
        for block in self.blocks:
            encoded = block(encoded, valid_patches)
        encoded = self.norm(encoded)
        positions = torch.arange(patch_count, device=x.device).expand(batch * sensors, -1)
        last_valid = positions.masked_fill(~valid_patches, -1).max(dim=1).values.clamp_min(0)
        sensor_repr = encoded[torch.arange(batch * sensors, device=x.device), last_valid]
        valid_sensors = valid_patches.any(dim=1).reshape(batch, sensors)
        sensor_repr = sensor_repr.reshape(batch, sensors, -1).masked_fill(~valid_sensors.unsqueeze(-1), 0.0)

        attention_scores = self.sensor_score(sensor_repr).squeeze(-1).masked_fill(~valid_sensors, float("-inf"))
        fully_masked = ~valid_sensors.any(dim=1)
        attention_scores = attention_scores.masked_fill(fully_masked.unsqueeze(-1), 0.0)
        attention_weights = torch.softmax(attention_scores, dim=1).masked_fill(~valid_sensors, 0.0)
        attention_weights = attention_weights.masked_fill(fully_masked.unsqueeze(-1), 0.0)
        weighted = (sensor_repr * attention_weights.unsqueeze(-1)).sum(dim=1)
        maximum = sensor_repr.masked_fill(~valid_sensors.unsqueeze(-1), float("-inf")).max(dim=1).values
        maximum = maximum.masked_fill(fully_masked.unsqueeze(-1), 0.0)
        logits = self.output(torch.cat((weighted, maximum), dim=-1)).squeeze(-1)
        logits = logits.masked_fill(fully_masked, 0.0)
        return logits, fully_masked

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.forward_with_status(x)[0]


def brier_score(labels: np.ndarray, probabilities: np.ndarray) -> float:
    if len(labels) == 0 or labels.shape != probabilities.shape:
        raise SequenceDataError("Brier score needs equally sized non-empty vectors")
    return binary_metrics(labels, probabilities)["brier"]


def _training_drift_reference(train_x: np.ndarray, split_fingerprint: str) -> dict[str, Any]:
    """Build fixed synthetic training-only bins for online input PSI monitoring."""
    features: dict[str, Any] = {}
    missing = train_x[:, :, 2::VALUES_PER_SENSOR] >= 0.5
    for name, channel in (("temperature_c", 0), ("relative_humidity_percent", 1)):
        values = train_x[:, :, channel::VALUES_PER_SENSOR][~missing]
        values = values[np.isfinite(values)]
        if values.size < 100:
            raise SequenceDataError(f"training data cannot define a stable PSI reference for {name}")
        edges = np.unique(np.quantile(values, np.linspace(0.1, 0.9, 9)))
        if edges.size < 2:
            minimum, maximum = float(values.min()), float(values.max())
            if minimum == maximum:
                epsilon = max(abs(minimum) * 1e-6, 1e-6)
                edges = np.asarray([minimum - epsilon, maximum + epsilon])
            else:
                edges = np.asarray([minimum, maximum])
        counts = np.bincount(np.searchsorted(edges, values, side="left"), minlength=edges.size + 1)
        features[name] = {
            "edges": edges.astype(float).tolist(),
            "reference_proportions": (counts / counts.sum()).astype(float).tolist(),
            "reference_count": int(values.size),
        }
    return {
        "schema_version": "greenguard-drift-reference-v1",
        "data_origin": "synthetic_grain_sim",
        "synthetic_only": True,
        "reference_split": "train",
        "training_split_fingerprint": split_fingerprint,
        "minimum_samples": 512,
        "window_size": 2048,
        "update_every": 128,
        "features": features,
    }


def state_tensor_fingerprint(state: dict[str, torch.Tensor]) -> str:
    """Stable weight fingerprint independent of torch serialization storage IDs."""
    digest = hashlib.sha256()
    for name, tensor in sorted(state.items()):
        array = tensor.detach().cpu().contiguous().numpy()
        digest.update(json.dumps([name, str(array.dtype), list(array.shape)], separators=(",", ":")).encode())
        digest.update(array.tobytes())
    return digest.hexdigest()


def _probabilities(model: nn.Module, x: np.ndarray) -> np.ndarray:
    model.eval()
    with torch.no_grad():
        logits = model(torch.from_numpy(x))
        return torch.sigmoid(logits).cpu().numpy()


def _train(model: nn.Module, x: np.ndarray, y: np.ndarray, *, epochs: int, seed: int) -> None:
    torch.manual_seed(seed)
    torch.set_num_threads(1)
    loader = DataLoader(TensorDataset(torch.from_numpy(x), torch.from_numpy(y)), batch_size=32, shuffle=True,
                        generator=torch.Generator().manual_seed(seed), num_workers=0)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.01)
    criterion = nn.BCEWithLogitsLoss()
    for _ in range(epochs):
        model.train()
        for batch_x, batch_y in loader:
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(batch_x), batch_y)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()


def run_experiment(corpora: Iterable[Path], output: Path, *,
                   split: RunSplit | TemporalSplit = RunSplit((10, 11, 12, 13, 14, 15), (16, 17, 18), (19, 20, 21)),
                   epochs: int = 8, seed: int = 20260930,
                   include_classical_baselines: bool = False,
                   include_transformer: bool = False,
                   export_transformer_artifact: bool = False,
                   frozen_split: Path | None = None) -> dict[str, Any]:
    """Train fixed small baselines, then score validation and test once each."""
    if epochs < 1 or epochs > 50:
        raise SequenceDataError("epochs must be in the bounded 1..50 research range")
    corpus_dirs = tuple(Path(path) for path in corpora)
    data = load_corpora(corpus_dirs)
    if isinstance(split, TemporalSplit):
        row_indices = split_by_time(data.as_ofs, data.seeds, split)
        indices = {name: np.unique(data.seeds[rows]) for name, rows in row_indices.items()}
        split_unit = ("disjoint simulator run cohorts plus chronological windows with a purged 24h context + 48h label horizon"
                      if split.train_seeds else "chronological windows with a purged 24h context + 48h label horizon")
        split_definition: dict[str, Any] = split.as_dict()
    else:
        indices = split_by_seed(np.unique(data.seeds), split)
        row_indices = {name: np.flatnonzero(np.isin(data.seeds, values)) for name, values in indices.items()}
        split_unit = "complete simulator seed/run; no overlapping windows cross splits"
        split_definition = {name: values.tolist() for name, values in indices.items()}
    if any(not len(rows) for rows in row_indices.values()):
        raise SequenceDataError("every split must contain at least one complete run window")
    frozen = frozen_comparison(corpus_dirs, split_definition, {
        name: [(data.run_ids[index], data.as_ofs[index], data.y[index]) for index in rows]
        for name, rows in row_indices.items()
    })
    if frozen_split is not None:
        verify_frozen_comparison(frozen, json.loads(frozen_split.read_text()))
    split_fingerprints = frozen["split_fingerprints"]
    train_x = data.x[row_indices["train"]]
    train_y = data.y[row_indices["train"]]
    val_x, val_y = data.x[row_indices["validation"]], data.y[row_indices["validation"]]
    test_x, test_y = data.x[row_indices["test"]], data.y[row_indices["test"]]
    normalizer = Normalizer.fit(train_x)
    normalized = {name: normalizer.transform(data.x[rows]) for name, rows in row_indices.items()}
    class_diversity = {name: bool(np.unique(data.y[rows]).size == 2) for name, rows in row_indices.items()}
    comparison_allowed = all(class_diversity.values())
    torch.use_deterministic_algorithms(True)
    model_specs = [("lstm", LSTMClassifier), ("tcn", TCNClassifier)]
    if include_transformer:
        model_specs.append(("transformer", TransformerClassifier))
    reports = {}
    transformer_state: dict[str, torch.Tensor] | None = None
    for model_index, (name, factory) in enumerate(model_specs):
        model_seed = seed + model_index
        torch.manual_seed(model_seed)
        model = factory()
        model_inputs = ({"train": data.x[row_indices["train"]],
                         "validation": data.x[row_indices["validation"]],
                         "test": data.x[row_indices["test"]]} if name == "transformer" else normalized)
        _train(model, model_inputs["train"], train_y, epochs=epochs, seed=model_seed)
        if name == "transformer" and export_transformer_artifact:
            transformer_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
        val_probability = _probabilities(model, model_inputs["validation"])
        # The test cohort is scored once after all fixed training choices.
        test_probability = _probabilities(model, model_inputs["test"])
        reports[name] = {
            "validation": binary_metrics(val_y, val_probability),
            "test": binary_metrics(test_y, test_probability),
        }
    drift_reference = _training_drift_reference(train_x, split_fingerprints["train"])
    if include_classical_baselines and comparison_allowed:
        baseline_report = _fit_classical_subprocess(corpus_dirs, split, frozen)
        baseline_fingerprints = baseline_report.pop("_split_fingerprints", None)
        verify_frozen_comparison(baseline_report.pop("_frozen_comparison", {}), frozen)
        if baseline_fingerprints != split_fingerprints:
            raise SequenceDataError("classical and sequence models were not evaluated on identical split rows")
        reports.update(baseline_report)
    if include_classical_baselines:
        # A constant training-prevalence predictor is a leakage-resistant
        # floor, scored against the very same untouched test vector as every
        # other model. It is not fitted or tuned on validation/test labels.
        reports["naive_train_prevalence"] = naive_prevalence_metrics(train_y, test_y)
    report = {
        "schema_version": "synthetic-i4-transformer-experiment-v1" if include_transformer else "synthetic-i3-sequence-experiment-v1",
        "stage": "I4" if include_transformer else "I3",
        "data_origin": "synthetic_grain_sim", "synthetic_only": True,
        "target": TARGET, "label_not_spoilage": True,
        "target_semantics": TARGET_SEMANTICS,
        "split_unit": split_unit,
        "split_definition": split_definition,
        "split_fingerprints": split_fingerprints,
        "label_fingerprints": frozen["label_fingerprints"],
        "metrics": {"brier": "mean((label - probability)^2) in float64; no tuned threshold",
                    "naive_baseline": "constant train-split positive prevalence; scored on identical untouched test rows"},
        "drift_reference": drift_reference,
        "seeds": {name: values.tolist() for name, values in indices.items()},
        "examples": {name: len(rows) for name, rows in row_indices.items()},
        "class_rates": {name: float(np.mean(data.y[rows])) for name, rows in row_indices.items()},
        "label_class_diversity": class_diversity,
        "label_counts": {name: {"negative": int(np.sum(data.y[rows] == 0)),
                                "positive": int(np.sum(data.y[rows] == 1))}
                         for name, rows in row_indices.items()},
        "input_shape_per_example": [CONTEXT_STEPS, INPUT_FEATURES],
        "sensor_feature_order": "mount cable_label then node_index; temperature_c, relative_humidity_percent, missing_indicator",
        "normalization": {"lstm_tcn": "feature-wise mean/std fit on training examples only",
                          "transformer": "per-window per-sensor RevIN-style stats from observed input context only"},
        "training": {"device": "cpu", "epochs": epochs, "batch_size": 32, "optimizer": "AdamW(lr=0.001, weight_decay=0.01)",
                     "early_stopping": False, "test_used_for_selection": False, "seed": seed,
                     "deterministic_algorithms": True, "torch_threads": 1,
                     "model_seeds": {name: seed + i for i, (name, _) in enumerate(model_specs)}},
        "models": reports,
        "same_split_comparison_status": ("descriptive_metrics_only_no_selection" if comparison_allowed
                                          else "insufficient_evidence_class_degenerate_validation_or_test"),
        "limitations": [
            "The target is an uncalibrated simulator false-to-true hotspot transition in the next 48 hours, not spoilage or an agronomic outcome.",
            "Only synthetic seeds are present; independent sites and weather years are absent.",
            "Seeds are random simulator realizations of only three declared scenarios; independent sites and weather years are absent.",
            "This small fixed-epoch CPU experiment is descriptive, not a model-selection gate or promotion.",
            "This is a binary simulated-hotspot classifier comparison, not the I4 direct multi-horizon quantile forecast acceptance task.",
            "Ambient, lot, mount geometry and inventory context are not model inputs in this first sequence adapter.",
            "No real telemetry, ingest/Kafka/CDC parity, product wiring, or operational scoring was used.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    frozen_path = output.with_name(f"{output.stem}.frozen-split.json")
    frozen_path.write_text(json.dumps(frozen, indent=2, sort_keys=True) + "\n")
    report["frozen_comparison"] = {"path": frozen_path.name, "sha256": _sha(frozen_path),
                                   "validated_before_training": True}
    if transformer_state is not None:
        artifact_path = output.with_name(f"{output.stem}.transformer.state.pt")
        torch.save(transformer_state, artifact_path, _use_new_zipfile_serialization=False)
        report["model_artifacts"] = {
            "transformer": {"path": artifact_path.name, "sha256": _sha(artifact_path),
                            "state_tensor_sha256": state_tensor_fingerprint(transformer_state),
                            "architecture": "greenguard-patch-transformer-classifier-v1",
                            "data_origin": "synthetic_grain_sim", "production_eligible": False},
        }
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def _fit_classical_subprocess(corpora: tuple[Path, ...], split: RunSplit | TemporalSplit, frozen: dict) -> dict[str, Any]:
    """Run LightGBM without loading its OpenMP runtime into the torch process."""
    with tempfile.TemporaryDirectory(prefix="greenguard-i3-classical-") as temporary:
        output = Path(temporary) / "classical.json"
        command = [sys.executable, "-m", "ml.deep_learning.classical_baselines",
                   "--output", str(output)]
        frozen_path = Path(temporary) / "frozen-split.json"
        frozen_path.write_text(json.dumps(frozen, sort_keys=True))
        command.extend(("--frozen-split", str(frozen_path)))
        for corpus in corpora:
            command.extend(("--corpus", str(corpus)))
        if isinstance(split, TemporalSplit):
            split_path = Path(temporary) / "time-split.json"
            split_path.write_text(json.dumps(split.as_dict(), sort_keys=True))
            command.extend(("--time-split-json", str(split_path)))
        else:
            command.extend(("--train-seeds", *(str(seed) for seed in split.train)))
            command.extend(("--validation-seeds", *(str(seed) for seed in split.validation)))
            command.extend(("--test-seeds", *(str(seed) for seed in split.test)))
        environment = os.environ.copy()
        existing_pythonpath = environment.get("PYTHONPATH")
        environment["PYTHONPATH"] = os.pathsep.join(
            value for value in (str(ROOT), existing_pythonpath) if value
        )
        result = subprocess.run(command, capture_output=True, text=True, env=environment,
                                cwd=ROOT, check=False)
        if result.returncode != 0:
            raise SequenceDataError(f"isolated classical baseline failed: {result.stderr[-2000:]}")
        try:
            return json.loads(output.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise SequenceDataError("isolated classical baseline emitted invalid JSON") from exc
