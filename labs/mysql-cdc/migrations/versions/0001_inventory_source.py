"""Partner inventory source v1: sites, bins and devices.

Revision ID: 0001_inventory_source
Revises:

This historical migration is frozen. Future source-model edits require a new
revision; importing current source_schema here would change v1 retrospectively.
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import CheckConstraint, Column, ForeignKeyConstraint, PrimaryKeyConstraint, String, UniqueConstraint

revision = "0001_inventory_source"
down_revision = None
branch_labels = None
depends_on = None


def identifier(name: str) -> Column[str]:
    return Column(name, String(128, collation="utf8mb4_bin"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "inventory_sites",
        identifier("tenant_key"), identifier("site_id"), Column("name", String(200), nullable=False),
        PrimaryKeyConstraint("tenant_key", "site_id"),
        CheckConstraint("char_length(name) BETWEEN 1 AND 200 AND name = TRIM(name) AND name NOT REGEXP '[[:cntrl:]]'", name="ck_sites_name"),
    )
    op.create_table(
        "inventory_bins",
        identifier("tenant_key"), identifier("bin_id"), identifier("site_id"),
        Column("name", String(200), nullable=False),
        PrimaryKeyConstraint("tenant_key", "bin_id"),
        UniqueConstraint("tenant_key", "site_id", "bin_id", name="uq_bins_tenant_site_bin"),
        ForeignKeyConstraint(["tenant_key", "site_id"], ["inventory_sites.tenant_key", "inventory_sites.site_id"],
                             name="fk_bins_site", ondelete="RESTRICT"),
        CheckConstraint("char_length(name) BETWEEN 1 AND 200 AND name = TRIM(name) AND name NOT REGEXP '[[:cntrl:]]'", name="ck_bins_name"),
    )
    op.create_table(
        "inventory_devices",
        identifier("tenant_key"), identifier("device_id"), identifier("site_id"),
        Column("bin_id", String(128, collation="utf8mb4_bin"), nullable=True),
        Column("serial_number", String(128), nullable=False),
        Column("status", String(16), nullable=False),
        PrimaryKeyConstraint("tenant_key", "device_id"),
        ForeignKeyConstraint(["tenant_key", "site_id"], ["inventory_sites.tenant_key", "inventory_sites.site_id"],
                             name="fk_devices_site", ondelete="RESTRICT"),
        ForeignKeyConstraint(["tenant_key", "site_id", "bin_id"],
                             ["inventory_bins.tenant_key", "inventory_bins.site_id", "inventory_bins.bin_id"],
                             name="fk_devices_bin", ondelete="RESTRICT"),
        CheckConstraint("char_length(serial_number) BETWEEN 1 AND 128 AND serial_number = TRIM(serial_number) AND serial_number NOT REGEXP '[[:cntrl:]]'", name="ck_devices_serial"),
        CheckConstraint("status IN ('active', 'disabled', 'deleted')", name="ck_devices_status"),
    )


def downgrade() -> None:
    for name in ("inventory_devices", "inventory_bins", "inventory_sites"):
        op.drop_table(name)
