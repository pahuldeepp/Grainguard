import base64
import importlib.util
import json
import os
import stat
import time
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("oidc-membership-token-lifecycle.py")
SPEC = importlib.util.spec_from_file_location("oidc_membership_token_lifecycle", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def jwt(claims=None, header=None):
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    return ".".join((encode(header or {"alg": "RS256"}), encode(claims or {"exp": int(time.time()) + 600}), "signature"))


class TokenLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.scope = {"account_id": "123456789012", "region": "us-east-2", "environment": "dev", "cluster": "gg-dev", "revision": "a" * 40}

    def test_accepts_live_rs256_jwt_shape_and_rejects_expired_or_wrong_algorithm(self):
        token, exp = module.parse_token(jwt())
        self.assertTrue(token.endswith(".signature"))
        self.assertGreater(exp, int(time.time()))
        with self.assertRaises(ValueError):
            module.parse_token(jwt({"exp": int(time.time()) - 1}))
        with self.assertRaises(ValueError):
            module.parse_token(jwt(header={"alg": "none"}))

    def test_secret_creation_keeps_token_out_of_command_arguments(self):
        token = jwt()
        captured = []
        with patch.object(module, "existing_secret", return_value=None), patch.object(module, "run", side_effect=lambda args, input_text=None: captured.append((args, input_text)) or ""):
            module.provision(self.scope, token, int(time.time()) + 600)
        self.assertEqual(len(captured), 1)
        args, body = captured[0]
        self.assertNotIn(token, " ".join(args))
        self.assertEqual(args, ["kubectl", "create", "-f", "-", "-o", "name"])
        secret = json.loads(body)
        self.assertEqual(secret["metadata"]["labels"]["greenguard.io/cell"], self.scope["cluster"])
        self.assertEqual(secret["metadata"]["annotations"]["greenguard.io/revision"], self.scope["revision"])
        self.assertEqual(secret["stringData"]["access-token"], token)

    def test_cleanup_refuses_until_exact_membership_job_succeeds(self):
        secret = {"type": "Opaque", "metadata": {
            "uid": "secret-uid", "resourceVersion": "42",
            "labels": {"app.kubernetes.io/managed-by": module.OWNER, "greenguard.io/cell": self.scope["cluster"]},
            "annotations": {"greenguard.io/revision": self.scope["revision"], "greenguard.io/token-exp": str(int(time.time()) + 600)},
        }}
        with patch.object(module, "existing_secret", return_value=secret), patch.object(module, "require_successful_probe", side_effect=RuntimeError("not ready")), patch.object(module, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                module.delete_secret(self.scope, require_probe_success=True)
            run.assert_not_called()
        with patch.object(module, "existing_secret", return_value=secret), patch.object(module, "require_successful_probe") as check, patch.object(module, "run", return_value="") as run:
            module.delete_secret(self.scope, require_probe_success=True)
            check.assert_called_once_with(self.scope)
            body = json.loads(run.call_args.kwargs["input_text"])
            self.assertEqual(body["preconditions"], {"uid": "secret-uid", "resourceVersion": "42"})

    def test_temp_kubeconfig_is_private_and_restored(self):
        original = os.environ.get("KUBECONFIG")
        try:
            os.environ["KUBECONFIG"] = "/tmp/user-kubeconfig"
            with patch.object(module, "run", return_value="apiVersion: v1\n") as run:
                with module.temporary_kubeconfig(self.scope):
                    path = Path(os.environ["KUBECONFIG"])
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertFalse(path.exists())
                self.assertEqual(os.environ["KUBECONFIG"], "/tmp/user-kubeconfig")
                self.assertEqual(run.call_args.args[0][-1], "--dry-run")
        finally:
            if original is None:
                os.environ.pop("KUBECONFIG", None)
            else:
                os.environ["KUBECONFIG"] = original


if __name__ == "__main__":
    unittest.main()
