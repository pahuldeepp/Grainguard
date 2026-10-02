from __future__ import annotations

import os
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ml_scoring.local_guard import validate_cluster_synthetic_postgres_dsn
from ml_scoring.main import (_health_server, validate_cluster_synthetic_endpoints,
                             validate_cluster_synthetic_kafka_metadata,
                             validate_cluster_synthetic_kafka_security, run)
from ml_scoring.store import InMemoryRepository


class ClusterSyntheticGuardTests(unittest.TestCase):
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
