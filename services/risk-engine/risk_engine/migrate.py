"""Forward-only SQL migration runner: ``python -m risk_engine.migrate``.

Applies ``migrations/NNNNNN_name.up.sql`` in order, each in its own transaction,
under a session advisory lock. An applied file whose checksum changed, or two files
with the same version number, stop the run (review O5; GrainGuard duplicate-number
defect). Uses RISK_MIGRATION_URL (risk_migrator, the schema owner).
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
_NAME = re.compile(r"^(\d{6})_[a-z0-9_]+\.up\.sql$")
_LOCK_ID = 7240606


class MigrationError(RuntimeError):
    pass


def discover(directory: Path = MIGRATIONS) -> list[tuple[str, Path, str]]:
    found: dict[str, tuple[str, Path, str]] = {}
    for path in sorted(directory.glob("*.sql")):
        match = _NAME.match(path.name)
        if match is None:
            raise MigrationError(f"unexpected migration file name: {path.name}")
        version = match.group(1)
        if version in found:
            raise MigrationError(f"duplicate migration version {version}")
        found[version] = (version, path, hashlib.sha256(path.read_bytes()).hexdigest())
    return [found[key] for key in sorted(found)]


def _connect(url: str) -> Any:
    import psycopg

    return psycopg.connect(url, autocommit=True)


def migrate(url: str, directory: Path = MIGRATIONS, connect: Callable[[str], Any] = _connect) -> list[str]:
    plan = discover(directory)
    applied_now = []
    with connect(url) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (_LOCK_ID,))
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY,"
            " sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())")
        applied = dict(conn.execute("SELECT version, sha256 FROM schema_migrations").fetchall())
        for version, path, digest in plan:
            if version in applied:
                if applied[version] != digest:
                    raise MigrationError(f"applied migration {version} was modified")
                continue
            with conn.transaction():
                conn.execute(path.read_text(encoding="utf-8"))
                conn.execute("INSERT INTO schema_migrations (version, sha256) VALUES (%s, %s)",
                             (version, digest))
            applied_now.append(version)
        conn.execute("SELECT pg_advisory_unlock(%s)", (_LOCK_ID,))
    return applied_now


def main(getenv: Callable[[str], str | None] = os.environ.get,
         run: Callable[[str], list[str]] = migrate, out: Any = sys.stdout) -> int:
    url = getenv("RISK_MIGRATION_URL")
    if not url:
        print("RISK_MIGRATION_URL is required", file=out)
        return 2
    applied = run(url)
    print(f"risk migrations applied: {', '.join(applied) if applied else 'none (up to date)'}", file=out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
