#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("prepare-ai-runtime-bundle.py")
SPEC = importlib.util.spec_from_file_location("prepare_ai_runtime_bundle", MODULE_PATH)
prepare_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare_module)


class PrepareAiRuntimeBundleTest(unittest.TestCase):
    def test_private_cell_bound_reuse_and_explicit_tenant_removal(self):
        tenant_a = "11111111-1111-4111-8111-111111111111"
        tenant_b = "22222222-2222-4222-8222-222222222222"
        user_a = "33333333-3333-4333-8333-333333333333"
        user_b = "44444444-4444-4444-8444-444444444444"
        identity = dict(environment="disposable", cluster="gg-local-ai", region="us-east-1", account="123456789012")

        def caps(tenants):
            return {"platform": {"limit_micros": 10_000_000, "limit_tokens": 1_000_000},
                    "tenants": [{"tenant_id": tenant, "limit": {"limit_micros": 1_000_000, "limit_tokens": 100_000},
                                 "users": [{"principal_id": user_a if tenant == tenant_a else user_b,
                                            "limit": {"limit_micros": 100_000, "limit_tokens": 10_000}}]}
                                for tenant in tenants]}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "ephemeral.auto.tfvars.json"
            prepare_module.prepare(**identity, tenant_ids=[tenant_a], retention_scopes=[(tenant_a, user_a)],
                                   budget_caps=caps([tenant_a]), output=output)
            first = json.loads(output.read_text())
            signer = first["ai_delegated_signing_material"]
            token_a = first["ai_gateway_tenant_tokens"][tenant_a]
            role_passwords = first["ai_database_role_passwords"]
            self.assertEqual(set(role_passwords), set(prepare_module.DATABASE_PASSWORD_KEYS))
            self.assertEqual(len(set(role_passwords.values())), 12)
            self.assertGreaterEqual(min(map(len, role_passwords.values())), 32)
            self.assertEqual(first["ai_model_gateway_budget_caps"], caps([tenant_a]))
            self.assertTrue(signer["BFF_DELEGATED_PRIVATE_KEY_PEM"].startswith("-----BEGIN PRIVATE KEY-----"))
            self.assertRegex(signer["BFF_DELEGATED_KID"], r"^bff-delegated-[a-f0-9]{20}$")
            self.assertGreaterEqual(len(token_a), 32)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            scope_path = output.with_name(output.name + ".scope.json")
            self.assertEqual(stat.S_IMODE(scope_path.stat().st_mode), 0o600)

            prepare_module.prepare(**identity, tenant_ids=[tenant_a, tenant_b],
                                   budget_caps=caps([tenant_a, tenant_b]), output=output)
            second = json.loads(output.read_text())
            self.assertEqual(second["ai_delegated_signing_material"], signer)
            self.assertEqual(second["ai_database_role_passwords"], role_passwords)
            self.assertEqual(set(t["tenant_id"] for t in second["ai_model_gateway_budget_caps"]["tenants"]), {tenant_a, tenant_b})
            self.assertEqual(second["ai_gateway_tenant_tokens"][tenant_a], token_a)
            self.assertIn(tenant_b, second["ai_gateway_tenant_tokens"])
            self.assertIn({"tenant_id": tenant_a, "user_id": user_a}, second["ai_conversation_retention_scopes"])

            with self.assertRaisesRegex(ValueError, "different disposable cell"):
                prepare_module.prepare(**{**identity, "cluster": "other-cell"}, tenant_ids=[tenant_a], output=output)

            prepare_module.prepare(**identity, tenant_ids=[tenant_a], remove_tenant_ids=[tenant_b],
                                   budget_caps=caps([tenant_a]), output=output)
            self.assertEqual(set(json.loads(output.read_text())["ai_gateway_tenant_tokens"]), {tenant_a})

    def test_requires_explicit_canonical_tenant_membership(self):
        identity = dict(environment="disposable", cluster="gg-local-ai", region="us-east-1", account="123456789012")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "owner-approved tenant UUID"):
                prepare_module.prepare(**identity, tenant_ids=[], output=Path(directory) / "inputs.json")
            with self.assertRaisesRegex(ValueError, "canonical UUIDs"):
                prepare_module.prepare(**identity, tenant_ids=["not-a-uuid"], output=Path(directory) / "inputs.json")

    def test_budget_caps_require_private_input_and_exact_explicit_tenant_set(self):
        tenant = "11111111-1111-4111-8111-111111111111"
        cap = {"platform": {"limit_micros": 1000, "limit_tokens": 1000},
               "tenants": [{"tenant_id": tenant, "limit": {"limit_micros": 100, "limit_tokens": 100}, "users": []}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "caps.json"
            path.write_text(json.dumps(cap))
            path.chmod(0o600)
            self.assertEqual(prepare_module._load_budget_caps(path, {tenant}), cap)
            with self.assertRaisesRegex(ValueError, "exactly match"):
                prepare_module._load_budget_caps(path, set())
            path.chmod(0o640)
            with self.assertRaisesRegex(ValueError, "owner-only"):
                prepare_module._load_budget_caps(path, {tenant})


if __name__ == "__main__":
    unittest.main()
