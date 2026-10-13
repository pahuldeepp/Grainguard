import re
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class DisposableEnvironmentContractTests(unittest.TestCase):
    def test_example_uses_the_required_disposable_environment_label(self):
        example = (ROOT / "terraform.tfvars.example").read_text()
        match = re.search(r'(?m)^\s*environment\s*=\s*"([^"]+)"\s*$', example)
        self.assertIsNotNone(match, "terraform.tfvars.example must set environment")
        self.assertEqual(match.group(1), "disposable")

    def test_force_destroy_resources_are_guarded_by_that_environment_label(self):
        for name in ("telemetry-archive.tf", "ai-knowledge-storage.tf"):
            with self.subTest(file=name):
                source = (ROOT / name).read_text()
                self.assertIn('lower(var.environment) == "disposable"', source)


if __name__ == "__main__":
    unittest.main()
