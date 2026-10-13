"""Offline safety tests for the synthetic ML secret lifecycle helper."""
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("ml-secret-lifecycle.py")
SPEC = importlib.util.spec_from_file_location("ml_secret_lifecycle", SCRIPT)
lifecycle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lifecycle)


def fingerprint_environment(payloads):
    fingerprints = {name: {key: __import__("hashlib").sha256(value.encode("ascii")).hexdigest()
                           for key, value in payload.items()} for name, payload in payloads.items()}
    result = {"GG_ML_SYNTHETIC_EXPECTED_FINGERPRINTS": json.dumps(fingerprints)}
    return result


def scoped_bundle():
    scope = {
        "account_id": "123456789012", "region": "us-west-2", "environment": "dev",
        "cell": "gg-cell", "cluster": "gg-cell", "namespace": "ml-synthetic",
    }
    cell_hash = __import__("hashlib").sha256(scope["cluster"].encode()).hexdigest()[:16]
    scope["sources"] = {name: f"greenguard/dev/cell-{cell_hash}/ml-synthetic/{name}"
                        for name in lifecycle.EXPECTED_NAMES}
    scope["versions"] = {name: "version-" + str(index)
                         for index, name in enumerate(lifecycle.EXPECTED_NAMES)}
    return scope


def owned_secret(name, scope):
    return {
        "type": "Opaque", "metadata": {
            "name": name, "namespace": "ml-synthetic", "uid": f"uid-{name}",
            "resourceVersion": "37", "labels": {
                "app.kubernetes.io/managed-by": lifecycle.OWNER,
                "greenguard.io/cell": scope["cell"],
            }, "annotations": {
                lifecycle.SCOPE_ANNOTATION: lifecycle.scope_identity(scope),
                "greenguard.io/aws-secret-name": scope["sources"][name],
                "greenguard.io/aws-version-id": scope["versions"][name],
            },
        }, "data": {"opaque": "c2VudGluaWVs"},
    }


class MLSyntheticSecretLifecycleTests(unittest.TestCase):
    def test_large_bundle_is_reduced_to_bounded_fingerprints(self):
        payloads = {name: {key: "YWJj" * 12000 for key in keys}
                    for name, keys in lifecycle.EXPECTED_NAMES.items()}
        self.assertGreater(len(json.dumps(payloads)), 128000)
        env = fingerprint_environment(payloads)
        self.assertLess(len(json.dumps(env)), 32000)
        self.assertNotIn("YWJj" * 12000, json.dumps(env))
        with patch.dict(lifecycle.os.environ, env):
            lifecycle.expected_payloads_from_environment()

    def test_malformed_fingerprints_are_rejected(self):
        payloads = {name: {key: "c2VjcmV0" for key in keys}
                    for name, keys in lifecycle.EXPECTED_NAMES.items()}
        env = fingerprint_environment(payloads)
        hashes = json.loads(env["GG_ML_SYNTHETIC_EXPECTED_FINGERPRINTS"])
        hashes["ml-scoring-runtime"]["operations-token"] = "bad"
        env["GG_ML_SYNTHETIC_EXPECTED_FINGERPRINTS"] = json.dumps(hashes)
        with patch.dict(lifecycle.os.environ, env):
            with self.assertRaisesRegex(ValueError, "SHA256"):
                lifecycle.expected_payloads_from_environment()

    def test_ephemeral_guard_accepts_exact_current_secret_versions_without_logging_values(self):
        scope = scoped_bundle()
        payloads = {name: {key: "c2VjcmV0" for key in keys}
                    for name, keys in lifecycle.EXPECTED_NAMES.items()}
        responses = {
            name: {"Name": scope["sources"][name], "VersionId": scope["versions"][name],
                   "SecretString": json.dumps(payloads[name])}
            for name in lifecycle.EXPECTED_NAMES
        }
        calls = []

        def fake_run_json(*argv):
            calls.append(argv)
            name = argv[argv.index("--secret-id") + 1].rsplit("/", 1)[-1]
            return responses[name]

        env = fingerprint_environment(payloads)
        with patch.object(lifecycle, "aws_secret_scope", return_value={"cluster": "ok"}), \
                patch.object(lifecycle, "run_json", side_effect=fake_run_json), \
                patch.dict(lifecycle.os.environ, env):
            with patch("builtins.print") as output:
                lifecycle.guard_ephemeral_bundle(scope)
        self.assertEqual(6, len([argv for argv in calls if "secretsmanager" in argv]))
        for argv in calls:
            if "secretsmanager" in argv:
                secret_name = argv[argv.index("--secret-id") + 1].rsplit("/", 1)[-1]
                self.assertEqual(scope["versions"][secret_name], argv[argv.index("--version-id") + 1])
        self.assertNotIn("c2VjcmV0", " ".join(str(arg) for arg in output.call_args.args))

    def test_ephemeral_guard_rejects_changed_bundle_without_disclosing_values(self):
        scope = scoped_bundle()
        wanted = {name: {key: "c2VjcmV0" for key in keys}
                  for name, keys in lifecycle.EXPECTED_NAMES.items()}
        changed = json.loads(json.dumps(wanted))
        changed["ml-scoring-runtime"]["operations-token"] = "bmV3LXNlY3JldA=="

        def fake_run_json(*argv):
            name = argv[argv.index("--secret-id") + 1].rsplit("/", 1)[-1]
            return {"Name": scope["sources"][name], "VersionId": scope["versions"][name],
                    "SecretString": json.dumps(wanted[name])}

        with patch.object(lifecycle, "aws_secret_scope", return_value={"cluster": "ok"}), \
                patch.object(lifecycle, "run_json", side_effect=fake_run_json), \
                patch.dict(lifecycle.os.environ, fingerprint_environment(changed)):
            with self.assertRaisesRegex(RuntimeError, "differs from the exact cell") as raised:
                lifecycle.guard_ephemeral_bundle(scope)
        self.assertNotIn("bmV3LXNlY3JldA==", str(raised.exception))
        self.assertNotIn("c2VjcmV0", str(raised.exception))

    def test_namespace_inventory_preserves_managed_fields_for_ownership_check(self):
        with patch.object(lifecycle, "run_json", return_value={"items": []}) as run_json:
            self.assertEqual({"items": []}, lifecycle.namespace_inventory())
        self.assertEqual("--show-managed-fields=true", run_json.call_args.args[-1])

    def test_secret_source_names_are_unique_to_exact_cell(self):
        scope = scoped_bundle()
        with patch.dict(lifecycle.os.environ, {"GG_ML_SYNTHETIC_SCOPE": json.dumps(scope)}):
            self.assertEqual(scope, lifecycle.scope_from_environment())
            scope["sources"][next(iter(scope["sources"]))] = "greenguard/dev/ml-synthetic/foreign"
            with patch.dict(lifecycle.os.environ, {"GG_ML_SYNTHETIC_SCOPE": json.dumps(scope)}):
                with self.assertRaisesRegex(ValueError, "exact environment path"):
                    lifecycle.scope_from_environment()

    def test_secret_delete_prevalidates_entire_inventory_and_uses_uid_resource_version(self):
        scope = scoped_bundle()
        records = {name: owned_secret(name, scope) for name in lifecycle.EXPECTED_NAMES}
        calls = []
        def fake_run(argv, *, payload=None, text=True):
            calls.append((argv, json.loads(payload)))
            return ""
        with patch.object(lifecycle, "current_secret", side_effect=lambda name: records[name]), \
                patch.object(lifecycle, "run", side_effect=fake_run):
            lifecycle.delete_owned_secrets(scope, {})
        self.assertEqual(len(lifecycle.EXPECTED_NAMES), len(calls))
        for argv, options in calls:
            name = argv[3].rsplit("/", 1)[1]
            self.assertEqual(["kubectl", "delete", "--raw", f"/api/v1/namespaces/ml-synthetic/secrets/{name}", "-f", "-"], argv)
            self.assertEqual({"uid": f"uid-{name}", "resourceVersion": "37"}, options["preconditions"])

        calls.clear()
        foreign_name = sorted(records)[-1]
        records[foreign_name]["metadata"]["labels"]["app.kubernetes.io/managed-by"] = "foreign"
        with patch.object(lifecycle, "current_secret", side_effect=lambda name: records[name]), \
                patch.object(lifecycle, "run", side_effect=fake_run):
            with self.assertRaisesRegex(RuntimeError, "foreign or rotated"):
                lifecycle.delete_owned_secrets(scope, {})
        self.assertEqual([], calls, "must validate all Secret ownership before deleting any")

    def test_only_exact_controller_owned_namespace_defaults_are_ignored(self):
        manager = [{"manager": "kube-controller-manager"}]
        ca = "exact cluster certificate"
        config_map = {"kind": "ConfigMap", "data": {"ca.crt": ca}, "metadata": {
            "name": "kube-root-ca.crt", "managedFields": manager,
        }}
        self.assertTrue(lifecycle.allowed_namespace_bootstrap(config_map, ca))
        wrong_ca = json.loads(json.dumps(config_map))
        wrong_ca["data"]["ca.crt"] = "foreign certificate"
        self.assertFalse(lifecycle.allowed_namespace_bootstrap(wrong_ca, ca))
        user_managed = json.loads(json.dumps(config_map))
        user_managed["metadata"]["managedFields"] = [{"manager": "kubectl-client-side-apply"}]
        self.assertFalse(lifecycle.allowed_namespace_bootstrap(user_managed, ca))
        service_account = {"kind": "ServiceAccount", "automountServiceAccountToken": None,
                           "metadata": {"name": "default", "managedFields": manager}}
        self.assertTrue(lifecycle.allowed_namespace_bootstrap(service_account, ca))
        service_account["imagePullSecrets"] = [{"name": "user-owned"}]
        self.assertFalse(lifecycle.allowed_namespace_bootstrap(service_account, ca))


if __name__ == "__main__":
    unittest.main()
