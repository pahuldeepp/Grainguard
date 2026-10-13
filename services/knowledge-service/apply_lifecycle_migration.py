"""Apply only additive lifecycle migration 017 using a protected local DSN file.

Does not enqueue/process lifecycle work or modify any document content. Requires
all earlier repository migrations already recorded. Never prints credentials.
"""
import os
from pathlib import Path
import stat
import psycopg
from migrate import validate_local_dsn, MIGRATIONS


def main():
    path=os.environ.get('KNOWLEDGE_MIGRATION_DATABASE_URL_FILE')
    if not path:
        raise SystemExit('protected migration DSN file is required')
    info=os.stat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)&0o077:
        raise SystemExit('migration DSN file must be a protected regular file')
    dsn=Path(path).read_text(encoding='utf-8').strip()
    validate_local_dsn(dsn)
    version='000017_document_lifecycle'
    with psycopg.connect(dsn,connect_timeout=5) as connection:
        with connection.transaction():
            connection.execute("SELECT pg_advisory_xact_lock(hashtext('greenguard.knowledge.migrations'))")
            prior={row[0] for row in connection.execute('SELECT version FROM knowledge_schema_migrations')}
            required={p.name.removesuffix('.up.sql') for p in MIGRATIONS.glob('*.up.sql') if p.name<'000017'}
            if not required<=prior:
                raise SystemExit('earlier knowledge migrations must be applied first')
            if version in prior:
                print('lifecycle migration017 already applied; no document work performed')
                return
            connection.execute((MIGRATIONS/(version+'.up.sql')).read_text(encoding='utf-8'),prepare=False)
            connection.execute('INSERT INTO knowledge_schema_migrations(version) VALUES (%s)',(version,))
    print('lifecycle migration017 applied; no document work performed')


if __name__=='__main__':
    try:main()
    except Exception:
        raise SystemExit('lifecycle additive migration failed; inspect protected diagnostics') from None
