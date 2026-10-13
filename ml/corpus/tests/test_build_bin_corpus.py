from __future__ import annotations

from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest
from unittest import mock

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools" / "grain-sim"))
from simulate import simulate  # noqa: E402
from ml.corpus.build_bin_corpus import CorpusError, build_bin_corpus  # noqa: E402


class BinCorpusTests(unittest.TestCase):
    def test_builds_exactly_joined_bin_time_features_and_separate_labels(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, out1, out2 = root / "sim", root / "out1", root / "out2"
            simulate(source, scenario="wet-pocket", days=5, seed=47)
            secret = b"synthetic-test-key-that-is-at-least-32-bytes"
            first = build_bin_corpus(source, out1, secret)
            second = build_bin_corpus(source, out2, secret)
            self.assertEqual(first["dataset_id"], second["dataset_id"])
            self.assertEqual(first["rows"], 5 * 96 - 96)
            self.assertTrue(first["synthetic_only"])
            self.assertTrue(first["label_not_spoilage"])
            self.assertEqual("unsplit_synthetic_run", first["split"])
            features = pq.read_table(out1 / "bin_features.parquet").to_pylist()
            labels = pq.read_table(out1 / "labels.parquet").to_pylist()
            windows = pq.read_table(out1 / "sequence_windows.parquet").to_pylist()
            ambient = pq.read_table(out1 / "ambient_context.parquet").to_pylist()
            mounts = pq.read_table(out1 / "mount_context.parquet").to_pylist()
            lot = json.loads((out1 / "lot_context.json").read_text())
            self.assertEqual(len(features), len(labels))
            self.assertEqual(
                [(row["run_pk"], row["as_of"]) for row in features],
                [(row["run_pk"], row["as_of"]) for row in labels],
            )
            self.assertEqual(1, len({row["tenant_pk"] for row in features}))
            self.assertEqual(1, len({row["bin_pk"] for row in features}))
            self.assertEqual(1, len({row["run_pk"] for row in features}))
            self.assertTrue(all(row["sensor_count"] == 16 for row in features))
            self.assertEqual(5 * 96, len(ambient))
            self.assertEqual(16, len(mounts))
            self.assertTrue(lot["synthetic_only"])
            self.assertEqual("simulator_assumption_not_observed", lot["crop_basis"])
            self.assertEqual(48 * 16, len(windows))
            self.assertTrue(all(row["sequence_length"] == 96 and row["synthetic_only"] for row in windows))
            self.assertTrue(all(len(row["temperature_c"]) == len(row["step_timestamps"]) == 96 for row in windows))
            self.assertTrue(all(row["step_timestamps"][-1] < row["as_of"] for row in windows))
            self.assertTrue(all(not row["missing_mask"][-1] for row in windows))
            self.assertIn("temperature_c_deep_minus_shallow", features[0])
            self.assertNotIn("label", features[0])
            self.assertTrue(all(row["label_not_spoilage"] for row in labels))
            output_names = (
                "bin_features.parquet", "labels.parquet", "sequence_windows.parquet",
                "mount_context.parquet", "ambient_context.parquet", "lot_context.json",
            )
            output_manifest = json.loads((out1 / "manifest.json").read_text())
            self.assertEqual(set(output_names), set(output_manifest["files"]))
            for name in output_names:
                first_bytes = (out1 / name).read_bytes()
                self.assertEqual(first_bytes, (out2 / name).read_bytes())
                self.assertEqual(hashlib.sha256(first_bytes).hexdigest(), output_manifest["files"][name]["sha256"])

    def test_rejects_tampered_simulator_checksum(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sim"
            simulate(source, scenario="baseline", days=5, seed=2)
            with (source / "readings.jsonl").open("ab") as stream:
                stream.write(b"{}\n")
            with self.assertRaises(CorpusError):
                build_bin_corpus(source, root / "out", b"synthetic-test-key-that-is-at-least-32-bytes")

    def test_failed_parquet_export_does_not_publish_partial_corpus(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = root / "sim", root / "out"
            simulate(source, scenario="baseline", days=5, seed=3)
            original_write_table = pq.write_table
            writes = 0

            def fail_after_first_artifact(*args, **kwargs):
                nonlocal writes
                writes += 1
                if writes == 2:
                    raise OSError("injected Parquet write failure")
                return original_write_table(*args, **kwargs)

            with mock.patch("pyarrow.parquet.write_table", side_effect=fail_after_first_artifact):
                with self.assertRaisesRegex(OSError, "injected Parquet write failure"):
                    build_bin_corpus(source, output, b"synthetic-test-key-that-is-at-least-32-bytes")

            self.assertFalse(output.exists())
            self.assertEqual([], list(root.glob(".out.staging-*")))


if __name__ == "__main__":
    unittest.main()
