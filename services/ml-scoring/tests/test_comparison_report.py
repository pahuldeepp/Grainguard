from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ml_scoring.comparison_report import resolve_i4_comparison_report


class ComparisonReportResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.evidence = self.root / "evidence" / "intelligence"
        self.evidence.mkdir(parents=True)
        (self.evidence / "i4-transformer-comparison.json").write_text("{}")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_default_report_is_selected(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                resolve_i4_comparison_report(self.root),
                (self.evidence / "i4-transformer-comparison.json").resolve(),
            )

    def test_valid_alternate_report_is_resolved_from_repository_root(self) -> None:
        alternate = self.evidence / "cohort" / "comparison.json"
        alternate.parent.mkdir()
        alternate.write_text("{}")
        with patch.dict(os.environ, {"ML_I4_COMPARISON_REPORT": "evidence/intelligence/cohort/comparison.json"}, clear=True):
            self.assertEqual(resolve_i4_comparison_report(self.root), alternate.resolve())

    def test_nonexistent_report_is_rejected(self) -> None:
        with patch.dict(os.environ, {"ML_I4_COMPARISON_REPORT": "evidence/intelligence/missing.json"}, clear=True):
            with self.assertRaisesRegex(ValueError, "does not exist"):
                resolve_i4_comparison_report(self.root)

    def test_traversal_and_out_of_directory_reports_are_rejected(self) -> None:
        outside = self.root / "evidence" / "elsewhere.json"
        outside.write_text("{}")
        for selected in ("../elsewhere.json", str(outside)):
            with self.subTest(selected=selected), patch.dict(
                os.environ, {"ML_I4_COMPARISON_REPORT": selected}, clear=True
            ):
                with self.assertRaisesRegex(ValueError, "must be inside"):
                    resolve_i4_comparison_report(self.root)

    def test_symlink_escape_is_rejected(self) -> None:
        outside = self.root / "outside.json"
        outside.write_text("{}")
        link = self.evidence / "escaped.json"
        link.symlink_to(outside)
        with patch.dict(os.environ, {"ML_I4_COMPARISON_REPORT": "evidence/intelligence/escaped.json"}, clear=True):
            with self.assertRaisesRegex(ValueError, "must be inside"):
                resolve_i4_comparison_report(self.root)

    def test_evidence_directory_or_ancestor_symlink_escape_is_rejected(self) -> None:
        for symlink_name in ("evidence", "intelligence"):
            with self.subTest(symlink_name=symlink_name), tempfile.TemporaryDirectory() as outside_tmp:
                outside = Path(outside_tmp)
                (outside / "report.json").write_text("{}")
                if symlink_name == "evidence":
                    (self.root / "evidence").rename(self.root / "evidence-original")
                    (self.root / "evidence").symlink_to(outside, target_is_directory=True)
                else:
                    evidence = self.root / "evidence"
                    (evidence / "intelligence").rename(evidence / "intelligence-original")
                    (evidence / "intelligence").symlink_to(outside, target_is_directory=True)
                with patch.dict(
                    os.environ,
                    {"ML_I4_COMPARISON_REPORT": "evidence/intelligence/report.json"},
                    clear=True,
                ):
                    with self.assertRaisesRegex(ValueError, "evidence directory must remain inside"):
                        resolve_i4_comparison_report(self.root)
                if symlink_name == "evidence":
                    (self.root / "evidence").unlink()
                    (self.root / "evidence-original").rename(self.root / "evidence")
                else:
                    (self.root / "evidence" / "intelligence").unlink()
                    (self.root / "evidence" / "intelligence-original").rename(self.root / "evidence" / "intelligence")


if __name__ == "__main__":
    unittest.main()
