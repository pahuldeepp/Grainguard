"""Offline Terraform runtime Secret apply/retry/teardown guards."""
import base64
import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("lifecycle", Path(__file__).with_name("runtime-secret-lifecycle.py"))
lifecycle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lifecycle)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.scope = {"account_id": "123456789012", "region": "us-east-2", "environment": "disposable",
                      "cluster": "cell-test", "rds_instance": "cell-test-postgres", "namespace": "greenguard",
                      "versions": {"bff-config": "version-1"}, "master_version": "master-v1", "sources": {"bff-config": "greenguard/disposable/bff-config"}, "shard_bootstraps": {}}
        self.record = {"source": "greenguard/disposable/bff-config", "version": "version-1",
                       "master_version": "", "data": {"TOKEN": "fixture-only-secret"}}
        self.desired = lifecycle.annotate_desired("bff-config", self.scope, self.record, None)
        self.current = {"type": "Opaque", "metadata": {**self.desired["metadata"], "uid": "uid-1", "resourceVersion": "4"},
                        "data": {"TOKEN": base64.b64encode(b"fixture-only-secret").decode()}}

    def test_scope_rejects_production_and_missing_versions(self):
        for change in ({"environment": "production"}, {"versions": {}}, {"account_id": "wrong"}, {"namespace": "default"}):
            with self.subTest(change=change), patch.dict(os.environ, {"GG_RUNTIME_SECRET_SCOPE": json.dumps({**self.scope, **change})}):
                with self.assertRaises(ValueError):
                    lifecycle.scope_from_environment()

    def test_scope_accepts_owned_contract(self):
        with patch.dict(os.environ, {"GG_RUNTIME_SECRET_SCOPE": json.dumps(self.scope)}):
            self.assertEqual(lifecycle.scope_from_environment(), self.scope)

    def test_shard_bootstrap_scope_requires_complete_physical_contract(self):
        scope = {**self.scope, "versions": dict(self.scope["versions"]),
                 "sources": dict(self.scope["sources"]), "shard_bootstraps": {}}
        for number in range(1, 5):
            shard_id = f"s{number}"
            name = f"greenguard-{shard_id}-rds-bootstrap"
            scope["versions"][name] = f"bootstrap-v{number}"
            scope["sources"][name] = f"greenguard/disposable/shards/{shard_id}/bootstrap"
            scope["shard_bootstraps"][name] = {
                "instance": f"cell-test-{shard_id}",
                "host": f"{shard_id}.primary.example",
                "master_arn": f"arn:aws:secretsmanager:us-east-2:123456789012:secret:greenguard/disposable/shards/{shard_id}/master-AbCd12",
                "master_version": f"master-v{number}",
                "incarnation": f"10000000-0000-5000-8000-00000000000{number}",
                "replica_hosts": [f"{shard_id}.replica.example"],
            }
        with patch.dict(os.environ, {"GG_RUNTIME_SECRET_SCOPE": json.dumps(scope)}):
            self.assertEqual(lifecycle.scope_from_environment(), scope)

        invalid = []
        missing_shard = json.loads(json.dumps(scope))
        del missing_shard["shard_bootstraps"]["greenguard-s4-rds-bootstrap"]
        invalid.append(missing_shard)
        foreign_master = json.loads(json.dumps(scope))
        foreign_master["shard_bootstraps"]["greenguard-s1-rds-bootstrap"]["master_arn"] = "arn:aws:secretsmanager:us-east-2:999999999999:secret:foreign"
        invalid.append(foreign_master)
        changed_source = json.loads(json.dumps(scope))
        changed_source["sources"]["greenguard-s2-rds-bootstrap"] = "greenguard/other/shards/s2/bootstrap"
        invalid.append(changed_source)
        duplicate_replica = json.loads(json.dumps(scope))
        duplicate_replica["shard_bootstraps"]["greenguard-s3-rds-bootstrap"]["replica_hosts"] = ["s3.replica.example", "s3.replica.example"]
        invalid.append(duplicate_replica)
        for bad_scope in invalid:
            with self.subTest(scope=bad_scope), patch.dict(os.environ, {"GG_RUNTIME_SECRET_SCOPE": json.dumps(bad_scope)}):
                with self.assertRaises(ValueError):
                    lifecycle.scope_from_environment()

    def test_foreign_scope_cannot_replace(self):
        self.current["metadata"]["annotations"][lifecycle.OWNER_KEY] = "foreign"
        with self.assertRaisesRegex(RuntimeError, "scope ownership"):
            lifecycle.annotate_desired("bff-config", self.scope, self.record, self.current)

    def test_cleanup_uses_uid_and_resource_version_preconditions(self):
        with patch.object(lifecycle.sync, "existing_secret", return_value=self.current), patch.object(lifecycle, "run_checked") as run:
            lifecycle.cleanup(self.scope)
        options = json.loads(run.call_args.args[1])
        self.assertEqual(options["preconditions"], {"uid": "uid-1", "resourceVersion": "4"})
        self.assertNotIn("fixture-only-secret", str(run.call_args))

    def test_cleanup_absent_partial_apply_is_safe(self):
        with patch.object(lifecycle.sync, "existing_secret", return_value=None), patch.object(lifecycle, "run_checked") as run:
            lifecycle.cleanup(self.scope)
        run.assert_not_called()

    def test_cleanup_changed_version_is_never_deleted(self):
        self.current["metadata"]["annotations"]["greenguard.io/aws-version-id"] = "newer"
        with patch.object(lifecycle.sync, "existing_secret", return_value=self.current), patch.object(lifecycle, "run_checked") as run:
            with self.assertRaisesRegex(RuntimeError, "foreign or changed"):
                lifecycle.cleanup(self.scope)
        run.assert_not_called()

    def test_apply_partial_retry_only_writes_missing(self):
        self.scope["versions"]["greenguard-rds-bootstrap"] = "bootstrap-v1"
        bootstrap = {"data": {"PGHOST": "fixture"}, "version": "bootstrap-v1", "master_version": "master-v1", "source": "greenguard/disposable/greenguard-rds-bootstrap"}
        with patch.object(lifecycle.sync.preflight, "expected_secrets", return_value={"bff-config": self.record, "greenguard-rds-bootstrap": bootstrap}), \
             patch.object(lifecycle, "validate_profiles"), patch.object(lifecycle.sync, "existing_secret", side_effect=[None, None]), \
             patch.object(lifecycle, "run_checked"), patch.object(lifecycle.sync, "write_secret") as write, \
             patch.object(lifecycle.sync.preflight, "verify_targets", return_value=0):
            lifecycle.apply(self.scope)
            self.assertEqual(write.call_count, 2)
        with patch.object(lifecycle.sync.preflight, "expected_secrets", return_value={"bff-config": self.record, "greenguard-rds-bootstrap": bootstrap}), \
             patch.object(lifecycle, "validate_profiles"), patch.object(lifecycle.sync, "existing_secret", side_effect=[self.current, None]), \
             patch.object(lifecycle, "run_checked"), patch.object(lifecycle.sync, "write_secret") as write, \
             patch.object(lifecycle.sync.preflight, "verify_targets", return_value=0):
            lifecycle.apply(self.scope)
            write.assert_called_once()

    def test_apply_rejects_aws_version_before_mutation(self):
        self.scope["versions"]["bff-config"] = "different"
        with patch.object(lifecycle.sync.preflight, "expected_secrets", return_value={"bff-config": self.record, "greenguard-rds-bootstrap": {"master_version": "master-v1"}}), \
             patch.object(lifecycle, "validate_profiles"), patch.object(lifecycle.sync, "write_secret") as write:
            with self.assertRaisesRegex(RuntimeError, "runtime contract"):
                lifecycle.apply(self.scope)
        write.assert_not_called()

    def test_guarded_sources_account_and_resource_ownership(self):
        scope = self.scope
        def command(*args):
            if args[1] == "sts":
                return {"Account": scope["account_id"]}
            if args[1] == "eks":
                return {"cluster": {"arn": "arn:aws:eks:us-east-2:123456789012:cluster/cell-test",
                                    "tags": {"Environment": "disposable", "Lifecycle": "Disposable"}}}
            if args[1] == "rds":
                return {"DBInstances": [{"DBInstanceArn": "arn:aws:rds:us-east-2:123456789012:db:cell-test-postgres",
                       "MasterUserSecret": {"SecretArn": "arn:aws:secretsmanager:us-east-2:123456789012:secret:master-123"},
                       "TagList": [{"Key": k, "Value": v} for k, v in {"Environment": "disposable", "Lifecycle": "Disposable", "ManagedBy": "Terraform"}.items()]}]}
            return {"Name": self.record["source"], "ARN": "arn:aws:secretsmanager:us-east-2:123456789012:secret:" + self.record["source"] + "-123456",
                    "VersionIdsToStages": {"version-1": ["AWSCURRENT"]}, "Tags": [{"Key": k, "Value": v} for k, v in
                    {"Environment": "disposable", "Cell": "cell-test", "Lifecycle": "Disposable", "ManagedBy": "Terraform", "RuntimeSecretOwner": lifecycle.sync.OWNER}.items()]}
        with patch.object(lifecycle.sync.preflight, "command", side_effect=command):
            lifecycle.guarded_sources(scope)
        with patch.object(lifecycle.sync.preflight, "command", return_value={"Account": "999999999999"}):
            with self.assertRaisesRegex(RuntimeError, "account"):
                lifecycle.guarded_sources(scope)
        foreign = command("aws", "secretsmanager")
        foreign["Tags"] = []
        with patch.object(lifecycle.sync.preflight, "command", side_effect=lambda *args: foreign if args[1] == "secretsmanager" else command(*args)):
            with self.assertRaisesRegex(RuntimeError, "ownership"):
                lifecycle.guarded_sources(scope)

    def test_temporary_kubeconfig_removed_after_failed_apply(self):
        saved_paths = []
        previous = os.environ.get("KUBECONFIG")
        def fail_apply(scope):
            path = Path(os.environ["KUBECONFIG"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            saved_paths.append(path)
            raise RuntimeError("partial apply")
        with patch.dict(os.environ, {"GG_RUNTIME_SECRET_SCOPE": json.dumps(self.scope)}), \
             patch.object(lifecycle.sys, "argv", ["lifecycle.py", "apply"]), \
             patch.object(lifecycle, "guarded_sources"), patch.object(lifecycle, "run_checked", return_value="fixture kubeconfig"), \
             patch.object(lifecycle, "apply", side_effect=fail_apply):
            with self.assertRaisesRegex(RuntimeError, "partial apply"):
                lifecycle.main()
        self.assertFalse(saved_paths[0].exists())
        self.assertEqual(os.environ.get("KUBECONFIG"), previous)

    def test_cleanup_preflights_entire_subset_before_deletion(self):
        self.scope["versions"]["gateway-config"] = "version-1"
        self.scope["sources"]["gateway-config"] = "greenguard/disposable/gateway-config"
        foreign = {"type": "Opaque", "metadata": {"annotations": {}, "labels": {}}}
        with patch.object(lifecycle.sync, "existing_secret", side_effect=[self.current, foreign]), patch.object(lifecycle, "run_checked") as run:
            with self.assertRaisesRegex(RuntimeError, "foreign"):
                lifecycle.cleanup(self.scope)
        run.assert_not_called()

    def test_valid_role_profile_uses_bootstrap_password_and_verified_endpoint(self):
        expected = {"greenguard-rds-bootstrap": {"data": {"INVENTORY_DB_PASSWORD": "fixture-password", "PGHOST": "db.example"}},
                    "device-service-config": {"data": {"INVENTORY_DATABASE_URL": "postgresql://inventory_app:fixture-password@db.example:5432/greenguard_inventory?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"}}}
        lifecycle.validate_profiles(expected)
        expected["device-service-config"]["data"]["INVENTORY_DATABASE_URL"] = expected["device-service-config"]["data"]["INVENTORY_DATABASE_URL"].replace("db.example", "foreign.example")
        with self.assertRaisesRegex(RuntimeError, "role profile"):
            lifecycle.validate_profiles(expected)

    def test_certificate_marker_without_real_certificate_is_rejected(self):
        expected = {"greenguard-rds-bootstrap": {"data": {}}, "greenguard-rds-ca": {"data": {"ca.pem": "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----"}}}
        with self.assertRaises(RuntimeError):
            lifecycle.validate_profiles(expected)

    def test_tls_key_pair_mismatch_rejected(self):
        expected = {"greenguard-rds-bootstrap": {"data": {}}, "greenguard-mqtt-broker": {"data": {"tls.crt": "fixture-cert", "tls.key": "fixture-key"}}}
        def crypto(argv, value):
            return "certificate-public" if "-pubkey" in argv else "key-public" if "-pubout" in argv else ""
        with patch.object(lifecycle, "run_checked", side_effect=crypto):
            with self.assertRaisesRegex(RuntimeError, "key mismatch"):
                lifecycle.validate_profiles(expected)

    def test_nested_source_annotation_and_cleanup(self):
        name = "greenguard-shard-routing-device-service"
        source = "greenguard/disposable/shard-routing/device-service"
        scope = {**self.scope, "versions": {name: "version-1"}, "sources": {name: source}}
        record = {**self.record, "source": source}
        desired = lifecycle.annotate_desired(name, scope, record, None)
        current = {"type": "Opaque", "metadata": {**desired["metadata"], "uid": "uid", "resourceVersion": "1"}}
        self.assertEqual(desired["metadata"]["annotations"]["greenguard.io/aws-secret-name"], source)
        with patch.object(lifecycle.sync, "existing_secret", return_value=current), patch.object(lifecycle, "run_checked") as run:
            lifecycle.cleanup(scope)
        run.assert_called_once()

    def test_registry_complete_physical_contract_and_writer_rejects_replica(self):
        scope = {**self.scope, "shard_bootstraps": {}}
        expected = {}
        entries = {}
        for shard_id in ("s1", "s2", "s3", "s4"):
            name = f"greenguard-{shard_id}-rds-bootstrap"
            host, replica = f"{shard_id}.primary.example", f"{shard_id}.replica.example"
            physical = {"host": host, "replica_hosts": [replica], "incarnation": f"10000000-0000-5000-8000-00000000000{shard_id[1]}"}
            scope["shard_bootstraps"][name] = physical
            expected[name] = {"data": {"INVENTORY_DB_PASSWORD": "fixture-pass"}}
            def url(endpoint):
                return f"postgresql://inventory_app:fixture-pass@{endpoint}:5432/greenguard_inventory?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
            entries[shard_id] = {"incarnation": physical["incarnation"], "primaryUrl": url(host), "replicaUrls": [url(replica)]}
        name = "greenguard-shard-routing-device-service"
        manifest = {"formatVersion": 1, "service": "device-service", "database": "greenguard_inventory", "shards": entries}
        expected[name] = {"data": {"registry.json": json.dumps(manifest)}}
        lifecycle.validate_supplemental_profiles(scope, expected)
        # Alternate entrypoints retain the base service identity while changing
        # only their approved least-privilege role and source Secret identity.
        del expected[name]
        name = "greenguard-shard-routing-inventory-projector"
        for record in expected.values():
            record["data"]["INVENTORY_PROJECTOR_PASSWORD"] = "fixture-pass"
        for entry in entries.values():
            entry["primaryUrl"] = entry["primaryUrl"].replace("inventory_app", "inventory_projector")
            entry["replicaUrls"] = [url.replace("inventory_app", "inventory_projector") for url in entry["replicaUrls"]]
        expected[name] = {"data": {"registry.json": json.dumps(manifest)}}
        lifecycle.validate_supplemental_profiles(scope, expected)
        entries["s1"]["primaryUrl"] = entries["s1"]["replicaUrls"][0]
        expected[name]["data"]["registry.json"] = json.dumps(manifest)
        with self.assertRaisesRegex(RuntimeError, "endpoint"):
            lifecycle.validate_supplemental_profiles(scope, expected)

    def test_audit_export_worker_registry_uses_inventory_audit_reader_profile(self):
        scope = {**self.scope, "shard_bootstraps": {}}
        expected = {}
        shards = {}
        for shard_id in ("s1", "s2", "s3", "s4"):
            bootstrap_name = f"greenguard-{shard_id}-rds-bootstrap"
            host, replica = f"{shard_id}.primary.example", f"{shard_id}.replica.example"
            physical = {"host": host, "replica_hosts": [replica], "incarnation": f"10000000-0000-5000-8000-00000000000{shard_id[1]}"}
            scope["shard_bootstraps"][bootstrap_name] = physical
            expected[bootstrap_name] = {"data": {"INVENTORY_AUDIT_READER_PASSWORD": "audit-reader-pass"}}
            def url(endpoint):
                return f"postgresql://inventory_audit_reader:audit-reader-pass@{endpoint}:5432/greenguard_inventory?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
            shards[shard_id] = {"incarnation": physical["incarnation"], "primaryUrl": url(host), "replicaUrls": [url(replica)]}
        manifest = {"formatVersion": 1, "service": "audit-export-worker", "database": "greenguard_inventory", "shards": shards}
        name = "greenguard-shard-routing-audit-export-worker"
        expected[name] = {"data": {"registry.json": json.dumps(manifest)}}
        lifecycle.validate_supplemental_profiles(scope, expected)

        wrong_role = json.loads(json.dumps(expected))
        wrong_role[name]["data"]["registry.json"] = wrong_role[name]["data"]["registry.json"].replace("inventory_audit_reader", "inventory_app")
        with self.assertRaisesRegex(RuntimeError, "shard role/endpoint/TLS"):
            lifecycle.validate_supplemental_profiles(scope, wrong_role)

    def test_migration_owner_key_role_and_authority_contract(self):
        expected = {"greenguard-rds-bootstrap": {"data": {"PGHOST": "central.example", "CONTROL_MIGRATOR_PASSWORD": "fixture-pass"}},
                    "greenguard-control-migration": {"data": {"CONTROL_MIGRATION_URL": "postgresql://control_migrator:fixture-pass@central.example:5432/greenguard_control?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem"}}}
        lifecycle.validate_supplemental_profiles(self.scope, expected)
        expected["greenguard-control-migration"]["data"]["CONTROL_MIGRATION_URL"] = expected["greenguard-control-migration"]["data"]["CONTROL_MIGRATION_URL"].replace("control_migrator", "control_app")
        with self.assertRaisesRegex(RuntimeError, "migration role"):
            lifecycle.validate_supplemental_profiles(self.scope, expected)

    def test_shard_cdc_and_pgbouncer_profiles(self):
        owners = {row["name"]: row for row in json.loads(__import__("re").search(r"fromJsonArray `([^`]+)`", (Path(__file__).parent / "applications-chart/templates/_owner-migrations.tpl").read_text()).group(1))}
        roles = {row["role"]: owner.upper() + "_DB_PASSWORD" for owner, row in owners.items() if not row["central"]}
        roles.update({"read_query": "READ_QUERY_DB_PASSWORD", "inventory_projector": "INVENTORY_PROJECTOR_PASSWORD", "telemetry_entitlement_projector": "TELEMETRY_ENTITLEMENT_PROJECTOR_PASSWORD", "read_entitlement_projector": "READ_ENTITLEMENT_PROJECTOR_PASSWORD"})
        passwords = {key: "fixture-" + key for key in roles.values()}
        passwords["CDC_DB_PASSWORD"] = "fixture-cdc"
        expected = {"greenguard-s1-rds-bootstrap": {"data": passwords}, "greenguard-s1-cdc-credentials": {"data": {"CDC_DB_PASSWORD": "fixture-cdc"}},
                    "greenguard-s1-pgbouncer-auth": {"data": {"userlist.txt": "\n".join(f'"{role}" "{passwords[key]}"' for role, key in roles.items())}}}
        lifecycle.validate_supplemental_profiles(self.scope, expected)
        expected["greenguard-s1-pgbouncer-auth"]["data"]["userlist.txt"] += '\n"postgres" "foreign"'
        with self.assertRaisesRegex(RuntimeError, "PgBouncer"):
            lifecycle.validate_supplemental_profiles(self.scope, expected)
        del expected["greenguard-s1-pgbouncer-auth"]
        expected["greenguard-s1-cdc-credentials"]["data"]["CDC_DB_PASSWORD"] = "foreign"
        with self.assertRaisesRegex(RuntimeError, "CDC"):
            lifecycle.validate_supplemental_profiles(self.scope, expected)

    def test_all_nested_source_classes_cleanup_and_changed_master_guard(self):
        pairs = [("greenguard-shard-routing-device-service", "shard-routing/device-service"),
                 ("greenguard-s1-rds-bootstrap", "shards/s1/bootstrap"),
                 ("greenguard-s1-pgbouncer-auth", "shards/s1/pgbouncer"),
                 ("greenguard-s1-cdc-credentials", "shards/s1/cdc")]
        for name, suffix in pairs:
            with self.subTest(name=name):
                source = "greenguard/disposable/" + suffix
                scope = {**self.scope, "versions": {name: "version-1"}, "sources": {name: source}, "shard_bootstraps": {}}
                record = {**self.record, "source": source}
                if suffix.endswith("bootstrap"):
                    scope["shard_bootstraps"] = {name: {"master_version": "shard-master-1"}}
                    record["master_version"] = "shard-master-1"
                desired = lifecycle.annotate_desired(name, scope, record, None)
                current = {"type": "Opaque", "metadata": {**desired["metadata"], "uid": "uid", "resourceVersion": "1"}}
                with patch.object(lifecycle.sync, "existing_secret", return_value=current), patch.object(lifecycle, "run_checked") as run:
                    lifecycle.cleanup(scope)
                    run.assert_called_once()
                    if suffix.endswith("bootstrap"):
                        current["metadata"]["annotations"]["greenguard.io/rds-master-version-id"] = "foreign-master"
                        run.reset_mock()
                        with self.assertRaisesRegex(RuntimeError, "changed shard master"):
                            lifecycle.cleanup(scope)
                        run.assert_not_called()

    def test_failed_partial_apply_retry_retains_and_finishes_owned_subset(self):
        self.scope["versions"]["greenguard-rds-bootstrap"] = "bootstrap-v1"
        self.scope["sources"]["greenguard-rds-bootstrap"] = "greenguard/disposable/greenguard-rds-bootstrap"
        bootstrap = {"data": {"PGHOST": "fixture"}, "version": "bootstrap-v1", "master_version": "master-v1", "source": self.scope["sources"]["greenguard-rds-bootstrap"]}
        records = {"bff-config": self.record, "greenguard-rds-bootstrap": bootstrap}
        stored = {}
        def write(desired, replace):
            name = desired["metadata"]["name"]
            if name == "greenguard-rds-bootstrap" and "bff-config" in stored:
                raise RuntimeError("fixture partial write failure")
            stored[name] = {"type": "Opaque", "metadata": {**desired["metadata"], "resourceVersion": "1"},
                            "data": {key: base64.b64encode(value.encode()).decode() for key, value in desired["stringData"].items()}}
        with patch.object(lifecycle.sync.preflight, "expected_secrets", return_value=records), patch.object(lifecycle, "validate_profiles"), \
             patch.object(lifecycle.sync, "existing_secret", side_effect=lambda name, namespace: stored.get(name)), \
             patch.object(lifecycle, "run_checked"), patch.object(lifecycle.sync.preflight, "verify_targets", return_value=0):
            with patch.object(lifecycle.sync, "write_secret", side_effect=write):
                with self.assertRaisesRegex(RuntimeError, "partial write"):
                    lifecycle.apply(self.scope)
            self.assertEqual(set(stored), {"bff-config"})
            with patch.object(lifecycle.sync, "write_secret") as retry:
                lifecycle.apply(self.scope)
                retry.assert_called_once()
                self.assertEqual(retry.call_args.args[0]["metadata"]["name"], "greenguard-rds-bootstrap")

    def test_role_profile_rejects_privileged_url(self):
        expected = {"greenguard-rds-bootstrap": {"data": {"INVENTORY_DB_PASSWORD": "secret"}},
                    "device-service-config": {"data": {"INVENTORY_DATABASE_URL": "postgresql://postgres:secret@db/greenguard_inventory"}}}
        with self.assertRaisesRegex(RuntimeError, "role profile"):
            lifecycle.validate_profiles(expected)


if __name__ == "__main__":
    unittest.main()
