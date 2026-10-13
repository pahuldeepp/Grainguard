"""Apply the synthetic scorer schema to its dedicated cluster PostgreSQL.

This entry point deliberately has no local/production mode switch. It accepts
only the pinned `postgres.ml-synthetic` DNS name, verified TLS, and the
`greenguard_ml` database. The migration credential is external to this image.
"""

from __future__ import annotations

import os
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict


EXPECTED_HOST = "postgres.ml-synthetic.svc.cluster.local"
EXPECTED_DATABASE = "greenguard_ml"
EXPECTED_CERT = "/var/run/postgres-tls/root.crt"
FORBIDDEN_LIBPQ_ENV = (
    "PGHOST", "PGHOSTADDR", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE",
    "PGSSLMODE",
)
MIGRATIONS = Path(__file__).parent / "migrations"
RUNTIME_ROLE = "ml_app"
RUNTIME_GRANTS = (
    ("consumer_inbox", "SELECT, INSERT, DELETE"),
    ("bin_window_state", "SELECT, INSERT, UPDATE"),
    ("ml_shadow_predictions", "SELECT, INSERT, DELETE"),
    ("ml_shadow_outbox", "SELECT, INSERT, UPDATE, DELETE"),
    ("ml_drift_status", "SELECT, INSERT, UPDATE"),
    ("quarantine_samples", "SELECT, INSERT, UPDATE"),
)


def _validated_dsn(dsn: str) -> None:
    if any(os.environ.get(name) for name in FORBIDDEN_LIBPQ_ENV):
        raise ValueError("libpq environment overrides are not allowed")
    if os.environ.get("PGSSLROOTCERT", EXPECTED_CERT) != EXPECTED_CERT:
        raise ValueError("PGSSLROOTCERT must use the dedicated mounted CA")
    try:
        params = conninfo_to_dict(dsn)
    except Exception as exc:
        raise ValueError("migration DSN is invalid") from exc
    if (
        "hostaddr" in params
        or "service" in params
        or "servicefile" in params
        or params.get("host") != EXPECTED_HOST
        or params.get("dbname") != EXPECTED_DATABASE
        or params.get("port", "5432") != "5432"
        or params.get("sslmode") != "verify-full"
        or params.get("sslrootcert", EXPECTED_CERT) != EXPECTED_CERT
    ):
        raise ValueError(
            "migration target must be verified-TLS greenguard_ml on the "
            "dedicated postgres.ml-synthetic service"
        )
    if not Path(EXPECTED_CERT).is_file():
        raise ValueError("dedicated PostgreSQL CA certificate is not mounted")


def _apply_migrations(connection: psycopg.Connection) -> None:
    paths = sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9][0-9][0-9]_*.up.sql"))
    if not paths:
        raise RuntimeError("no versioned scorer migrations are present")

    for path in paths:
        version = path.name.removesuffix(".up.sql")
        with connection.transaction():
            connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext('greenguard.ml-scoring.migrations'))"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS ml_schema_migrations ("
                "version text PRIMARY KEY, applied_at timestamptz NOT NULL "
                "DEFAULT clock_timestamp())"
            )
            if connection.execute(
                "SELECT 1 FROM ml_schema_migrations WHERE version=%s", (version,)
            ).fetchone():
                continue
            connection.execute(path.read_text(encoding="utf-8"), prepare=False)
            connection.execute(
                "INSERT INTO ml_schema_migrations (version) VALUES (%s)", (version,)
            )
        print(f"{version}: applied")


def _grant_runtime_access(connection: psycopg.Connection) -> None:
    role = connection.execute(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=%s",
        (RUNTIME_ROLE,),
    ).fetchone()
    if role is None or role != (False, False):
        raise RuntimeError("ml_app must exist and be NOBYPASSRLS/non-superuser")
    connection.execute(
        sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
            sql.Identifier(EXPECTED_DATABASE), sql.Identifier(RUNTIME_ROLE)
        )
    )
    connection.execute(
        sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(
            sql.Identifier(RUNTIME_ROLE)
        )
    )
    for table, privileges in RUNTIME_GRANTS:
        connection.execute(
            sql.SQL("GRANT {} ON TABLE {} TO {}").format(
                sql.SQL(privileges), sql.Identifier(table), sql.Identifier(RUNTIME_ROLE)
            )
        )


def main() -> None:
    if os.environ.get("ML_ENVIRONMENT") != "cluster-synthetic":
        raise SystemExit("refusing migration: cluster-synthetic mode is required")
    dsn = os.environ.get("ML_MIGRATION_DATABASE_URL", "")
    if not dsn:
        raise SystemExit("ML_MIGRATION_DATABASE_URL is required")
    try:
        _validated_dsn(dsn)
    except ValueError as exc:
        raise SystemExit(f"refusing migration: {exc}") from exc

    with psycopg.connect(dsn, autocommit=True, connect_timeout=5) as connection:
        role = connection.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user"
        ).fetchone()
        if role != (False, False):
            raise RuntimeError("migration role must be NOBYPASSRLS/non-superuser")
        _apply_migrations(connection)
        _grant_runtime_access(connection)


if __name__ == "__main__":
    main()
