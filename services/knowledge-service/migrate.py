"""Apply knowledge-service migrations only to the local disposable database."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


MIGRATIONS = Path(__file__).parent / "migrations"


def validate_local_dsn(dsn: str) -> None:
    parsed = urlsplit(dsn)
    database = unquote(parsed.path.removeprefix("/"))
    query = parse_qs(parsed.query, keep_blank_values=True)
    if (parsed.scheme not in {"postgres", "postgresql"}
            or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
            or database != "greenguard_knowledge"
            or {"host", "hostaddr", "dbname", "service", "servicefile"} & query.keys()):
        raise ValueError("only localhost database greenguard_knowledge is allowed")


def main() -> None:
    if os.environ.get("KNOWLEDGE_ENVIRONMENT") != "local-synthetic":
        raise SystemExit("refusing migration: set KNOWLEDGE_ENVIRONMENT=local-synthetic")
    dsn = os.environ.get("KNOWLEDGE_MIGRATION_DATABASE_URL", "")
    try:
        validate_local_dsn(dsn)
    except ValueError as exc:
        raise SystemExit(f"refusing migration: {exc}") from exc

    import psycopg

    migration_paths = sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9][0-9][0-9]_*.up.sql"))
    if not migration_paths:
        raise SystemExit("refusing migration: no versioned up migrations are present")
    with psycopg.connect(dsn, autocommit=False) as connection:
        for sql_path in migration_paths:
            version = sql_path.name.removesuffix(".up.sql")
            with connection.transaction():
                connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext('greenguard.knowledge.migrations'))"
                )
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS knowledge_schema_migrations "
                    "(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())"
                )
                if connection.execute(
                    "SELECT 1 FROM knowledge_schema_migrations WHERE version=%s", (version,),
                ).fetchone():
                    print(f"{version}: already applied")
                    continue
                connection.execute(sql_path.read_text(encoding="utf-8"), prepare=False)
                connection.execute(
                    "INSERT INTO knowledge_schema_migrations (version) VALUES (%s)", (version,),
                )
            print(f"{version}: applied")


if __name__ == "__main__":
    main()
