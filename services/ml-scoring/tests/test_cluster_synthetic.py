from __future__ import annotations

import os
import json
import socket
import tempfile
import urllib.error
import urllib.request
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ml_scoring.local_guard import validate_cluster_synthetic_postgres_dsn
from ml_scoring.main import (_health_server, validate_cluster_synthetic_endpoints,
                             validate_cluster_synthetic_kafka_metadata,
                             validate_cluster_synthetic_kafka_security, run)
from ml_scoring.store import InMemoryRepository


class ClusterSyntheticGuardTests(unittest.TestCase):
    def test_cluster_operations_endpoint_requires_exact_internal_token(self):
        token = "t" * 48
        with patch.dict(os.environ, {"ML_ENVIRONMENT": "cluster-synthetic", "ML_OPERATIONS_TOKEN": token}, clear=True):
            server = _health_server(
                InMemoryRepository(), 0, host="127.0.0.1",
                operations_supplier=lambda tenant: {"tenant_id": tenant, "count": 3},
            )
            try:
                url = f"http://127.0.0.1:{server.server_port}/operations?tenant_id=synthetic-fixture"
                for headers in ({}, {"X-Internal-Token": "wrong"}):
                    with self.subTest(headers=headers), self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=3)
                    self.assertEqual(error.exception.code, 401)
                with socket.create_connection(("127.0.0.1", server.server_port), timeout=3) as client:
                    client.sendall(b"GET /operations?tenant_id=synthetic-fixture HTTP/1.1\r\nHost: localhost\r\nX-Internal-Token: \xff\r\nConnection: close\r\n\r\n")
                    response = client.recv(1024)
                self.assertIn(b"401 Unauthorized", response)
                request = urllib.request.Request(url, headers={"X-Internal-Token": token})
                with urllib.request.urlopen(request, timeout=3) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.load(response), {"tenant_id": "synthetic-fixture", "count": 3})
            finally:
                server.shutdown()
                server.server_close()

    def test_cluster_operations_rejects_missing_or_short_token_at_startup(self):
        for token in ("", "short"):
            with self.subTest(token_length=len(token)), patch.dict(
                    os.environ, {"ML_ENVIRONMENT": "cluster-synthetic", "ML_OPERATIONS_TOKEN": token}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "ML_OPERATIONS_TOKEN"):
                    _health_server(InMemoryRepository(), 0, operations_supplier=lambda _tenant: {})

    def test_postgres_accepts_only_namespace_service_verified_tls_and_mounted_ca(self):
        with tempfile.NamedTemporaryFile() as ca, patch.dict(os.environ, {"PGSSLROOTCERT": ca.name}, clear=True):
            validate_cluster_synthetic_postgres_dsn(
                "postgresql://user:pass@postgres.ml-synthetic.svc.cluster.local:5432/greenguard_ml?sslmode=verify-full",
            )
            for dsn in (
                "postgresql://user:pass@prod.example.com:5432/greenguard_ml?sslmode=verify-full",
                "postgresql://user:pass@postgres.data.svc.cluster.local:5432/greenguard_ml?sslmode=verify-full",
                "postgresql://user:pass@postgres.ml-synthetic.svc.cluster.local:5432/other?sslmode=verify-full",
                "postgresql://user:pass@postgres.ml-synthetic.svc.cluster.local:5432/greenguard_ml?sslmode=disable",
            ):
                with self.subTest(dsn=dsn), self.assertRaises(ValueError):
                    validate_cluster_synthetic_postgres_dsn(dsn)

    def test_postgres_rejects_libpq_routing_overrides_and_missing_ca(self):
        dsn = "postgresql://user:pass@postgres.ml-synthetic.svc.cluster.local/greenguard_ml?sslmode=verify-full"
        with patch.dict(os.environ, {"PGHOST": "prod.example.com", "PGSSLROOTCERT": "/missing"}, clear=True):
            with self.assertRaisesRegex(ValueError, "routing environment"):
                validate_cluster_synthetic_postgres_dsn(dsn)
        with patch.dict(os.environ, {"PGSSLROOTCERT": "/missing"}, clear=True):
            with self.assertRaisesRegex(ValueError, "root certificate"):
                validate_cluster_synthetic_postgres_dsn(dsn)

    def test_kafka_bootstrap_and_advertised_brokers_must_stay_in_namespace(self):
        with tempfile.NamedTemporaryFile() as ca:
            dsn = "postgresql://user:pass@postgres.ml-synthetic.svc.cluster.local:5432/greenguard_ml?sslmode=verify-full"
            with patch.dict(os.environ, {"PGSSLROOTCERT": ca.name}, clear=True):
                validate_cluster_synthetic_endpoints(
                    dsn,
                    "kafka.ml-synthetic.svc.cluster.local:9093,kafka-1.kafka.ml-synthetic.svc.cluster.local:9093",
                )
                for brokers_value in ("prod.example.com:9093", "127.0.0.1:9093",
                                      "kafka.ml-synthetic.svc.cluster.local:9092"):
                    with self.subTest(brokers=brokers_value), self.assertRaises(RuntimeError):
                        validate_cluster_synthetic_endpoints(dsn, brokers_value)
            brokers = SimpleNamespace(brokers={
                1: SimpleNamespace(host="kafka-1.kafka.ml-synthetic.svc.cluster.local", port=9093),
                2: SimpleNamespace(host="kafka-2.kafka.ml-synthetic.svc.cluster.local", port=9093),
            })
            validate_cluster_synthetic_kafka_metadata(brokers)
            for host, port in (("prod.example.com", 9093),
                               ("127.0.0.1", 9093),
                               ("kafka.ml-synthetic.svc.cluster.local", 9092)):
                with self.subTest(host=host, port=port), self.assertRaises(RuntimeError):
                    validate_cluster_synthetic_kafka_metadata(SimpleNamespace(
                        brokers={1: SimpleNamespace(host=host, port=port)}))
            validate_cluster_synthetic_kafka_security(
                protocol="SASL_SSL", mechanism="SCRAM-SHA-512", username="synthetic",
                password="synthetic-only", ca_location=ca.name,
            )
            for values in (
                {"protocol": "PLAINTEXT", "mechanism": "SCRAM-SHA-512", "username": "u", "password": "p", "ca_location": ca.name},
                {"protocol": "SASL_SSL", "mechanism": "PLAIN", "username": "u", "password": "p", "ca_location": ca.name},
                {"protocol": "SASL_SSL", "mechanism": "SCRAM-SHA-512", "username": "u", "password": "", "ca_location": ca.name},
                {"protocol": "SASL_SSL", "mechanism": "SCRAM-SHA-512", "username": "u", "password": "p", "ca_location": "/missing"},
            ):
                with self.subTest(values=values), self.assertRaises(RuntimeError):
                    validate_cluster_synthetic_kafka_security(**values)

    def test_no_generic_or_production_environment_and_no_local_remote_probe_escape(self):
        with patch.dict(os.environ, {"ML_ENVIRONMENT": "production"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "local-synthetic or cluster-synthetic"):
                run()
        with patch.dict(os.environ, {"ML_ENVIRONMENT": "local-synthetic",
                                    "ML_ALLOW_REMOTE_HEALTH_BIND": "true"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "cluster-synthetic"):
                _health_server(InMemoryRepository(), 0, host="0.0.0.0")


if __name__ == "__main__":
    unittest.main()
