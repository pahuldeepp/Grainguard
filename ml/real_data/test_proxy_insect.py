from __future__ import annotations

import csv
import json
from pathlib import Path
import tempfile
import unittest

from ml.real_data.proxy_insect import PROXY_ID, ProxyDataError, _sha, evaluate, load_rows


class ProxyInsectTests(unittest.TestCase):
    def write_csv(self, path: Path, silos: int = 3) -> None:
        with path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerow(["silo_id", "time_index", "temperature_c", "grain_moisture_percent", "insect_count"])
            for silo in range(1, silos + 1):
                for time_index in range(1, 5):
                    writer.writerow([f"silo-{silo}", time_index, 20 + time_index, 11 + silo,
                                     silo * time_index])

    def test_leave_one_silo_out_is_explicitly_non_promotable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "proxy.csv", root / "evaluation.json"
            self.write_csv(source)
            (root / "proxy.csv.source.json").write_text(json.dumps({
                "schema_version": "greenguard-public-proxy-source-v1", "dataset_id": PROXY_ID,
                "license": "CC BY 4.0", "normalized_csv_sha256": _sha(source),
                "source_title": "test fixture", "source_file_sha256": "a" * 64,
                "normalizer_sha256": "b" * 64, "production_eligible": False,
                "promotion_eligible": False,
            }))
            result = evaluate(source, output)
            self.assertEqual(result["silo_count"], 3)
            self.assertEqual(len(result["folds"]), 3)
            self.assertFalse(result["production_eligible"])
            self.assertFalse(result["promotion_eligible"])
            self.assertEqual(result["candidate_decision"], "REJECTED")
            self.assertTrue(result["candidate_gate"]["decision_reasons"])
            self.assertEqual(json.loads(output.read_text())["task"],
                             "next_observed_sampling_occasion_total_stored_wheat_insect_count")

    def test_rejects_fewer_than_three_silos(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "proxy.csv"
            self.write_csv(source, silos=2)
            (Path(directory) / "proxy.csv.source.json").write_text(json.dumps({
                "schema_version": "greenguard-public-proxy-source-v1", "dataset_id": PROXY_ID,
                "license": "CC BY 4.0", "normalized_csv_sha256": _sha(source),
                "source_title": "test fixture", "source_file_sha256": "a" * 64,
                "normalizer_sha256": "b" * 64, "production_eligible": False,
                "promotion_eligible": False,
            }))
            with self.assertRaisesRegex(ProxyDataError, "three independent silos"):
                evaluate(source, Path(directory) / "evaluation.json")

    def test_rejects_nonfinite_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "proxy.csv"
            source.write_text("silo_id,time_index,temperature_c,grain_moisture_percent,insect_count\nsilo-1,1,nan,12,1\n")
            with self.assertRaisesRegex(ProxyDataError, "out of range"):
                load_rows(source)

    def test_rejects_provenance_sidecar_for_different_csv(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "proxy.csv"
            self.write_csv(source)
            (root / "proxy.csv.source.json").write_text(json.dumps({
                "schema_version": "greenguard-public-proxy-source-v1", "dataset_id": PROXY_ID,
                "license": "CC BY 4.0", "normalized_csv_sha256": "0" * 64,
                "source_title": "test fixture", "source_file_sha256": "a" * 64,
                "normalizer_sha256": "b" * 64, "production_eligible": False,
                "promotion_eligible": False,
            }))
            with self.assertRaisesRegex(ProxyDataError, "sidecar is invalid"):
                evaluate(source, root / "evaluation.json")


if __name__ == "__main__":
    unittest.main()
