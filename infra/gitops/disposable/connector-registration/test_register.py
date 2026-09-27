import importlib.util
import pathlib
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

    def test_bad_host_rejected(self):
        with self.assertRaises(ValueError):
            register.load_configs("localhost")
        with self.assertRaises(ValueError):
            register.load_configs("bad/host")

    def test_register_and_wait(self):
        calls = []

        def fake_request(method, url, payload=None):
            calls.append((method, url))
            if method == "GET":
                return {"connector": {"state": "RUNNING"}, "tasks": [{"state": "RUNNING"}]}
            return {}

        with patch.object(register, "request", side_effect=fake_request):
            register.run({"a": {}, "b": {}}, "http://connect:8083", float("inf"))
        self.assertEqual(sum(method == "PUT" for method, _ in calls), 2)
        self.assertEqual(sum(method == "GET" for method, _ in calls), 2)

    def test_failed_task_fails_closed(self):
        def fake_request(method, url, payload=None):
            if method == "GET":
                return {"connector": {"state": "RUNNING"}, "tasks": [{"state": "FAILED"}]}
            return {}

        with patch.object(register, "request", side_effect=fake_request):
            with self.assertRaisesRegex(RuntimeError, "FAILED"):
                register.run({"a": {}}, "http://connect:8083", float("inf"))

    def test_deadline_fails_closed(self):
        with patch.object(register, "request", return_value={}):
            with self.assertRaisesRegex(RuntimeError, "did not reach RUNNING"):
                register.run({"a": {}}, "http://connect:8083", 0)


if __name__ == "__main__":
    unittest.main()
