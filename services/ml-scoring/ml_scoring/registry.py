"""Immutable, checksum-verified local model bundle loader."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import io
import json
import math
from pathlib import Path
import re
from typing import Any

import numpy as np
import torch

from ml.deep_learning.sequence_models import TransformerClassifier
from ml_scoring.deployment import RollingPSIMonitor


class ModelBundleError(ValueError):
    """Model bundle is invalid, incomplete, or failed its golden check."""


_VERSION = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_MODEL_NAME = "greenguard.hotspot-transition.classifier"
_ARCHITECTURE = "greenguard-patch-transformer-classifier-v1"
_FEATURE_SET_VERSION = "telemetry-sequence-v1-24h-15m"


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def derive_model_version(artifact_sha256: str, drift_reference: dict[str, Any]) -> str:
    drift_sha256 = hashlib.sha256(canonical_json_bytes(drift_reference)).hexdigest()
    version_digest = hashlib.sha256(f"{artifact_sha256}:{drift_sha256}".encode()).hexdigest()
    return f"i4-transformer-{version_digest[:16]}"


def validate_drift_reference(reference: object) -> dict[str, Any]:
    if not isinstance(reference, dict):
        raise ModelBundleError("model drift reference must be a JSON object")
    if (reference.get("schema_version") != "greenguard-drift-reference-v1"
            or reference.get("data_origin") != "synthetic_grain_sim"
            or reference.get("synthetic_only") is not True
            or reference.get("reference_split") != "train"):
        raise ModelBundleError("drift reference must be a synthetic training-only v1 artifact")
    fingerprint = reference.get("training_split_fingerprint")
    if not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        raise ModelBundleError("drift reference training fingerprint is invalid")
    minimum_samples = reference.get("minimum_samples")
    window_size = reference.get("window_size")
    update_every = reference.get("update_every")
    if any(type(value) is not int for value in (minimum_samples, window_size, update_every)):
        raise ModelBundleError("drift reference window settings must be exact integers")
    features = reference.get("features")
    if not isinstance(features, dict) or set(features) != {"temperature_c", "relative_humidity_percent"}:
        raise ModelBundleError("drift reference feature set is incompatible")
    for name, feature in features.items():
        if not isinstance(feature, dict):
            raise ModelBundleError(f"drift reference {name} must be a JSON object")
        edges, proportions, count = (feature.get("edges"), feature.get("reference_proportions"),
                                     feature.get("reference_count"))
        if (not isinstance(edges, list) or any(type(value) not in (int, float) for value in edges)
                or not isinstance(proportions, list)
                or any(type(value) not in (int, float) for value in proportions)
                or type(count) is not int or count < minimum_samples):
            raise ModelBundleError(f"drift reference {name} histogram is incomplete")
        try:
            RollingPSIMonitor(edges=list(edges), reference_proportions=list(proportions),
                              minimum_samples=minimum_samples, window_size=window_size,
                              update_every=update_every)
        except (TypeError, ValueError) as exc:
            raise ModelBundleError(f"drift reference {name} histogram is invalid") from exc
    return reference


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class ModelManifest:
    model_name: str
    model_version: str
    architecture: str
    artifact_sha256: str
    feature_set_version: str
    data_origin: str
    synthetic_only: bool
    production_eligible: bool
    target: str
    target_semantics: str
    golden_input_sha256: str
    golden_probability: float
    drift_reference: dict[str, Any]


@dataclass(frozen=True)
class LoadedModel:
    manifest: ModelManifest
    model: TransformerClassifier

    def predict(self, values: np.ndarray) -> np.ndarray:
        data = np.asarray(values, dtype=np.float32)
        if data.ndim != 3 or data.shape[1] != 96 or data.shape[2] % 3:
            raise ModelBundleError("model input must be [batch, 96, 3 features per sensor]")
        if not np.isfinite(data).all():
            raise ModelBundleError("model input must be finite; represent missingness with its mask feature")
        self.model.eval()
        with torch.inference_mode():
            logits = self.model(torch.from_numpy(data))
            return torch.sigmoid(logits).cpu().numpy().astype(np.float32)


class ModelRegistry:
    """Loads a single immutable version and refuses unvalidated promotion."""

    def __init__(self, root: Path | str, *, allow_synthetic_shadow: bool = False):
        self.root = Path(root).resolve()
        self.allow_synthetic_shadow = allow_synthetic_shadow

    def load(self, model_name: str, model_version: str) -> LoadedModel:
        if model_name != _MODEL_NAME or not _VERSION.fullmatch(model_version):
            raise ModelBundleError("model name/version is unsupported")
        model_directory = (self.root / model_name).resolve()
        if model_directory.parent != self.root:
            raise ModelBundleError("model directory escaped registry root")
        bundle = (model_directory / model_version).resolve()
        if bundle.parent != model_directory:
            raise ModelBundleError("model version escaped registry root")
        try:
            raw_manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ModelBundleError("model manifest is missing or invalid") from exc
        if not isinstance(raw_manifest, dict):
            raise ModelBundleError("model manifest must be a JSON object")
        if raw_manifest.get("schema_version") != "greenguard-model-bundle-v1":
            raise ModelBundleError("unsupported model manifest schema")
        artifact_name = raw_manifest.get("artifact_file")
        golden_name = raw_manifest.get("golden_file")
        drift_name = raw_manifest.get("drift_reference_file")
        if not isinstance(artifact_name, str) or Path(artifact_name).name != artifact_name:
            raise ModelBundleError("model artifact path must be a plain filename")
        if not isinstance(golden_name, str) or Path(golden_name).name != golden_name:
            raise ModelBundleError("golden input path must be a plain filename")
        if not isinstance(drift_name, str) or Path(drift_name).name != drift_name:
            raise ModelBundleError("drift reference path must be a plain filename")
        artifact, golden_path, drift_path = bundle / artifact_name, bundle / golden_name, bundle / drift_name
        if artifact.is_symlink() or golden_path.is_symlink() or drift_path.is_symlink():
            raise ModelBundleError("model bundles may not contain symlinked artifacts")
        try:
            artifact_bytes = artifact.read_bytes()
            golden_bytes = golden_path.read_bytes()
            drift_bytes = drift_path.read_bytes()
        except OSError as exc:
            raise ModelBundleError("model artifact or golden input is missing/unreadable") from exc
        artifact_digest = hashlib.sha256(artifact_bytes).hexdigest()
        golden_digest = hashlib.sha256(golden_bytes).hexdigest()
        drift_digest = hashlib.sha256(drift_bytes).hexdigest()
        if artifact_digest != raw_manifest.get("artifact_sha256"):
            raise ModelBundleError("model artifact checksum mismatch")
        if golden_digest != raw_manifest.get("golden_input_sha256"):
            raise ModelBundleError("golden input checksum mismatch")
        if drift_digest != raw_manifest.get("drift_reference_sha256"):
            raise ModelBundleError("drift reference checksum mismatch")
        try:
            drift_reference = validate_drift_reference(json.loads(drift_bytes.decode("utf-8")))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ModelBundleError("drift reference is missing or invalid") from exc
        required_strings = ("model_name", "model_version", "architecture", "artifact_sha256",
                            "golden_input_sha256", "feature_set_version", "data_origin",
                            "target", "target_semantics")
        if any(not isinstance(raw_manifest.get(name), str) or not raw_manifest[name]
               for name in required_strings):
            raise ModelBundleError("model manifest is missing required string fields")
        if raw_manifest.get("feature_set_version") != _FEATURE_SET_VERSION:
            raise ModelBundleError("model feature set does not match the scorer contract")
        if raw_manifest.get("synthetic_only") is not True:
            raise ModelBundleError("only explicitly synthetic model bundles are accepted")
        synthetic = True
        if synthetic and not self.allow_synthetic_shadow:
            raise ModelBundleError("synthetic models are loadable only in explicitly enabled shadow mode")
        if raw_manifest.get("production_eligible") is not False:
            # No model has passed the consent, real-label, temporal holdout, parity,
            # and human approval gates required for production in this worktree.
            raise ModelBundleError("no production-eligible model is registered")
        if raw_manifest.get("data_origin") != "synthetic_grain_sim":
            raise ModelBundleError("this registry loader currently accepts synthetic-only prototypes")
        if raw_manifest.get("model_name") != model_name or raw_manifest.get("model_version") != model_version:
            raise ModelBundleError("bundle identity does not match requested immutable version")
        if model_version != derive_model_version(artifact_digest, drift_reference):
            raise ModelBundleError("model version does not bind the artifact and drift reference")
        if raw_manifest.get("architecture") != _ARCHITECTURE:
            raise ModelBundleError("unsupported model architecture")
        try:
            state = torch.load(io.BytesIO(artifact_bytes), map_location="cpu", weights_only=True)
            model = TransformerClassifier()
            model.load_state_dict(state, strict=True)
            model.eval()
            golden = json.loads(golden_bytes.decode("utf-8"))
            values = np.asarray(golden["input"], dtype=np.float32)
            expected = float(golden["probability"])
        except (OSError, ValueError, TypeError, KeyError, RuntimeError, json.JSONDecodeError) as exc:
            raise ModelBundleError("model state or golden-vector file is invalid") from exc
        if not math.isfinite(expected) or not 0.0 <= expected <= 1.0:
            raise ModelBundleError("golden probability must be finite and between zero and one")
        manifest = ModelManifest(
            model_name=model_name, model_version=model_version, architecture=_ARCHITECTURE,
            artifact_sha256=raw_manifest["artifact_sha256"],
            feature_set_version=raw_manifest["feature_set_version"],
            data_origin=raw_manifest["data_origin"], synthetic_only=synthetic,
            production_eligible=False, target=raw_manifest["target"],
            target_semantics=raw_manifest["target_semantics"],
            golden_input_sha256=raw_manifest["golden_input_sha256"], golden_probability=expected,
            drift_reference=drift_reference,
        )
        loaded = LoadedModel(manifest, model)
        actual = float(loaded.predict(values)[0])
        if not math.isfinite(actual) or not 0.0 <= actual <= 1.0 or abs(actual - expected) > 1e-4:
            raise ModelBundleError("model golden-vector output parity failed")
        return loaded
