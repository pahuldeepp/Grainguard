"""Explicit local-only migration preflight; does not provision credentials."""
import os
from pathlib import Path
from urllib.parse import urlsplit,parse_qs,unquote
import psycopg


def validate_dsn(dsn):
    value=urlsplit(dsn)
    if (value.scheme not in {'postgres','postgresql'} or value.hostname not in {'localhost','127.0.0.1','::1'}
            or unquote(value.path)!='/greenguard_advisor'
            or {'host','hostaddr','dbname','service','servicefile'} & parse_qs(value.query,keep_blank_values=True).keys()):
        raise ValueError('local Advisor database required')


def apply(connection):
    with connection.transaction():
        connection.execute("SELECT pg_advisory_xact_lock(hashtext('greenguard.advisor.security.migration'))")
        if connection.execute("SELECT current_user").fetchone()[0]=='advisor_app':
            raise ValueError('runtime role cannot own migrations')
        role=connection.execute("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='advisor_app'").fetchone()
        if role is None or any(role):raise ValueError('provision non-superuser NOBYPASSRLS advisor_app before migration')
        connection.execute('CREATE TABLE IF NOT EXISTS advisor_schema_migrations(version text PRIMARY KEY)')
        for version in ('000001_security','000002_execution','000003_execution_lease'):
            if connection.execute('SELECT 1 FROM advisor_schema_migrations WHERE version=%s',(version,)).fetchone():
                continue
            connection.execute((Path(__file__).parent/'migrations'/(version+'.up.sql')).read_text(),prepare=False)
            connection.execute('INSERT INTO advisor_schema_migrations VALUES(%s)',(version,))


def main():
    if os.environ.get('ADVISOR_ENVIRONMENT')!='local-synthetic':raise SystemExit('local-synthetic environment required')
    dsn=os.environ.get('ADVISOR_MIGRATION_DATABASE_URL','');validate_dsn(dsn)
    with psycopg.connect(dsn) as db:apply(db)

if __name__=='__main__':main()
