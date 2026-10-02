"""Fail-closed guards for local synthetic PostgreSQL endpoints."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlsplit


_LIBPQ_ROUTING_ENV = (
    "PGHOST", "PGHOSTADDR", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE",
)


def validate_local_postgres_dsn(dsn: str, *, allowed_hosts: set[str],
                                database_name: str) -> None:
    """Check libpq's effective target, including URI options and environment."""
    overrides = [name for name in _LIBPQ_ROUTING_ENV if os.environ.get(name)]
    if overrides:
        raise ValueError("libpq routing environment variables are not allowed: " + ", ".join(overrides))
    parsed = urlsplit(dsn)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise ValueError("PostgreSQL DSN must use postgres or postgresql scheme")
    from psycopg.conninfo import conninfo_to_dict
    try:
        params = conninfo_to_dict(dsn)
    except Exception as exc:
        raise ValueError("PostgreSQL DSN is invalid") from exc
    hosts = [host for host in str(params.get("host", "")).split(",") if host]
    if ("hostaddr" in params or "service" in params or "servicefile" in params
            or not hosts or any(host not in allowed_hosts for host in hosts)):
        raise ValueError("PostgreSQL target is not an approved local endpoint")
    if params.get("dbname") != database_name:
        raise ValueError(f"PostgreSQL database must be named {database_name}")


def validate_cluster_synthetic_postgres_dsn(dsn: str) -> None:
    """Accept only the dedicated synthetic namespace's TLS PostgreSQL service."""
    overrides = [name for name in _LIBPQ_ROUTING_ENV if os.environ.get(name)]
    if overrides:
        raise ValueError("libpq routing environment variables are not allowed: " + ", ".join(overrides))
    parsed = urlsplit(dsn)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise ValueError("PostgreSQL DSN must use postgres or postgresql scheme")
    from psycopg.conninfo import conninfo_to_dict
    try:
        params = conninfo_to_dict(dsn)
    except Exception as exc:
        raise ValueError("PostgreSQL DSN is invalid") from exc
    if ("hostaddr" in params or "service" in params or "servicefile" in params
            or params.get("host") != "postgres.ml-synthetic.svc.cluster.local"
            or params.get("dbname") != "greenguard_ml"
            or params.get("port", "5432") != "5432"
            or params.get("sslmode") != "verify-full"):
        raise ValueError("PostgreSQL target must be the verified-TLS greenguard_ml service in ml-synthetic")
    root_cert = params.get("sslrootcert") or os.environ.get("PGSSLROOTCERT", "")
    if not root_cert or not Path(root_cert).is_file():
        raise ValueError("cluster-synthetic PostgreSQL requires a mounted TLS root certificate")
