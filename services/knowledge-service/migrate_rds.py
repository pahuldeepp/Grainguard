"""Apply Knowledge owner migrations to only the declared disposable central RDS."""
from __future__ import annotations

import os
from pathlib import Path
import re
import stat
from urllib.parse import parse_qs, unquote, urlsplit

from migrate import MIGRATIONS


def validate_dsn(dsn: str, expected_host: str) -> None:
    parsed = urlsplit(dsn)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if (parsed.scheme not in {"postgres", "postgresql"}
            or not re.fullmatch(r"[a-zA-Z0-9.-]+\.rds\.amazonaws\.com", expected_host)
            or parsed.hostname != expected_host or parsed.port != 5432
            or unquote(parsed.username or "") != "knowledge_migrator"
            or unquote(parsed.path.removeprefix("/")) != "greenguard_knowledge"
            or not parsed.password or parsed.fragment
            or query.get("sslmode") != ["verify-full"]
            or query.get("sslrootcert") != ["/rds-ca/ca.pem"]
            or set(query) - {"sslmode", "sslrootcert", "connect_timeout"}
            or ("connect_timeout" in query and query["connect_timeout"] not in [[str(n)] for n in range(1, 11)])):
        raise ValueError("Knowledge migration DSN does not match the disposable RDS owner contract")


def main() -> None:
    path = os.environ.get("AI_MIGRATION_DATABASE_URL_FILE", "")
    if not path:
        raise SystemExit("AI_MIGRATION_DATABASE_URL_FILE is required")
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise SystemExit("migration DSN file must be a protected regular file")
    dsn = Path(path).read_text(encoding="utf-8").strip()
    host = os.environ.get("AI_RDS_HOST", "")
    try:
        validate_dsn(dsn, host)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    import psycopg

    paths = sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9][0-9][0-9]_*.up.sql"))
    if not paths:
        raise SystemExit("no versioned Knowledge migrations found")
    with psycopg.connect(dsn, connect_timeout=10) as connection:
        if connection.execute("SELECT current_database(),current_user").fetchone() != ("greenguard_knowledge", "knowledge_migrator"):
            raise SystemExit("migration connection identity mismatch")
        role = connection.execute("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user").fetchone()
        if role is None or any(role):
            raise SystemExit("Knowledge migration role must not be superuser or bypass RLS")
        for sql_path in paths:
            version = sql_path.name.removesuffix(".up.sql")
            with connection.transaction():
                connection.execute("SELECT pg_advisory_xact_lock(hashtext('greenguard.knowledge.migrations'))")
                connection.execute("CREATE TABLE IF NOT EXISTS knowledge_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())")
                if connection.execute("SELECT 1 FROM knowledge_schema_migrations WHERE version=%s", (version,)).fetchone():
                    continue
                connection.execute(sql_path.read_text(encoding="utf-8"), prepare=False)
                connection.execute("INSERT INTO knowledge_schema_migrations(version) VALUES (%s)", (version,))


if __name__ == "__main__":
    main()
