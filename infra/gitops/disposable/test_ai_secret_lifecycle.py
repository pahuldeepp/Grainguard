"""Offline contract and fail-closed ownership tests for the AI Secret helper."""
import base64
import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("ai-secret-lifecycle.py")
SPEC = importlib.util.spec_from_file_location("ai_secret_lifecycle", SCRIPT)
lifecycle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lifecycle)


def fingerprint_environment(payloads):
    fingerprints = {name: {key: __import__("hashlib").sha256(value.encode("ascii")).hexdigest()
                           for key, value in payload.items()} for name, payload in payloads.items()}
    result = {"GG_AI_EXPECTED_FINGERPRINTS": json.dumps(fingerprints)}
    result["GG_AI_REDIS_TLS"] = json.dumps({key: payloads["greenguard-ai-redis"][key] for key in ("server.crt", "server.key", "ca.pem") if key in payloads["greenguard-ai-redis"]})
    return result


def scope():
    value = {
        "account_id": "123456789012", "region": "us-west-2", "environment": "disposable",
        "cell": "gg-cell", "cluster": "gg-cell", "namespace": "greenguard",
    }
    digest = __import__("hashlib").sha256(value["cluster"].encode()).hexdigest()[:16]
    value["sources"] = {
        name: (f"greenguard/disposable/cell-{digest}/ai/database-roles"
               if name == "greenguard-ai-database-roles"
               else f"greenguard/disposable/cell-{digest}/ai/runtime/{name}")
        for name in lifecycle.EXPECTED_KEYS
    }
    return value


def bundle():
    return {name: {key: base64.b64encode((name + ":" + key).encode()).decode()
                   for key in keys}
            for name, keys in lifecycle.EXPECTED_KEYS.items()}


def secret_record(name, current=None):
    scope_value = scope()
    return {
        "Name": scope_value["sources"][name],
        "ARN": f"arn:aws:secretsmanager:us-west-2:123456789012:secret:{scope_value['sources'][name]}-abc123",
        "Tags": [{"Key": key, "Value": value} for key, value in {
            "Environment": "disposable", "Cell": "gg-cell",
            "CellId": __import__("hashlib").sha256(b"gg-cell").hexdigest()[:16],
            "Lifecycle": "Disposable", "ManagedBy": "Terraform", "SecretOwner": "greenguard-ai-runtime",
        }.items()],
        "VersionIdsToStages": current or {},
    }


class AISecretLifecycleTests(unittest.TestCase):
    def test_large_values_do_not_enter_exec_environment(self):
        payloads = bundle()
        name = next(name for name in payloads if name != "greenguard-ai-redis")
        key = next(iter(payloads[name]))
        payloads[name][key] = base64.b64encode(b"large-budget-sentinel" * 10000).decode()
        env = fingerprint_environment(payloads)
        self.assertLess(len(json.dumps(env)), 32000)
        self.assertNotIn(payloads[name][key], json.dumps(env))
        with patch.dict(os.environ, env):
            lifecycle.expected_payload_bundle()
            lifecycle.expected_redis_tls(lifecycle.expected_payload_bundle())

    def test_malformed_fingerprint_and_mismatched_tls_are_rejected(self):
        env = fingerprint_environment(bundle())
        hashes = json.loads(env["GG_AI_EXPECTED_FINGERPRINTS"])
        hashes["greenguard-ai-redis"]["password"] = "not-a-sha256"
        with patch.dict(os.environ, {**env, "GG_AI_EXPECTED_FINGERPRINTS": json.dumps(hashes)}):
            with self.assertRaisesRegex(ValueError, "SHA256"):
                lifecycle.expected_payload_bundle()
        tls = json.loads(env["GG_AI_REDIS_TLS"])
        tls["server.key"] = base64.b64encode(b"wrong-key").decode()
        with patch.dict(os.environ, {**env, "GG_AI_REDIS_TLS": json.dumps(tls)}):
            with self.assertRaisesRegex(ValueError, "differs"):
                lifecycle.expected_redis_tls(lifecycle.expected_payload_bundle())

    def test_scope_requires_exact_cell_scoped_secret_sources(self):
        with patch.dict(os.environ, {"GG_AI_SCOPE": json.dumps(scope())}):
            parsed = lifecycle.scope_from_environment()
        self.assertEqual("greenguard", parsed["namespace"])
        changed = scope()
        changed["sources"]["greenguard-ai-redis"] = "greenguard/disposable/other/ai/runtime/greenguard-ai-redis"
        with patch.dict(os.environ, {"GG_AI_SCOPE": json.dumps(changed)}):
            with self.assertRaisesRegex(ValueError, "outside the exact cell"):
                lifecycle.scope_from_environment()

    def test_expected_payload_requires_every_secret_key_and_nonempty_canonical_base64(self):
        payloads = bundle()
        with patch.dict(os.environ, fingerprint_environment(payloads)):
            self.assertEqual(set(lifecycle.EXPECTED_KEYS), set(lifecycle.expected_payload_bundle()))
        del payloads["greenguard-ai-redis"]["server.key"]
        with patch.dict(os.environ, fingerprint_environment(payloads)):
            with self.assertRaisesRegex(ValueError, "keys differ"):
                lifecycle.expected_payload_bundle()

    def test_guard_allows_complete_first_apply_only_when_every_secret_is_unversioned(self):
        payloads = bundle()
        records = {name: secret_record(name) for name in lifecycle.EXPECTED_KEYS}

        def describe(_scope):
            return records

        def current(_scope, name, _version=None):
            return None

        with patch.dict(os.environ, fingerprint_environment(payloads)), \
                patch.object(lifecycle, "aws_scope", return_value={"cluster": "ok"}), \
                patch.object(lifecycle, "aws_secret_metadata", side_effect=describe), \
                patch.object(lifecycle, "current_secret_data", side_effect=current), \
                patch.object(lifecycle, "validate_redis_tls") as validate_tls:
            lifecycle.guard(scope())
        validate_tls.assert_called_once_with({key: payloads["greenguard-ai-redis"][key] for key in ("server.crt", "server.key", "ca.pem")})

    def test_guard_rejects_partial_or_changed_persisted_secret_bundle(self):
        payloads = bundle()
        records = {name: secret_record(name, {"v1": ["AWSCURRENT"]}) for name in lifecycle.EXPECTED_KEYS}
        current = {name: payload for name, payload in payloads.items()}
        changed = dict(current["greenguard-ai-redis"])
        changed["password"] = base64.b64encode(b"different-password").decode()
        current["greenguard-ai-redis"] = changed

        def get_secret(_scope, name, _version=None):
            return current.get(name)

        with patch.dict(os.environ, fingerprint_environment(payloads)), \
                patch.object(lifecycle, "aws_scope", return_value={"cluster": "ok"}), \
                patch.object(lifecycle, "aws_secret_metadata", return_value=records), \
                patch.object(lifecycle, "current_secret_data", side_effect=get_secret), \
                patch.object(lifecycle, "validate_redis_tls"):
            with self.assertRaisesRegex(RuntimeError, "differs from current exact-cell"):
                lifecycle.guard(scope())

        current.pop("greenguard-ai-redis")
        with patch.dict(os.environ, fingerprint_environment(payloads)), \
                patch.object(lifecycle, "aws_scope", return_value={"cluster": "ok"}), \
                patch.object(lifecycle, "aws_secret_metadata", return_value=records), \
                patch.object(lifecycle, "current_secret_data", side_effect=get_secret), \
                patch.object(lifecycle, "validate_redis_tls"):
            with self.assertRaisesRegex(RuntimeError, "only partially materialized"):
                lifecycle.guard(scope())

    def test_redis_tls_validation_checks_certificate_purpose_sans_and_key_match(self):
        payload = {key: base64.b64encode(b"sentinel").decode()
                   for key in lifecycle.EXPECTED_KEYS["greenguard-ai-redis"]}
        outputs = [
            b"Certificate is valid", b"X509v3 Extended Key Usage:\n TLS Web Server Authentication",
            b"X509v3 Subject Alternative Name:\n DNS:ai-redis.greenguard.svc.cluster.local, DNS:ai-redis.greenguard.svc, DNS:ai-redis",
            b"public-key", b"public-key",
        ]
        with patch.object(lifecycle, "_openssl", side_effect=outputs):
            lifecycle.validate_redis_tls(payload)
        outputs[1] = b"X509v3 Extended Key Usage:\n TLS Web Client Authentication"
        with patch.object(lifecycle, "_openssl", side_effect=outputs):
            with self.assertRaisesRegex(RuntimeError, "serverAuth"):
                lifecycle.validate_redis_tls(payload)

    def test_secret_update_and_delete_refuse_foreign_scope(self):
        scope_value = scope()
        record = {"source": scope_value["sources"]["greenguard-ai-redis"], "version": "v1",
                  "data": bundle()["greenguard-ai-redis"]}
        foreign = {"type": "Opaque", "metadata": {"labels": {"app.kubernetes.io/managed-by": "other"}}}
        with self.assertRaisesRegex(RuntimeError, "foreign"):
            lifecycle.desired_secret("greenguard-ai-redis", scope_value, record, foreign)


if __name__ == "__main__":
    unittest.main()
