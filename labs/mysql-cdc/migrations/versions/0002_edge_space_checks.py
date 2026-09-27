"""Reject trailing ASCII spaces even under MySQL's pad-space comparisons.

Revision ID: 0002_edge_space_checks
Revises: 0001_inventory_source
"""
from __future__ import annotations

from alembic import op

revision = "0002_edge_space_checks"
down_revision = "0001_inventory_source"
branch_labels = None
depends_on = None


CHECKS = (
    ("inventory_sites", "ck_sites_name", "name", 200),
    ("inventory_bins", "ck_bins_name", "name", 200),
    ("inventory_devices", "ck_devices_serial", "serial_number", 128),
)


def check_sql(column: str, maximum: int, *, strict: bool) -> str:
    edge = (f"char_length({column}) = char_length(TRIM({column}))" if strict
            else f"{column} = TRIM({column})")
    return (f"char_length({column}) BETWEEN 1 AND {maximum} AND {edge} "
            f"AND {column} NOT REGEXP '[[:cntrl:]]'")


def upgrade() -> None:
    for table, name, column, maximum in CHECKS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, check_sql(column, maximum, strict=True))


def downgrade() -> None:
    for table, name, column, maximum in reversed(CHECKS):
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, check_sql(column, maximum, strict=False))
