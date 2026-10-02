"""Regression checks for the exact Python source layout copied into the scorer image."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
DOCKERFILE = ROOT / "services/ml-scoring/deploy/Dockerfile"
DOCKERIGNORE = ROOT / "services/ml-scoring/deploy/Dockerfile.dockerignore"
LOCKFILE = ROOT / "services/ml-scoring/deploy/requirements.lock"
CONTRACT_MODULE = "ml/deep_learning/comparison_contract.py"


class ScorerImageSourceLayoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dockerfile = DOCKERFILE.read_text()
        self.dockerignore = DOCKERIGNORE.read_text().splitlines()

    def test_comparison_contract_is_copied_and_allowlisted(self):
        self.assertIn(
            f"COPY --chown=10001:10001 {CONTRACT_MODULE} "
            "/app/ml/deep_learning/comparison_contract.py",
            self.dockerfile,
        )
        self.assertIn(f"!{CONTRACT_MODULE}", self.dockerignore)

    def test_image_lock_uses_hashed_cpu_torch_and_dedicated_index(self):
        lock = LOCKFILE.read_text()
        self.assertIn("--universal --generate-hashes --torch-backend cpu", lock.splitlines()[1])
        self.assertIn(
            "torch==2.14.0+cpu ; sys_platform != 'darwin' \\",
            lock,
        )
        cpu_torch_entry = lock.split(
            "torch==2.14.0+cpu ; sys_platform != 'darwin' \\", 1,
        )[1].split("    # via", 1)[0]
        for wheel_hash in (
            "27b34640fea7268862961b734c723873e15b1c2657b1eb84bcfac053e5841527",
            "f152f41dc5dc462afe0de780e451ebb47ea8b4451f8f919f9537aa8e2cbe1d7e",
        ):
            self.assertIn(wheel_hash, cpu_torch_entry)
        self.assertNotIn("cuda-toolkit==", lock)
        self.assertIn("--require-hashes", self.dockerfile)
        self.assertIn("--index-url https://download.pytorch.org/whl/cpu", self.dockerfile)
        self.assertIn("--extra-index-url https://pypi.org/simple", self.dockerfile)

    def test_staged_image_source_layout_imports_scorer_entrypoint(self):
        """Stage only Dockerfile COPY inputs, then import as the image does."""
        required_copies = {
            ROOT / "services/ml-scoring/ml_scoring": Path("ml_scoring"),
            ROOT / "ml/deep_learning/sequence_models.py": Path("ml/deep_learning/sequence_models.py"),
            ROOT / CONTRACT_MODULE: Path(CONTRACT_MODULE),
        }
        for source, destination in required_copies.items():
            self.assertIn(source.relative_to(ROOT).as_posix(), self.dockerfile)
            self.assertTrue(source.exists(), f"Dockerfile source is missing: {source}")

        with tempfile.TemporaryDirectory(prefix="ml-scoring-image-layout-") as temporary:
            image_root = Path(temporary)
            for source, destination in required_copies.items():
                target = image_root / destination
                target.parent.mkdir(parents=True, exist_ok=True)
                if source.is_dir():
                    shutil.copytree(source, target, dirs_exist_ok=True)
                else:
                    shutil.copy2(source, target)

            environment = os.environ.copy()
            environment["PYTHONPATH"] = str(image_root)
            result = subprocess.run(
                [sys.executable, "-c", "import ml_scoring.main"],
                cwd=image_root,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
