"""Docker-independent check of Python modules staged in the scorer image."""

import ast
from pathlib import Path
import shutil
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
DEEP_LEARNING = ROOT / "ml/deep_learning"
SOURCES = ("__init__.py", "sequence_models.py", "comparison_contract.py")


class ImageLayoutTests(unittest.TestCase):
    def test_sequence_model_internal_imports_exist_in_staged_image_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            staged = Path(temporary) / "ml/deep_learning"
            staged.mkdir(parents=True)
            for name in SOURCES:
                shutil.copy2(DEEP_LEARNING / name, staged / name)

            tree = ast.parse((staged / "sequence_models.py").read_text())
            internal_imports = {
                node.module
                for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom) and node.module
                and node.module.startswith("ml.deep_learning.")
            }
            self.assertTrue(internal_imports)
            for module in internal_imports:
                module_path = Path(temporary).joinpath(*module.split("."))
                self.assertTrue(
                    (module_path.with_suffix(".py").is_file()
                     or (module_path / "__init__.py").is_file()),
                    f"{module} is missing from staged image layout",
                )

            ignore = (ROOT / "services/ml-scoring/deploy/Dockerfile.dockerignore").read_text()
            self.assertIn("!ml/deep_learning/comparison_contract.py", ignore)


if __name__ == "__main__":
    unittest.main()
