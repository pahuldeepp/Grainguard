"""Static and mocked-provider checks for Terraform secret state boundaries."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parent


def variable_block(source, name):
    start = source.index(f'variable "{name}"')
    opening = source.index("{", start)
    depth = 1
    for index in range(opening + 1, len(source)):
        depth += source[index] == "{"
        depth -= source[index] == "}"
        if depth == 0:
            return source[opening + 1:index]
    raise AssertionError(f"variable {name} is not closed")


def resource_blocks(source, kind):
    marker = f'resource "{kind}" '
    offset = 0
    while True:
        start = source.find(marker, offset)
        if start < 0:
            return
        opening = source.index("{", start)
        depth = 1
        for index in range(opening + 1, len(source)):
            depth += source[index] == "{"
            depth -= source[index] == "}"
            if depth == 0:
                yield source[start: index + 1]
                offset = index + 1
                break
        else:
            raise AssertionError(f"unclosed resource in {kind}")


class SecretStateBoundaryTests(unittest.TestCase):
    def test_billing_secret_precondition_is_fail_closed_for_provider_contract(self):
        runtime = (ROOT / "runtime-secrets.tf").read_text()
        self.assertIn('each.key != "billing-service-config" || (', runtime)
        self.assertIn('"STRIPE_API_KEY"', runtime)
        self.assertIn('^(sk|rk)_test_[A-Za-z0-9]+$', runtime)
        self.assertIn('"STRIPE_WEBHOOK_SECRETS"', runtime)
        self.assertIn('^whsec_[A-Za-z0-9]+$', runtime)
        self.assertIn('"BILLING_INBOX_ENCRYPTION_KEY"', runtime)
        self.assertIn('^[A-Za-z0-9+/]{43}=$', runtime)
        self.assertIn('BILLING_RETURN_ORIGINS', runtime)
        self.assertIn('https://${aws_cloudfront_distribution.web.domain_name}', runtime)

    def test_heartbeat_secret_is_generated_from_only_scoped_kafka_fields(self):
        runtime = (ROOT / "runtime-secrets.tf").read_text()
        generated = runtime.split('"entitlement-heartbeat-config" = {', 1)[1].split("\n    }", 1)[0]
        self.assertIn('for key in ["KAFKA_BROKERS", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD"]', generated)
        self.assertIn('var.runtime_secret_values["billing-service-config"][key]', generated)
        self.assertIn('each.key != "entitlement-heartbeat-config" || (', runtime)
        self.assertIn('== "billing-service"', runtime)
        self.assertNotIn("STRIPE", generated)

    def test_secret_material_variables_are_ephemeral(self):
        expected = {
            "runtime_secret_values": ROOT / "runtime-secrets.tf",
            "audit_export_signing_material": ROOT / "runtime-secrets.tf",
            "shard_role_passwords": ROOT / "shard-secret-values.tf",
            "shard_registry_passwords": ROOT / "shard-secret-values.tf",
            "tenant_bootstrap_passwords": ROOT / "shard-secret-values.tf",
        }
        for name, path in expected.items():
            block = variable_block(path.read_text(), name)
            self.assertIn("sensitive   = true", block, name)
            self.assertIn("ephemeral   = true", block, name)

    def test_secret_version_payloads_only_use_write_only_argument(self):
        sources = (ROOT / "runtime-secrets.tf").read_text() + (ROOT / "shard-secret-values.tf").read_text()
        blocks = list(resource_blocks(sources, "aws_secretsmanager_secret_version"))
        self.assertEqual(len(blocks), 6)
        for block in blocks:
            self.assertIn("secret_string_wo", block)
            self.assertNotIn("secret_string =", block)
            self.assertIn("secret_string_wo_version", block)

    def test_secret_version_counter_names_are_closed_to_real_secret_instances(self):
        secrets = (ROOT / "secrets.tf").read_text()
        counters = variable_block(secrets, "secret_version_counters")
        self.assertIn("contains(var.secret_names, trimprefix(key, \"runtime/\"))", counters)
        self.assertIn("\"shard-routing/\") ? contains([", counters)
        self.assertIn("\"shard-bootstrap/\") ? contains([\"s1\", \"s2\", \"s3\", \"s4\"]", counters)
        self.assertIn("\"tenant-bootstrap/\") ? contains([\"s1\", \"s2\", \"s3\", \"s4\"]", counters)
        self.assertIn("\"shard-data/\") ? contains(flatten(", counters)
        self.assertIn("\"projector-routing/\") ? contains([", counters)
        self.assertIn("unknown scope/name keys are rejected", counters)

    def test_runtime_name_payload_mismatch_uses_fail_closed_precondition(self):
        runtime = (ROOT / "runtime-secrets.tf").read_text()
        resource = next(resource_blocks(runtime, "aws_secretsmanager_secret_version"))
        payload = variable_block(runtime, "runtime_secret_values")
        self.assertIn("contains(var.secret_names, name)", payload)
        self.assertIn("try(jsonencode(local.runtime_secret_owned_values[each.key]), jsonencode({}))", resource)
        self.assertIn("nonsensitive(toset(keys(var.runtime_secret_values))) == setsubtract(", resource)
        self.assertIn("length(setintersection(", resource)
        self.assertIn("no missing, extra, or generated-secret payload names", resource)

    def test_pinned_aws_provider_marks_secret_string_wo_write_only(self):
        terraform = _terraform_binary()
        if not terraform:
            self.skipTest("Terraform CLI not available")
        schema = subprocess.run(
            [terraform, "providers", "schema", "-json"], cwd=ROOT,
            check=True, capture_output=True, text=True,
        )
        resource = json.loads(schema.stdout)["provider_schemas"]["registry.terraform.io/hashicorp/aws"]["resource_schemas"]["aws_secretsmanager_secret_version"]["block"]["attributes"]
        self.assertTrue(resource["secret_string_wo"]["write_only"])
        self.assertFalse(resource["secret_string"].get("write_only", False))

    def test_master_rotation_reads_metadata_not_secret_payload(self):
        sources = (ROOT / "runtime-secrets.tf").read_text() + (ROOT / "shard-secret-values.tf").read_text()
        self.assertNotIn('data "aws_secretsmanager_secret_version"', sources)
        self.assertEqual(sources.count('data "aws_secretsmanager_secret_versions"'), 2)
        provider_plugins = list((ROOT / ".terraform/providers").glob("registry.terraform.io/hashicorp/aws/6.60.0/*/terraform-provider-aws_v6.60.0*"))
        if not provider_plugins:
            self.skipTest("AWS provider schema is not initialized")
        terraform = _terraform_binary()
        if not terraform:
            self.skipTest("Terraform CLI not available")
        schema = subprocess.run(
            [terraform, "providers", "schema", "-json"], cwd=ROOT,
            check=True, capture_output=True, text=True,
        )
        data_sources = json.loads(schema.stdout)["provider_schemas"]["registry.terraform.io/hashicorp/aws"]["data_source_schemas"]
        versions = data_sources["aws_secretsmanager_secret_versions"]["block"]["attributes"]
        self.assertNotIn("secret_string", versions)
        self.assertIn("versions", versions)

    def test_secret_resource_addresses_are_derived_from_public_names(self):
        runtime = (ROOT / "runtime-secrets.tf").read_text()
        self.assertRegex(runtime, r"runtime_secret_input_names\s*=\s*var\.secret_names")
        version_resource = next(resource_blocks(runtime, "aws_secretsmanager_secret_version"))
        self.assertRegex(version_resource, r"for_each\s*=\s*var\.secret_names")
        self.assertIn('lookup(var.secret_version_counters, "runtime/${each.key}", 1)', version_resource)

    def test_persisted_secret_sync_and_helm_inputs_contain_only_public_metadata(self):
        runtime = (ROOT / "runtime-secrets.tf").read_text()
        gitops = (ROOT / "gitops.tf").read_text()
        scope_start = runtime.index("runtime_secret_sync_scope = {")
        scope_end = runtime.index("\n  }\n}", scope_start)
        scope = runtime[scope_start:scope_end]
        for secret_input in ("runtime_secret_values", "audit_export_signing_material", "shard_role_passwords", "shard_registry_passwords", "tenant_bootstrap_passwords"):
            self.assertNotIn(secret_input, scope)
            self.assertNotIn(secret_input, gitops)
        self.assertIn("version_ids", scope)
        self.assertIn("master_version", scope)
        self.assertIn("triggers_replace = local.runtime_secret_sync_scope", runtime)

    def test_mocked_plan_apply_never_emits_or_persists_sentinel_payload(self):
        terraform = _terraform_binary()
        if not terraform:
            self.skipTest("Terraform CLI not available")
        provider_mirror = ROOT / ".terraform/providers"
        if not provider_mirror.exists():
            self.skipTest("AWS provider cache is not initialized")
        sentinel = "GG_SECRET_STATE_SENTINEL_9a716e5f3d2a"
        fixture = ROOT / "tests/secret-write-only"
        with tempfile.TemporaryDirectory(prefix="gg-secret-state-") as temp:
            workspace = Path(temp)
            shutil.copytree(fixture, workspace, dirs_exist_ok=True)
            init = subprocess.run(
                [terraform, "init", "-backend=false", "-input=false", f"-plugin-dir={provider_mirror}"],
                cwd=workspace, capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(init.returncode, 0, "fixture init failed without printing inputs")
            environment = dict(os.environ)
            environment["TF_VAR_secret_payload"] = json.dumps({"PASSWORD": sentinel})
            result = subprocess.run(
                [terraform, "test", "-no-color"], cwd=workspace, env=environment,
                capture_output=True, text=True, timeout=120,
            )
            combined_output = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, "mocked write-only test failed without printing inputs")
            self.assertNotIn(sentinel, combined_output)
            for path in workspace.rglob("*"):
                if path.is_file():
                    try:
                        self.assertNotIn(sentinel, path.read_text(errors="ignore"), str(path.relative_to(workspace)))
                    except UnicodeDecodeError:
                        self.fail(f"unable to inspect fixture artifact {path.name}")


def _terraform_binary():
    configured = os.environ.get("GG_TERRAFORM_BIN")
    return configured if configured and Path(configured).is_file() else shutil.which("terraform")


if __name__ == "__main__":
    unittest.main()
