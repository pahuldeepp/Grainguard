"""Apply the shadow schema only to an explicitly local synthetic database."""

from __future__ import annotations

import os
from pathlib import Path
from ml_scoring.local_guard import validate_local_postgres_dsn

import psycopg


_MIGRATIONS = Path(__file__).parent / "migrations"


def main() -> None:
    if os.environ.get("ML_ENVIRONMENT") != "local-synthetic":
        raise SystemExit("refusing migration: set ML_ENVIRONMENT=local-synthetic")
    dsn = os.environ.get("ML_MIGRATION_DATABASE_URL", "")
    if not dsn:
        raise SystemExit("ML_MIGRATION_DATABASE_URL is required")
    try:
        validate_local_postgres_dsn(
            dsn, allowed_hosts={"localhost", "127.0.0.1", "::1"},
            database_name="greenguard_ml",
        )
    except ValueError as exc:
        raise SystemExit(f"refusing migration: {exc}") from exc

    migration_paths = sorted(_MIGRATIONS.glob("[0-9][0-9][0-9][0-9][0-9][0-9]_*.up.sql"))
    if not migration_paths:
        raise SystemExit("refusing migration: no versioned up migrations are present")
    with psycopg.connect(dsn, autocommit=False) as connection:
        for sql_path in migration_paths:
            migration_version = sql_path.name.removesuffix(".up.sql")
            migration_sql = sql_path.read_text(encoding="utf-8")
            with connection.transaction():
                connection.execute("SELECT pg_advisory_xact_lock(hashtext('greenguard.ml-scoring.migrations'))")
                connection.execute("CREATE TABLE IF NOT EXISTS ml_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())")
                found = connection.execute(
                    "SELECT 1 FROM ml_schema_migrations WHERE version=%s", (migration_version,),
                ).fetchone()
                if found:
                    print(f"{migration_version}: already applied")
                    continue
                connection.execute(migration_sql, prepare=False)
                connection.execute(
                    "INSERT INTO ml_schema_migrations (version) VALUES (%s)", (migration_version,),
                )
            print(f"{migration_version}: applied")


if __name__ == "__main__":
    main()
