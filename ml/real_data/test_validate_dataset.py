"""Contract tests use temporary fabricated rows; they are not model data."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from ml.real_data.validate_dataset import IntakeError, validate_dataset


def _write_package(root: Path, *, late_reading: bool = False) -> Path:
    start = "2025-01-01T00:00:00Z"
    end = "2025-01-10T00:00:00Z"
    telemetry = []
    outcomes = []
    splits = {"train": [], "validation": [], "test": []}
    for index, split in enumerate(splits):
        site, bin_id, lot_id = f"site-{index}", f"bin-{index}", f"lot-{index}"
        as_of = f"2025-01-02T00:00:00Z"
        telemetry.extend([
            {
                "event_id": f"event-{index}-before", "tenant_id": "tenant-1", "site_id": site,
                "bin_id": bin_id, "lot_id": lot_id, "device_id": f"device-{index}",
                "harvest_year": "2024", "observed_at": "2025-01-01T23:00:00Z",
                "received_at": "2025-01-02T01:00:00Z" if late_reading and index == 0 else "2025-01-01T23:05:00Z",
                "measurements": {"temperature_c": 18.2, "relative_humidity_pct": 65.0},
            },
            {
                "event_id": f"event-{index}-after", "tenant_id": "tenant-1", "site_id": site,
                "bin_id": bin_id, "lot_id": lot_id, "device_id": f"device-{index}",
                "harvest_year": "2024", "observed_at": "2025-01-02T12:00:00Z",
                "received_at": "2025-01-02T12:05:00Z",
                "measurements": {"temperature_c": 18.4, "relative_humidity_pct": 66.0},
            },
        ])
        splits[split].append({"site_id": site, "bin_id": bin_id, "harvest_year": "2024"})
        outcomes.append({
            "outcome_id": f"outcome-{index}", "tenant_id": "tenant-1", "site_id": site,
            "bin_id": bin_id, "lot_id": lot_id, "harvest_year": "2024",
            "label_name": "spoilage_within_horizon", "label_value": index == 0,
            "adjudication_reference": "lab-report-test-only", "as_of": as_of,
            "observed_until": "2025-01-03T00:00:00Z",
            "outcome_at": "2025-01-02T12:00:00Z" if index == 0 else None,
        })

    for name, rows in (("telemetry", telemetry), ("outcomes", outcomes)):
        content = "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows).encode()
        (root / f"{name}.jsonl").write_bytes(content)
    manifest = {
        "contract_version": "real-outcomes-v1", "data_origin": "owner_authorized_real",
        "synthetic_only": False, "dataset_id": "temporary-contract-test",
        "source_system": "test-fixture", "collection_owner": "test-owner",
        "authorization_reference": "test-only; no real data", "outcome_definition": "test label",
        "outcome_adjudication_source": "test-only", "units_and_calibration_reference": "test-only",
        "direct_identifiers_removed": True, "retention_days": 30,
        "observation_window": {"start_utc": start, "end_utc": end},
        "outcome_horizon_hours": 24,
        "files": {name: {"path": f"{name}.jsonl", "sha256": hashlib.sha256((root / f"{name}.jsonl").read_bytes()).hexdigest()}
                  for name in ("telemetry", "outcomes")},
        "splits": splits,
    }
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


class RealDataIntakeContractTests(unittest.TestCase):
    def test_accepts_contract_fixture_but_labels_result_as_non_scientific(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = validate_dataset(_write_package(Path(directory)))
        self.assertEqual(result["status"], "contract_valid")
        self.assertEqual(result["telemetry_rows"], 6)
        self.assertIn("not scientific/model validation", result["disclaimer"])

    def test_rejects_rows_that_arrive_after_prediction_cutoff(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(IntakeError, "no telemetry available by as_of"):
                validate_dataset(_write_package(Path(directory), late_reading=True))


if __name__ == "__main__":
    unittest.main()
