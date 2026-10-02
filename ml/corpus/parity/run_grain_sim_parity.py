"""Compare simulator features with events normalized by the real Go ingest parser."""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import subprocess
import tempfile
from typing import Any

from ml_features import TelemetryReading, compute_features

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools" / "grain-sim"))
from simulate import simulate  # noqa: E402


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _load(path: Path) -> tuple[list[dict[str, Any]], dict[str, list[TelemetryReading]]]:
    events = [json.loads(line) for line in path.read_text().splitlines()]
    streams: dict[str, list[TelemetryReading]] = defaultdict(list)
    for event in events:
        payload = event["payload"]
        streams[payload["device_id"]].append(TelemetryReading(
            tenant_id=event["tenant_id"], device_id=payload["device_id"], event_id=event["event_id"],
            observed_at=_time(payload["observed_at"]), received_at=_time(payload["received_at"]),
            measurements=payload["measurements"],
        ))
    return events, streams


def _bin_vectors(streams: dict[str, list[TelemetryReading]], as_ofs: list[datetime]) -> dict[str, dict[str, float | int | bool | None]]:
    results = {}
    for as_of in as_ofs:
        vectors = [compute_features(rows, as_of=as_of).values for _, rows in sorted(streams.items())]
        aggregate: dict[str, float | int | bool | None] = {}
        for name in vectors[0]:
            values = [v[name] for v in vectors if isinstance(v[name], (int, float)) and not isinstance(v[name], bool)]
            aggregate[name] = sum(values) / len(values) if values else None
        aggregate["sensor_count"] = sum(
            1 for rows in streams.values()
            if any(row.observed_at <= as_of and row.received_at <= as_of for row in rows)
        )
        results[as_of.isoformat()] = aggregate
    return results


def run(output: Path, *, days: int = 5, seed: int = 17) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="gg-grain-parity-") as temporary:
        root = Path(temporary)
        sim_dir, normalized_path = root / "sim", root / "normalized.jsonl"
        manifest = simulate(sim_dir, scenario="wet-pocket", days=days, seed=seed)
        direct_path = sim_dir / "readings.jsonl"
        env = os.environ.copy()
        env["GG_GRAIN_SIM_INPUT"] = str(direct_path)
        env["GG_GRAIN_SIM_OUTPUT"] = str(normalized_path)
        checked = subprocess.run(
            ["go", "test", "-count=1", "-run", "^TestGrainSimPayloadParity$", "."],
            cwd=ROOT / "services" / "telemetry-ingest", env=env, text=True, capture_output=True, check=False,
        )
        if checked.returncode != 0:
            raise RuntimeError(f"production ingest parser parity failed:\n{checked.stdout}\n{checked.stderr}")
        direct_events, direct_streams = _load(direct_path)
        normalized_events, normalized_streams = _load(normalized_path)
        if len(direct_events) != len(normalized_events):
            raise AssertionError("ingest normalization changed event count")
        normalized_by_id = {event["event_id"]: event for event in normalized_events}
        if len(normalized_by_id) != len(normalized_events):
            raise AssertionError("ingest normalization duplicated an event ID")
        for event in direct_events:
            normalized = normalized_by_id.get(event["event_id"])
            if normalized is None:
                raise AssertionError("ingest normalization changed event IDs")
            received = _time(event["payload"]["received_at"])
            if (_time(normalized["occurred_at"]) != received
                    or _time(normalized["payload"]["received_at"]) != received):
                raise AssertionError("normalized event occurrence and receive times must match ingest time")
        labels = [json.loads(line) for line in (sim_dir / "labels.jsonl").read_text().splitlines()]
        as_ofs = [
            _time(row["as_of"]) for row in labels
            if _time(row["as_of"]) - datetime.fromisoformat(manifest["start"].replace("Z", "+00:00")) >= timedelta(hours=24)
        ]
        direct_features = _bin_vectors(direct_streams, as_ofs)
        normalized_features = _bin_vectors(normalized_streams, as_ofs)
        if direct_features.keys() != normalized_features.keys():
            raise AssertionError("feature timestamps changed through ingest normalization")
        compared = 0
        max_abs_delta = 0.0
        for key, direct in direct_features.items():
            normalized = normalized_features[key]
            if direct.keys() != normalized.keys():
                raise AssertionError(f"feature schema changed at {key}")
            for name, left in direct.items():
                right = normalized[name]
                if left is None or right is None:
                    if left is not right:
                        raise AssertionError(f"null parity mismatch for {name} at {key}")
                elif isinstance(left, (int, float)) and not isinstance(left, bool):
                    delta = abs(float(left) - float(right))
                    max_abs_delta = max(max_abs_delta, delta)
                    if not math.isclose(float(left), float(right), rel_tol=0, abs_tol=1e-12):
                        raise AssertionError(f"feature parity mismatch for {name} at {key}: {left} != {right}")
                elif left != right:
                    raise AssertionError(f"feature parity mismatch for {name} at {key}")
                compared += 1
        output.parent.mkdir(parents=True, exist_ok=True)
        report = {
            "status": "pass", "synthetic_only": True, "live_kafka_or_database_used": False,
            "parity_scope": "simulated device payload -> production Go parser and timestamp/measurement normalizer -> shared Python feature kernel",
            "readings_accepted": len(direct_events), "bin_as_of_rows_compared": len(as_ofs),
            "event_occurred_at_matches_received_at": len(direct_events),
            "feature_values_compared": compared, "max_abs_feature_delta": max_abs_delta,
            "simulator_version": manifest["simulator_version"], "seed": seed, "days": days,
            "source_sha256": {
                "simulator": _sha(ROOT / "tools/grain-sim/simulate.py"),
                "ingest_quality": _sha(ROOT / "services/telemetry-ingest/quality.go"),
                "ingest_normalizer": _sha(ROOT / "services/telemetry-ingest/ingest.go"),
                "feature_kernel": _sha(ROOT / "packages/ml-features/src/ml_features/kernel.py"),
            },
            "limitations": ["does not call HTTP/auth, database transactions, outbox, Kafka, CDC, or projections", "uses deterministic 2-second delivery timestamp in place of server wall clock", "does not establish real-device or agronomic parity"],
            "go_test": checked.stdout.strip(),
        }
        output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--days", type=int, default=5)
    parser.add_argument("--seed", type=int, default=17)
    args = parser.parse_args()
    print(json.dumps(run(args.output, days=args.days, seed=args.seed), indent=2))


if __name__ == "__main__":
    main()
