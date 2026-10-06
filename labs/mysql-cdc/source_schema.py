"""Version-one partner MySQL source schema for inventory snapshot and CDC.

These tables are deliberately separate from GreenGuard's canonical PostgreSQL
tables. Every identity and reference includes the partner tenant key.
"""
from __future__ import annotations

from sqlalchemy import CheckConstraint, Column, ForeignKeyConstraint, MetaData, PrimaryKeyConstraint, String, Table, UniqueConstraint

metadata = MetaData()


def identifier(name: str) -> Column[str]:
    return Column(name, String(128, collation="utf8mb4_bin"), nullable=False)


inventory_sites = Table(
    "inventory_sites", metadata,
    identifier("tenant_key"), identifier("site_id"), Column("name", String(200), nullable=False),
    PrimaryKeyConstraint("tenant_key", "site_id"),
    CheckConstraint("char_length(name) BETWEEN 1 AND 200 AND char_length(name) = char_length(TRIM(name)) AND name NOT REGEXP '[[:cntrl:]]'", name="ck_sites_name"),
)

inventory_bins = Table(
    "inventory_bins", metadata,
    identifier("tenant_key"), identifier("bin_id"), identifier("site_id"),
    Column("name", String(200), nullable=False),
    PrimaryKeyConstraint("tenant_key", "bin_id"),
    UniqueConstraint("tenant_key", "site_id", "bin_id", name="uq_bins_tenant_site_bin"),
    ForeignKeyConstraint(["tenant_key", "site_id"], ["inventory_sites.tenant_key", "inventory_sites.site_id"], name="fk_bins_site", ondelete="RESTRICT"),
    CheckConstraint("char_length(name) BETWEEN 1 AND 200 AND char_length(name) = char_length(TRIM(name)) AND name NOT REGEXP '[[:cntrl:]]'", name="ck_bins_name"),
)

inventory_devices = Table(
    "inventory_devices", metadata,
    identifier("tenant_key"), identifier("device_id"), identifier("site_id"),
    Column("bin_id", String(128, collation="utf8mb4_bin"), nullable=True),
    Column("serial_number", String(128), nullable=False),
    Column("status", String(16), nullable=False),
    PrimaryKeyConstraint("tenant_key", "device_id"),
    ForeignKeyConstraint(["tenant_key", "site_id"], ["inventory_sites.tenant_key", "inventory_sites.site_id"], name="fk_devices_site", ondelete="RESTRICT"),
    ForeignKeyConstraint(["tenant_key", "site_id", "bin_id"], ["inventory_bins.tenant_key", "inventory_bins.site_id", "inventory_bins.bin_id"], name="fk_devices_bin", ondelete="RESTRICT"),
    CheckConstraint("char_length(serial_number) BETWEEN 1 AND 128 AND char_length(serial_number) = char_length(TRIM(serial_number)) AND serial_number NOT REGEXP '[[:cntrl:]]'", name="ck_devices_serial"),
    CheckConstraint("status IN ('active', 'disabled', 'deleted')", name="ck_devices_status"),
)
