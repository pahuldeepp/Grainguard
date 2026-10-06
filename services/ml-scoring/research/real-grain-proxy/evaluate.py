#!/usr/bin/env python3
"""Small, descriptive jar-level evaluation on USDA experimental grain data."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
DATA_DIR = ROOT / ".local" / "research-data" / "usda-grain-proxy-2025"
FILES = {
    "abiotic.csv": (
        "https://ndownloader.figshare.com/files/51877016",
        "f76a0a14c893b29580bca1c0577fb07560770d1e3a5e26c2bddb3aeab7e541ce",
    ),
    "progeny.csv": (
        "https://ndownloader.figshare.com/files/51877139",
        "cd4628dee730daac4d77c666ceed05643cdcfc3338341ed211e9b93ec8c0965f",
    ),
}


def fetch(name: str, url: str, expected_sha256: str) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / name
    if not path.exists():
        request = urllib.request.Request(url, headers={"User-Agent": "GreenGuard-research/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            path.write_bytes(response.read())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if expected_sha256 and digest != expected_sha256:
        raise ValueError(f"{name}: source checksum mismatch: {digest}")
    return path


def load_rows() -> list[dict[str, float | int]]:
    abiotic_path = fetch(*("abiotic.csv", *FILES["abiotic.csv"]))
    progeny_path = fetch(*("progeny.csv", *FILES["progeny.csv"]))

    outcomes: dict[tuple[str, str], int] = {}
    with progeny_path.open(newline="", encoding="utf-8-sig") as source:
        for row in csv.DictReader(source):
            treatment = row["Treatment"].strip().upper()
            rep = row["Rep"].strip()
            outcomes[(treatment, rep)] = int(row["Progeny"])

    # Weighted summary stats by treatment, jar, and early/mid observation
    # period. `treatment` is used only as a join key; it is never a feature.
    summaries: dict[tuple[str, str, str], list[tuple[float, float, float, float, int]]] = {}
    with abiotic_path.open(newline="", encoding="utf-8-sig") as source:
        for row in csv.DictReader(source):
            period = row["period"].strip().lower()
            if period not in {"early", "mid"}:
                continue
            key = (row["treatment"].strip().upper(), row["rep"].strip(), period)
            count = int(row["n"])
            summaries.setdefault(key, []).append(
                (float(row["temp"]), float(row["tempsd"]), float(row["rh"]), float(row["rhsd"]), count)
            )

    def period_means(key: tuple[str, str, str]) -> tuple[float, float]:
        rows = summaries[key]
        weight = sum(row[4] for row in rows)
        return (
            sum(row[0] * row[4] for row in rows) / weight,
            sum(row[2] * row[4] for row in rows) / weight,
        )

    result = []
    for (treatment, rep), progeny in outcomes.items():
        early_key, mid_key = (treatment, rep, "early"), (treatment, rep, "mid")
        if early_key not in summaries or mid_key not in summaries:
            continue
        early_temp, early_rh = period_means(early_key)
        mid_temp, mid_rh = period_means(mid_key)
        result.append({
            "x": [early_temp, early_rh, mid_temp, mid_rh, mid_temp - early_temp, mid_rh - early_rh],
            "y": int(progeny > 0),
        })
    if len(result) != 20:
        raise ValueError(f"expected 20 matched jars, found {len(result)}")
    return result


def fit_logistic(train_x: np.ndarray, train_y: np.ndarray, test_x: np.ndarray) -> float:
    mean = train_x.mean(axis=0)
    scale = train_x.std(axis=0)
    scale[scale < 1e-9] = 1.0
    x = np.column_stack((np.ones(len(train_x)), (train_x - mean) / scale))
    query = np.r_[1.0, (test_x - mean) / scale]
    weights = np.zeros(x.shape[1], dtype=np.float64)
    penalty = np.diag([0.0] + [1.0] * (x.shape[1] - 1))
    for _ in range(3000):
        scores = np.clip(x @ weights, -30, 30)
        probs = 1.0 / (1.0 + np.exp(-scores))
        gradient = (x.T @ (probs - train_y)) / len(train_y) + penalty @ weights / len(train_y)
        weights -= 0.08 * gradient
    return float(1.0 / (1.0 + math.exp(-float(np.clip(query @ weights, -30, 30)))))


def main() -> None:
    rows = load_rows()
    x = np.asarray([row["x"] for row in rows], dtype=np.float64)
    y = np.asarray([row["y"] for row in rows], dtype=np.float64)
    predictions = []
    baselines = []
    for index in range(len(rows)):
        keep = np.arange(len(rows)) != index
        predictions.append(fit_logistic(x[keep], y[keep], x[index]))
        baselines.append(float(y[keep].mean()))
    prediction_array = np.asarray(predictions)
    baseline_array = np.asarray(baselines)
    labels = y.astype(bool)
    result = {
        "dataset": "USDA ARS experimental wheat microclimate / S. oryzae progeny",
        "rows": len(rows),
        "positive_progeny_jars": int(y.sum()),
        "negative_progeny_jars": int(len(y) - y.sum()),
        "evaluation": "leave-one-jar-out; early+mid temperature/RH only; logistic regression",
        "features": ["early_temp_mean", "early_rh_mean", "mid_temp_mean", "mid_rh_mean", "temp_delta", "rh_delta"],
        "target": "day-60 progeny count > 0 (insect reproduction proxy; not spoilage)",
        "brier_score": round(float(np.mean((prediction_array - y) ** 2)), 4),
        "prevalence_baseline_brier": round(float(np.mean((baseline_array - y) ** 2)), 4),
        "accuracy_at_0_5": round(float(np.mean((prediction_array >= 0.5) == labels)), 4),
        "predictions": [round(float(value), 4) for value in prediction_array],
        "label_order": [int(value) for value in y],
        "claim_limit": "small controlled experiment; descriptive proxy check only, not commercial spoilage validation",
    }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
