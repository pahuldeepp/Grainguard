import importlib.util
import pathlib
import tempfile
import json
import hashlib
import copy
import io
import re
import subprocess
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("register", HERE / "files" / "register.py")
register = importlib.util.module_from_spec(spec)
spec.loader.exec_module(register)


class RegistrationTest(unittest.TestCase):
    def test_connector_configs_match_source_inventory(self):
        source = HERE.parents[2] / "kafka" / "connectors"
        packaged = HERE / "files" / "connectors"
        self.assertEqual(
            {p.name for p in source.glob("*.json")},
            {p.name for p in packaged.glob("*.json")},
        )
        for path in source.glob("*.json"):
            self.assertEqual(path.read_bytes(), (packaged / path.name).read_bytes())

    def test_inventory_and_rds_tls(self):
        configs = register.load_configs("db.example.com")
        self.assertEqual(len(configs), 8)
        for config in configs.values():
            self.assertEqual(config["database.hostname"], "db.example.com")
            self.assertEqual(config["database.sslmode"], "verify-full")
            self.assertEqual(config["database.sslrootcert"], "/rds-ca/ca.pem")
        contacts = configs["notification-contacts"]
        self.assertEqual(contacts["value.converter.basic.auth.credentials.source"], "USER_INFO")
        self.assertEqual(contacts["value.converter.basic.auth.user.info"], "${env:SCHEMA_REGISTRY_BASIC_USER_INFO}")
        self.assertEqual(contacts["value.converter.schema.registry.ssl.truststore.type"], "PEM")
        self.assertEqual(contacts["value.converter.schema.registry.ssl.truststore.location"], "/etc/greenguard/kafka/registry-ca.crt")

    def test_four_shard_configs_preserve_topics_and_lineage(self):
        hosts = {f"s{i}": f"shard-{i}.example.com" for i in range(1, 5)}
        configs = register.load_shard_configs("central.example.com", hosts)
        self.assertEqual(len(configs), 23)
        for central in ("control-outbox", "billing-outbox", "notification-contacts"):
            self.assertEqual(configs[central]["database.hostname"], "central.example.com")
        source_names = set()
        for shard_id, host in hosts.items():
            entries = {name: config for name, config in configs.items() if name.endswith("-" + shard_id)}
            self.assertEqual(len(entries), 5)
            for name, config in entries.items():
                self.assertEqual(config["database.hostname"], host)
                self.assertTrue(config["slot.name"].startswith(shard_id + "_"))
                self.assertEqual(config["database.password"], "${env:CDC_DB_PASSWORD_" + shard_id.upper() + "}")
                self.assertNotIn(config["topic.prefix"], source_names)
                source_names.add(config["topic.prefix"])
                original = register.load_configs(host)[name.removesuffix("-" + shard_id)]
                for key, value in original.items():
                    if key.startswith("transforms.") and key.endswith(".replacement"):
                        self.assertEqual(config[key], value, "canonical downstream topics must stay stable")
                    if key.startswith("transforms.") and key.endswith(".regex"):
                        self.assertIn(config["topic.prefix"], config[key])
        self.assertEqual(len(source_names), 20)

    def test_invalid_or_colliding_shard_registry_rejected(self):
        with self.assertRaises(ValueError):
            register.load_shard_configs("central.example.com", {"s1": "s1.example.com"})
        with self.assertRaises(ValueError):
            register.load_shard_configs("central.example.com", {f"s{i}": "same.example.com" for i in range(1, 5)})
        with self.assertRaises(ValueError):
            register.load_shard_configs("central.example.com", {f"s{i}": ("central.example.com" if i == 1 else f"s{i}.example.com") for i in range(1, 5)})

    def test_central_retirement_is_receipt_gated_and_preserves_global_streams(self):
        with tempfile.NamedTemporaryFile("w+", suffix=".json") as receipt:
            fixture = {"source":"legacy-central", "sourceHost":"central.example.com", "writesFenced":True, "transferVerified":True, "remainingTenants":0}
            json.dump(fixture, receipt); receipt.flush()
            register.validate_central_retirement(receipt.name, "central.example.com", hashlib.sha256(pathlib.Path(receipt.name).read_bytes()).hexdigest())
            with self.assertRaises(ValueError):
                register.validate_central_retirement(receipt.name, "foreign.example.com", hashlib.sha256(pathlib.Path(receipt.name).read_bytes()).hexdigest())
            with self.assertRaisesRegex(ValueError, "revision"):
                register.validate_central_retirement(receipt.name, "central.example.com", "0" * 64)
            fixture["remainingTenants"] = False
            receipt.seek(0); receipt.truncate(); json.dump(fixture, receipt); receipt.flush()
            with self.assertRaises(ValueError):
                register.validate_central_retirement(receipt.name, "central.example.com", hashlib.sha256(pathlib.Path(receipt.name).read_bytes()).hexdigest())

    def retirement_fixture(self, active=False):
        configs = register.load_configs("central.example.com")
        protected = {"control-outbox", "billing-outbox", "notification-contacts"}
        central = {name: copy.deepcopy(config) for name, config in configs.items() if name not in protected}
        slots = {config["slot.name"]: {"slot_name": config["slot.name"], "database": config["database.dbname"], "plugin": "pgoutput", "active": active} for config in central.values()}
        calls, sql = [], []
        def http(method, url, payload=None):
            name = url.removesuffix("/config").rsplit("/", 1)[1]
            self.assertNotIn(name, protected)
            calls.append((method, name, payload))
            if method == "GET":
                return central.get(name)
            if method == "PUT":
                self.assertEqual(payload["slot.drop.on.stop"], "true")
                central[name] = payload
            if method == "DELETE":
                central.pop(name, None)
        def query(statement, environment):
            sql.append(statement)
            for name in protected:
                self.assertNotIn(configs[name]["slot.name"], statement)
            if "json_build_object" in statement:
                return json.dumps({"user": "cdc_reader", "database": "postgres", "slots": list(slots.values())})
            self.assertIn("AND NOT active", statement)
            self.assertIn("current_user='cdc_reader'", statement)
            slot = re.search("slot_name='([^']+)'", statement).group(1)
            self.assertFalse(slots[slot]["active"])
            slots.pop(slot)
            return ""
        return central, slots, calls, sql, http, query

    def test_retirement_proves_connector_and_inactive_slot_absence(self):
        central, slots, calls, sql, http, query = self.retirement_fixture()
        with patch.object(register, "request", side_effect=http), patch.object(register, "retirement_sql", side_effect=query):
            register.retire_central_operational_connectors("http://connect:8083/", "central.example.com", {}, register.time.monotonic() + 45)
        self.assertEqual({}, central)
        self.assertEqual({}, slots)
        self.assertEqual(5, sum(method == "DELETE" for method, _, _ in calls))
        self.assertEqual(5, sum("pg_drop_replication_slot" in statement for statement in sql))
        self.assertTrue(all(method == "GET" for method, _, _ in calls[:5]))

    def test_active_slots_fail_closed_without_force_drop(self):
        _, slots, _, sql, http, query = self.retirement_fixture(active=True)
        tick = [0]
        def clock():
            tick[0] += 1
            return tick[0]
        with patch.object(register, "request", side_effect=http), patch.object(register, "retirement_sql", side_effect=query), patch.object(register.time, "monotonic", side_effect=clock), patch.object(register.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "replication slots remain"):
                register.retire_central_operational_connectors("http://connect:8083", "central.example.com", {}, 10)
        self.assertEqual(5, len(slots))
        self.assertFalse(any("pg_drop_replication_slot" in statement for statement in sql))
        self.assertFalse(any("pg_terminate_backend" in statement for statement in sql))

    def test_wrong_connector_or_slot_scope_stops_before_delete(self):
        for wrong_connector in (True, False):
            central, slots, calls, _, http, query = self.retirement_fixture()
            if wrong_connector:
                next(iter(central.values()))["database.hostname"] = "other.example.com"
            else:
                next(iter(slots.values()))["database"] = "wrong_database"
            with patch.object(register, "request", side_effect=http), patch.object(register, "retirement_sql", side_effect=query):
                with self.assertRaises(ValueError):
                    register.retire_central_operational_connectors("http://connect:8083", "central.example.com", {}, register.time.monotonic() + 45)
            self.assertTrue(all(method == "GET" for method, _, _ in calls))

    def test_retirement_preflight_requires_tools_ca_and_secret(self):
        with patch.object(register.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "containing psql"):
                register.retirement_environment("central.example.com")
        with patch.object(register.shutil, "which", return_value="/usr/bin/psql"), patch.object(register.pathlib.Path, "is_file", return_value=False):
            with self.assertRaisesRegex(ValueError, "mounted RDS CA"):
                register.retirement_environment("central.example.com")
        with patch.object(register.shutil, "which", return_value="/usr/bin/psql"), patch.object(register.pathlib.Path, "is_file", return_value=True), patch.dict(register.os.environ, {"CDC_DB_PASSWORD": "private-fixture", "PGHOSTADDR": "wrong", "PGSERVICE": "wrong"}):
            environment = register.retirement_environment("central.example.com")
        self.assertEqual("central.example.com", environment["PGHOST"])
        self.assertEqual("verify-full", environment["PGSSLMODE"])
        self.assertNotIn("PGHOSTADDR", environment)
        self.assertNotIn("PGSERVICE", environment)

    def test_sql_failure_does_not_echo_credentials(self):
        result = subprocess.CompletedProcess([], 1, "", "private-password")
        with patch.object(register.subprocess, "run", return_value=result) as process:
            with self.assertRaisesRegex(RuntimeError, "diagnostics withheld") as error:
                register.retirement_sql("SELECT 1", {"PGPASSWORD": "private-password"})
            self.assertNotIn("private-password", str(error.exception))
            self.assertNotIn("private-password", str(process.call_args.args))

    def test_main_retirement_requires_receipt_before_registration_then_slot_cleanup(self):
        hosts = {f"s{i}": f"s{i}.example.com" for i in range(1, 5)}
        receipt = {"source": "legacy-central", "sourceHost": "central.example.com", "writesFenced": True, "transferVerified": True, "remainingTenants": 0}
        with tempfile.NamedTemporaryFile("w+", suffix=".json") as file:
            json.dump(receipt, file); file.flush()
            environment = {"RDS_HOST": "central.example.com", "SHARD_HOSTS_JSON": json.dumps(hosts), "CENTRAL_RETIREMENT_RECEIPT_FILE": file.name,
                           "CENTRAL_RETIREMENT_RECEIPT_SHA256": hashlib.sha256(pathlib.Path(file.name).read_bytes()).hexdigest()}
            order = []
            with patch.dict(register.os.environ, environment, clear=True), patch.object(register, "retirement_environment", side_effect=lambda host: order.append("preflight") or {}), patch.object(register, "run", side_effect=lambda *args: order.append("healthy-shards")), patch.object(register, "retire_central_operational_connectors", side_effect=lambda *args: order.append("slots-absent")), patch.object(register.sys, "stdout", io.StringIO()):
                self.assertEqual(0, register.main())
            self.assertEqual(["preflight", "healthy-shards", "slots-absent"], order)
            receipt["writesFenced"] = False
            file.seek(0); file.truncate(); json.dump(receipt, file); file.flush()
            environment["CENTRAL_RETIREMENT_RECEIPT_SHA256"] = hashlib.sha256(pathlib.Path(file.name).read_bytes()).hexdigest()
            with patch.dict(register.os.environ, environment, clear=True), patch.object(register, "run") as run, patch.object(register, "retire_central_operational_connectors") as retire, patch.object(register.sys, "stderr", io.StringIO()):
                self.assertEqual(1, register.main())
                run.assert_not_called(); retire.assert_not_called()

    def test_main_without_receipt_never_requests_slot_cleanup_credentials(self):
        with patch.dict(register.os.environ, {"RDS_HOST": "central.example.com"}, clear=True), patch.object(register, "assert_no_existing_shard_connectors"), patch.object(register, "run"), patch.object(register, "retirement_environment") as credentials, patch.object(register, "retire_central_operational_connectors") as retire, patch.object(register.sys, "stdout", io.StringIO()):
            self.assertEqual(0, register.main())
            credentials.assert_not_called(); retire.assert_not_called()

    def test_existing_source_change_fails_before_any_put(self):
        calls = []
        def fake_request(method, url, payload=None):
            calls.append(method)
            return {"database.hostname":"old.example.com", "database.dbname":"db", "topic.prefix":"source", "slot.name":"slot"}
        with patch.object(register, "request", side_effect=fake_request):
            with self.assertRaisesRegex(ValueError, "source identity changed"):
                register.run({"telemetry-outbox-s1":{"database.hostname":"replacement.example.com", "database.dbname":"db", "topic.prefix":"source", "slot.name":"slot"}}, "http://connect", 0)
        self.assertNotIn("PUT", calls)

    def test_source_identity_is_exact_except_hostname(self):
        identity = {"database.hostname":"DB.example.com", "database.dbname":"db", "topic.prefix":"source", "slot.name":"slot"}
        for key in ("database.dbname", "topic.prefix", "slot.name"):
            proposed = dict(identity, **{"database.hostname":"db.example.com"})
            proposed[key] = proposed[key].upper()
            calls = []
            def fake_request(method, url, payload=None):
                calls.append(method)
                return identity
            with self.subTest(key=key), patch.object(register, "request", side_effect=fake_request):
                with self.assertRaisesRegex(ValueError, "source identity changed"):
                    register.run({"telemetry-outbox-s1":proposed}, "http://connect", 0)
            self.assertNotIn("PUT", calls)

    def test_registry_downgrade_does_not_delete_live_shard_sources(self):
        with patch.object(register, "request", return_value=["telemetry-outbox-s1", "control-outbox"]):
            with self.assertRaisesRegex(ValueError, "cannot drop the shard registry"):
                register.assert_no_existing_shard_connectors("http://connect")
        with patch.object(register, "request", return_value=["control-outbox", "billing-outbox"]):
            register.assert_no_existing_shard_connectors("http://connect")

    def test_bad_host_rejected(self):
        with self.assertRaises(ValueError):
            register.load_configs("localhost")
        with self.assertRaises(ValueError):
            register.load_configs("bad/host")

    def test_register_and_wait(self):
        calls = []

        def fake_request(method, url, payload=None):
            calls.append((method, url))
            if method == "GET" and url.endswith("/config"):
                return None
            if method == "GET":
                return {"connector": {"state": "RUNNING"}, "tasks": [{"state": "RUNNING"}]}
            return {}

        with patch.object(register, "request", side_effect=fake_request):
            register.run({"a": {}, "b": {}}, "http://connect:8083", float("inf"))
        self.assertEqual(sum(method == "PUT" for method, _ in calls), 2)
        self.assertEqual(sum(method == "GET" and url.endswith("/status") for method, url in calls), 2)

    def test_failed_task_fails_closed(self):
        def fake_request(method, url, payload=None):
            if method == "GET" and url.endswith("/config"):
                return None
            if method == "GET":
                return {"connector": {"state": "RUNNING"}, "tasks": [{"state": "FAILED"}]}
            return {}

        with patch.object(register, "request", side_effect=fake_request):
            with self.assertRaisesRegex(RuntimeError, "FAILED"):
                register.run({"a": {}}, "http://connect:8083", float("inf"))

    def test_deadline_fails_closed(self):
        with patch.object(register, "request", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "did not reach RUNNING"):
                register.run({"a": {}}, "http://connect:8083", 0)


if __name__ == "__main__":
    unittest.main()
