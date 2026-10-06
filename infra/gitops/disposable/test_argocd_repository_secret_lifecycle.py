import importlib.util
import os
import stat
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("argocd-repository-secret-lifecycle.py")
SPEC = importlib.util.spec_from_file_location("argocd_repository_secret_lifecycle", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class TemporaryKubeconfigTests(unittest.TestCase):
    def test_kubeconfig_is_exact_temporary_mode_0600_and_environment_is_restored(self):
        previous = os.environ.get("KUBECONFIG")
        scope = {"region": "us-east-2", "cluster": "gg-disposable"}
        expected_config = "apiVersion: v1\nclusters: []\n"
        captured_path = None
        try:
            os.environ["KUBECONFIG"] = "/tmp/preexisting-greenguard-kubeconfig"
            with patch.object(module, "run", return_value=expected_config) as run:
                with module.temporary_kubeconfig(scope):
                    captured_path = Path(os.environ["KUBECONFIG"])
                    self.assertTrue(captured_path.is_file())
                    self.assertEqual(captured_path.read_text(), expected_config)
                    self.assertEqual(stat.S_IMODE(captured_path.stat().st_mode), 0o600)
                    run.assert_called_once_with([
                        "aws", "eks", "update-kubeconfig", "--region", "us-east-2",
                        "--name", "gg-disposable", "--kubeconfig", str(captured_path), "--dry-run",
                    ])
                self.assertFalse(captured_path.exists())
                self.assertEqual(os.environ["KUBECONFIG"], "/tmp/preexisting-greenguard-kubeconfig")
        finally:
            if previous is None:
                os.environ.pop("KUBECONFIG", None)
            else:
                os.environ["KUBECONFIG"] = previous


if __name__ == "__main__":
    unittest.main()
