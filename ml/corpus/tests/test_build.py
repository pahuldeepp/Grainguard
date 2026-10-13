from __future__ import annotations

import json
import hashlib
from datetime import timedelta
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/ml-features/src"))
sys.path.insert(0, str(ROOT))

from ml.corpus import build as corpus_build  # noqa: E402
from ml.corpus.build import CorpusError, build_corpus  # noqa: E402


class CorpusBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fixture = self.root / "fixture"
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools/sensor-fixture/generate.py"),
                "--output",
                str(self.fixture),
                "--scenario",
                "warming",
                "--days",
                "4",
                "--seed",
                "41",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_rebuild_is_content_deterministic_but_pseudonyms_are_secret_scoped(self) -> None:
        try:
            import pyarrow.parquet as pq
        except ImportError:
            self.skipTest("install ml/corpus/requirements.txt to exercise Parquet output")

        first = build_corpus(
            self.fixture / "readings.jsonl",
            self.fixture / "labels.jsonl",
            self.root / "dataset-first",
            hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
        )
        second = build_corpus(
            self.fixture / "readings.jsonl",
            self.fixture / "labels.jsonl",
            self.root / "dataset-second",
            hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
        )

        self.assertEqual(first["dataset_id"], second["dataset_id"])
        self.assertEqual(first["dataset_hash"], second["dataset_hash"])
        self.assertEqual(first["files"], second["files"])
        for relative_path in first["files"]:
            self.assertEqual(
                (self.root / "dataset-first" / relative_path).read_bytes(),
                (self.root / "dataset-second" / relative_path).read_bytes(),
            )

        third = build_corpus(
            self.fixture / "readings.jsonl",
            self.fixture / "labels.jsonl",
            self.root / "dataset-different-secret",
            hmac_secret=b"different-local-test-secret-at-least-32-bytes",
        )
        self.assertNotEqual(first["dataset_id"], third["dataset_id"])
        self.assertNotEqual(first["dataset_hash"], third["dataset_hash"])
        first_tenant = pq.read_table(self.root / "dataset-first" / "training_rows.parquet")["tenant_pk"][0].as_py()
        third_tenant = pq.read_table(
            self.root / "dataset-different-secret" / "training_rows.parquet"
        )["tenant_pk"][0].as_py()
        self.assertNotEqual(first_tenant, third_tenant)

    def test_builds_bounded_pseudonymized_parquet_rows_and_manifest(self) -> None:
        try:
            import pyarrow.parquet as pq
        except ImportError:
            self.skipTest("install ml/corpus/requirements.txt to exercise Parquet output")
        secret = b"local-test-secret-which-is-at-least-32-bytes"
        output = self.root / "dataset"
        manifest = build_corpus(
            self.fixture / "readings.jsonl",
            self.fixture / "labels.jsonl",
            output,
            sample_minutes=60,
            hmac_secret=secret,
        )
        table = pq.read_table(output / "training_rows.parquet")
        rows = table.to_pylist()
        sequence_paths = [
            output / path
            for path in manifest["files"]
            if path.startswith("sequence_windows/")
        ]
        label_paths = [
            output / path for path in manifest["files"] if path.startswith("labels/")
        ]
        sequence_rows = [
            row for path in sequence_paths for row in pq.read_table(path).to_pylist()
        ]
        label_rows = [row for path in label_paths for row in pq.read_table(path).to_pylist()]
        self.assertEqual(len(rows), manifest["rows"])
        self.assertGreater(len(rows), 0)
        self.assertLessEqual(len(rows), 25_000)
        self.assertEqual(manifest["synthetic_only"], True)
        self.assertEqual(manifest["data_origin"], "synthetic")
        self.assertEqual(manifest["label_not_spoilage"], True)
        self.assertEqual(manifest["split"], "unsplit_synthetic_fixture")
        self.assertEqual(manifest["label_spec_version"], 1)
        fixture_manifest = json.loads((self.fixture / "manifest.json").read_text())
        self.assertEqual(manifest["fixture_days"], fixture_manifest["emitted_days"])
        self.assertEqual(len(manifest["fixture_manifest_sha256"]), 64)
        self.assertEqual(len(manifest["fixture_generator_sha256"]), 64)
        self.assertEqual(len(manifest["corpus_builder_sha256"]), 64)
        self.assertEqual(len(manifest["feature_kernel_sha256"]), 64)
        self.assertIn("not joined to label timestamps", manifest["row_grain"])
        self.assertEqual(manifest["view"], "as_seen")
        self.assertEqual(manifest["distinct_device_pseudonyms"], 16)
        self.assertEqual(len(sequence_rows), manifest["sequence_windows"])
        self.assertEqual(len(label_rows), manifest["labels"])
        self.assertGreater(len(sequence_rows), 0)
        self.assertEqual(
            len(label_rows),
            json.loads((self.fixture / "manifest.json").read_text())["label_count"],
        )
        self.assertTrue(all(path.parts[-3].startswith("tenant=") for path in sequence_paths + label_paths))
        self.assertTrue(all(path.parts[-2].startswith("month=") for path in sequence_paths + label_paths))
        self.assertTrue(all("label_value" not in row and "label_name" not in row for row in rows))
        self.assertTrue(all(row["tenant_pk"] == rows[0]["tenant_pk"] for row in sequence_rows))
        self.assertTrue(all(row["tenant_pk"] == rows[0]["tenant_pk"] for row in label_rows))
        for sequence in sequence_rows:
            self.assertEqual(sequence["context_steps"], 96)
            self.assertEqual(sequence["cadence_minutes"], 15)
            self.assertTrue(all(len(sequence[field]) == 96 for field in (
                "observed_at", "received_at", "temperature_c",
                "relative_humidity_percent", "missing_mask", "backfilled",
            )))
            self.assertEqual(sequence["observed_at"][0], sequence["window_start"])
            self.assertEqual(sequence["observed_at"][-1], sequence["window_end"])
            self.assertEqual(sequence["window_end"] - sequence["window_start"], timedelta(minutes=95 * 15))
            self.assertEqual(sequence["prediction_as_of"] - sequence["window_end"], timedelta(minutes=15))
            self.assertTrue(all(
                received is None or received <= sequence["prediction_as_of"]
                for received in sequence["received_at"]
            ))
            self.assertTrue(all(not missing for missing in sequence["missing_mask"]))
            self.assertTrue(all(not value for value in sequence["backfilled"]))
        self.assertTrue(all(row["label_not_spoilage"] for row in label_rows))
        self.assertNotIn(secret.decode(), (output / "manifest.json").read_text())
        fixture_manifest = json.loads((self.fixture / "manifest.json").read_text())
        raw_ids = set()
        for line in (self.fixture / "readings.jsonl").read_text().splitlines():
            reading = json.loads(line)
            raw_ids.add(reading["tenant_id"])
            raw_ids.add(reading["payload"]["site_id"])
            raw_ids.add(reading["payload"]["bin_id"])
            raw_ids.add(reading["payload"]["device_id"])
        exported_ids = {str(value) for row in rows for name, value in row.items() if name.endswith("_pk")}
        self.assertTrue(raw_ids.isdisjoint(exported_ids))
        serialized = (output / "manifest.json").read_text()
        self.assertTrue(all(raw_id not in serialized for raw_id in raw_ids))
        self.assertEqual(manifest["input_sha256"]["readings.jsonl"], fixture_manifest["reading_sha256"])
        artifact_text = (output / "manifest.json").read_text()
        for path in sequence_paths + label_paths:
            exported = pq.read_table(path).to_pylist()
            artifact_text += repr(exported)
        artifact_text += repr(rows)
        self.assertNotIn(secret.decode(), artifact_text)
        self.assertTrue(all(raw_id not in artifact_text for raw_id in raw_ids))
        final_window_end = max(row["window_end"] for row in sequence_rows)
        self.assertEqual(final_window_end, max(row["as_of"] for row in label_rows))

    def test_failed_export_does_not_leave_partial_output(self) -> None:
        try:
            import pyarrow  # noqa: F401
        except ImportError:
            self.skipTest("install ml/corpus/requirements.txt to exercise Parquet output")
        output = self.root / "atomic-dataset"
        with mock.patch.object(
            corpus_build,
            "_write_partitioned_export",
            side_effect=RuntimeError("injected export failure"),
        ):
            with self.assertRaisesRegex(RuntimeError, "injected export failure"):
                build_corpus(
                    self.fixture / "readings.jsonl",
                    self.fixture / "labels.jsonl",
                    output,
                    hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
                )
        self.assertFalse(output.exists())
        self.assertEqual(list(self.root.glob(".atomic-dataset.tmp-*")), [])

    def test_sequence_export_marks_missing_native_cadence_sample(self) -> None:
        try:
            import pyarrow.parquet as pq
        except ImportError:
            self.skipTest("install ml/corpus/requirements.txt to exercise Parquet output")
        readings_path = self.fixture / "readings.jsonl"
        baseline = build_corpus(
            readings_path,
            self.fixture / "labels.jsonl",
            self.root / "dataset-without-gap",
            hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
        )
        readings = [json.loads(line) for line in readings_path.read_text().splitlines()]
        target_device = readings[0]["payload"]["device_id"]
        target = next(
            row for row in readings
            if row["payload"]["device_id"] == target_device
            and row["payload"]["observed_at"] == "2025-01-02T06:00:00Z"
        )
        readings.remove(target)
        readings_path.write_text(
            "".join(
                json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n"
                for row in readings
            ),
            encoding="utf-8",
        )
        manifest_path = self.fixture / "manifest.json"
        fixture_manifest = json.loads(manifest_path.read_text())
        fixture_manifest["reading_sha256"] = hashlib.sha256(readings_path.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(fixture_manifest), encoding="utf-8")

        output = self.root / "dataset-with-gap"
        manifest = build_corpus(
            readings_path,
            self.fixture / "labels.jsonl",
            output,
            hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
        )
        sequence_paths = [
            output / path for path in manifest["files"]
            if path.startswith("sequence_windows/")
        ]
        windows = [row for path in sequence_paths for row in pq.read_table(path).to_pylist()]
        self.assertEqual(manifest["sequence_windows"], baseline["sequence_windows"])
        windows_with_gap = [
            row for row in windows if any(row["missing_mask"])
        ]
        self.assertTrue(windows_with_gap)
        window = windows_with_gap[0]
        missing_index = window["missing_mask"].index(True)
        self.assertIsNone(window["observed_at"][missing_index])
        self.assertIsNone(window["received_at"][missing_index])
        self.assertIsNone(window["temperature_c"][missing_index])
        self.assertIsNone(window["relative_humidity_percent"][missing_index])

    def test_sequence_export_rejects_off_cadence_reading(self) -> None:
        readings_path = self.fixture / "readings.jsonl"
        readings = [json.loads(line) for line in readings_path.read_text().splitlines()]
        readings[0]["payload"]["observed_at"] = "2025-01-01T00:01:00Z"
        readings_path.write_text(
            "".join(
                json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n"
                for row in readings
            ),
            encoding="utf-8",
        )
        manifest_path = self.fixture / "manifest.json"
        fixture_manifest = json.loads(manifest_path.read_text())
        fixture_manifest["reading_sha256"] = hashlib.sha256(readings_path.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(fixture_manifest), encoding="utf-8")
        with self.assertRaisesRegex(CorpusError, "off the 15-minute cadence"):
            build_corpus(
                readings_path,
                self.fixture / "labels.jsonl",
                self.root / "dataset-off-cadence",
                hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
            )

    def test_requires_at_least_32_byte_secret(self) -> None:
        with self.assertRaisesRegex(CorpusError, "at least 32"):
            build_corpus(
                self.fixture / "readings.jsonl",
                self.fixture / "labels.jsonl",
                self.root / "dataset",
                hmac_secret=b"too-short",
            )

    def test_rejects_changed_input_against_fixture_manifest(self) -> None:
        with (self.fixture / "labels.jsonl").open("a", encoding="utf-8") as stream:
            stream.write("{}\n")
        with self.assertRaisesRegex(CorpusError, "checksum"):
            build_corpus(
                self.fixture / "readings.jsonl",
                self.fixture / "labels.jsonl",
                self.root / "dataset",
                hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
            )

    def test_rejects_nonempty_output_directory(self) -> None:
        output = self.root / "existing-output"
        output.mkdir()
        (output / "stale.parquet").write_bytes(b"stale")
        with self.assertRaisesRegex(CorpusError, "absent or empty"):
            build_corpus(
                self.fixture / "readings.jsonl",
                self.fixture / "labels.jsonl",
                output,
                hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
            )

    def test_rejects_missing_fixture_manifest_metadata(self) -> None:
        manifest_path = self.fixture / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest.pop("scenario")
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(CorpusError, "supported scenario"):
            build_corpus(
                self.fixture / "readings.jsonl",
                self.fixture / "labels.jsonl",
                self.root / "dataset-invalid-manifest",
                hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
            )

    def test_rejects_invalid_label_identity_fields(self) -> None:
        labels = self.fixture / "labels.jsonl"
        original = [json.loads(line) for line in labels.read_text().splitlines()]
        manifest_path = self.fixture / "manifest.json"
        secret = b"local-test-secret-which-is-at-least-32-bytes"
        for field, value in (("tenant_id", None), ("site_id", 42), ("bin_id", "  ")):
            with self.subTest(field=field):
                rows = [dict(row) for row in original]
                rows[0][field] = value
                labels.write_text(
                    "".join(json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n" for row in rows),
                    encoding="utf-8",
                )
                manifest = json.loads(manifest_path.read_text())
                manifest["label_sha256"] = hashlib.sha256(labels.read_bytes()).hexdigest()
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                with self.assertRaisesRegex(CorpusError, "non-empty string tenant_id, site_id, and bin_id"):
                    build_corpus(
                        self.fixture / "readings.jsonl",
                        labels,
                        self.root / f"dataset-invalid-{field}",
                        hmac_secret=secret,
                    )

    def test_rejects_missing_event_id_as_corpus_error(self) -> None:
        readings = self.fixture / "readings.jsonl"
        rows = [json.loads(line) for line in readings.read_text().splitlines()]
        rows[0].pop("event_id")
        content = "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows)
        readings.write_text(content, encoding="utf-8")
        manifest_path = self.fixture / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["reading_sha256"] = hashlib.sha256(readings.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(CorpusError, "non-empty event_id"):
            build_corpus(
                readings,
                self.fixture / "labels.jsonl",
                self.root / "dataset",
                hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
            )

    def test_rejects_duplicate_event_id_before_it_can_inflate_features(self) -> None:
        readings = self.fixture / "readings.jsonl"
        rows = [json.loads(line) for line in readings.read_text().splitlines()]
        rows[1]["event_id"] = rows[0]["event_id"]
        readings.write_text(
            "".join(json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n" for row in rows),
            encoding="utf-8",
        )
        manifest_path = self.fixture / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["reading_sha256"] = hashlib.sha256(readings.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(CorpusError, "duplicate event_id"):
            build_corpus(
                readings,
                self.fixture / "labels.jsonl",
                self.root / "dataset-duplicate-event",
                hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
            )

    def test_rejects_label_for_entity_absent_from_readings(self) -> None:
        labels = self.fixture / "labels.jsonl"
        rows = [json.loads(line) for line in labels.read_text().splitlines()]
        rows[0]["bin_id"] = "unseen-bin"
        labels.write_text(
            "".join(json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n" for row in rows),
            encoding="utf-8",
        )
        manifest_path = self.fixture / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["label_sha256"] = hashlib.sha256(labels.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(CorpusError, "label identity does not match"):
            build_corpus(
                self.fixture / "readings.jsonl",
                labels,
                self.root / "dataset-unseen-label-entity",
                hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
            )

    def test_rejects_boolean_measurement_as_corpus_error(self) -> None:
        readings = self.fixture / "readings.jsonl"
        rows = [json.loads(line) for line in readings.read_text().splitlines()]
        rows[0]["payload"]["measurements"]["temperature_c"] = True
        readings.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        manifest_path = self.fixture / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["reading_sha256"] = hashlib.sha256(readings.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(CorpusError, "must be a number or null"):
            build_corpus(
                readings,
                self.fixture / "labels.jsonl",
                self.root / "dataset",
                hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
            )

    def test_15_minute_sampling_remains_within_safety_bound(self) -> None:
        # The 4-day, 16-device fixture at 15-minute sampling yields 6,144 rows,
        # still within this prototype's hard bound. This asserts the requested
        # cadence is accepted without expanding to an unbounded series.
        try:
            import pyarrow  # noqa: F401
        except ImportError:
            self.skipTest("install ml/corpus/requirements.txt to exercise Parquet output")
        manifest = build_corpus(
            self.fixture / "readings.jsonl",
            self.fixture / "labels.jsonl",
            self.root / "dataset-15m",
            sample_minutes=15,
            hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
        )
        self.assertLessEqual(manifest["rows"], 25_000)
        self.assertEqual(manifest["sample_minutes"], 15)

    def test_missing_pyarrow_fails_with_pinned_install_instruction(self) -> None:
        with mock.patch.object(corpus_build, "_dependency", side_effect=RuntimeError("Parquet output requires the exactly pinned dependency; install with `python3 -m pip install -r ml/corpus/requirements.txt`")):
            with self.assertRaisesRegex(RuntimeError, "ml/corpus/requirements.txt"):
                build_corpus(
                    self.fixture / "readings.jsonl",
                    self.fixture / "labels.jsonl",
                    self.root / "dataset-no-pyarrow",
                    hmac_secret=b"local-test-secret-which-is-at-least-32-bytes",
                )


if __name__ == "__main__":
    unittest.main()
