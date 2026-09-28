import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
REPO = ROOT.parents[2]


class AuditExportWiringTests(unittest.TestCase):
    def test_contract_and_chart_define_a_private_health_checked_worker(self):
        contract = json.loads((REPO / "infra/gitops/disposable/contract.json").read_text())
        release = next(item for item in contract["releases"] if item["name"] == "audit-export-worker")
        self.assertEqual(release["chart"], "greenguard-service")
        self.assertEqual(release["image"], "tenant-control-plane")
        self.assertEqual(release["secret"], "audit-export-worker-config")
        self.assertEqual(release["health"], "/readyz")
        self.assertIs(release["kafka"], False)

        profile = (REPO / "infra/helm/greenguard-service/values/audit-export-worker.yaml").read_text()
        self.assertIn('args: ["services/tenant-control-plane/dist/audit/worker.js"]', profile)
        self.assertIn("name: audit-export-worker-config", profile)
        self.assertIn("ingressEnabled: false", profile)
        self.assertIn("path: /readyz", profile)
        self.assertIn("port: 3010", profile)

    def test_terraform_uses_separate_pod_roles_and_object_prefix_permissions(self):
        source = (ROOT / "audit-export.tf").read_text()
        self.assertIn('toset(["audit-export-worker", "tenant-control-plane"])', source)
        self.assertIn('"s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"', source)
        self.assertIn('each.key == "audit-export-worker"', source)
        self.assertIn('"s3:GetObject"', source)
        self.assertIn('"${aws_s3_bucket.audit_exports.arn}/tenants/*/audit-exports/*"', source)
        self.assertNotRegex(source, r'"s3:(?:ListBucket|DeleteObject|\*)"')
        self.assertIn('aws:RequestTag/kubernetes-service-account', source)
        self.assertIn('service_account = each.key', source)
        self.assertIn('vpc_endpoint_type = "Gateway"', source)
        self.assertIn('"com.amazonaws.${var.aws_region}.s3"', source)

    def test_worker_secret_and_registry_are_generated_from_least_privilege_roles(self):
        runtime = (ROOT / "runtime-secrets.tf").read_text()
        shard = (ROOT / "shard-secret-values.tf").read_text()
        gitops = (ROOT / "gitops.tf").read_text()
        self.assertIn('"audit-export-worker-config" = {', runtime)
        self.assertIn('CONTROL_AUDIT_DATABASE_URL', runtime)
        self.assertIn('BILLING_AUDIT_DATABASE_URL', runtime)
        self.assertIn('AUDIT_EXPORT_PRIVATE_KEY_PEM', runtime)
        self.assertIn('AUDIT_EXPORT_PUBLIC_KEY_PEM', runtime)
        self.assertIn('AUDIT_EXPORT_LINK_SECRET', runtime)
        self.assertRegex(shard, r'audit-export-worker\s*=\s*\{ role = "inventory_audit_reader"')
        self.assertIn('INVENTORY_AUDIT_SHARD_REGISTRY_FILE', gitops)
        self.assertRegex(
            gitops,
            r'"tenant-control-plane"\s*=\s*\{ service = "audit-export-worker", secret = "audit-export-worker", env = "INVENTORY_SHARD_REGISTRY_FILE" \}',
        )
        self.assertIn('aws_eks_pod_identity_association.audit_export', gitops)

        inventory_reader = REPO / "services/device-service/prisma/migrations/20260928210000_audit_export_reader/migration.sql"
        grants = inventory_reader.read_text()
        self.assertIn("GRANT SELECT ON public.audit_events TO inventory_audit_reader", grants)
        self.assertIn("GRANT EXECUTE ON FUNCTION greenguard_internal.admit_tenant_placement", grants)
        self.assertNotIn(" TO inventory_app", grants)
        main = (REPO / "services/tenant-control-plane/src/main.ts").read_text()
        self.assertIn('service: "audit-export-worker"', main)
        self.assertIn('roles: ["inventory_audit_reader"]', main)

    def test_worker_health_checks_and_blocked_live_gate_are_present(self):
        worker = (REPO / "services/tenant-control-plane/src/audit/worker.ts").read_text()
        owners = (REPO / "services/tenant-control-plane/src/audit/owners.ts").read_text()
        self.assertIn('"/healthz", "/readyz"', worker)
        self.assertIn('await sources.healthcheck()', worker)
        self.assertIn('async healthcheck(): Promise<void>', owners)
        readiness = (ROOT / "readiness.tf").read_text()
        self.assertIn("Audit export is an additional first-cell blocker", readiness)


if __name__ == "__main__":
    unittest.main()
