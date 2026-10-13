"""Provision LangGraph checkpoint tables using a schema-owner DSN."""
import os
import re

from agent_workflow import postgres_checkpointer
import psycopg
from psycopg import sql


def main():
    dsn = os.environ.get("ADVISOR_WORKFLOW_MIGRATION_DATABASE_URL")
    if not dsn:
        raise SystemExit("ADVISOR_WORKFLOW_MIGRATION_DATABASE_URL is required")
    with postgres_checkpointer(dsn, setup=True):
        pass
    runtime_role = os.environ.get("ADVISOR_WORKFLOW_RUNTIME_ROLE", "").strip()
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", runtime_role):
        raise SystemExit("ADVISOR_WORKFLOW_RUNTIME_ROLE must name a provisioned PostgreSQL role")
    with psycopg.connect(dsn) as connection:
        schema = connection.execute("SELECT current_schema()").fetchone()[0]
        if not schema:
            raise SystemExit("checkpoint setup schema could not be resolved")
        connection.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}")
                           .format(sql.Identifier(schema), sql.Identifier(runtime_role)))
        for table in ("checkpoints", "checkpoint_blobs", "checkpoint_writes"):
            connection.execute(sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {}.{} TO {}")
                               .format(sql.Identifier(schema), sql.Identifier(table), sql.Identifier(runtime_role)))
        connection.execute(sql.SQL("GRANT SELECT ON TABLE {}.checkpoint_migrations TO {}")
                           .format(sql.Identifier(schema), sql.Identifier(runtime_role)))
    print("ADVISOR_WORKFLOW_CHECKPOINT_SCHEMA_READY")


if __name__ == "__main__":
    main()
