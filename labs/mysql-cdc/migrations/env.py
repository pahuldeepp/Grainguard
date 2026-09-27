"""Alembic environment for the isolated partner source schema."""
from __future__ import annotations

from logging.config import fileConfig
from pathlib import Path
import os
import sys

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from source_schema import metadata  # noqa: E402

config = context.config
if source_dsn := os.getenv("MYSQL_CDC_SOURCE_DSN"):
    config.set_main_option("sqlalchemy.url", source_dsn.replace("%", "%%"))
if config.config_file_name and config.get_section(config.config_ini_section, {}).get("loggers"):
    fileConfig(config.config_file_name)


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), target_metadata=metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    with engine_from_config(config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool).connect() as connection:
        context.configure(connection=connection, target_metadata=metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
