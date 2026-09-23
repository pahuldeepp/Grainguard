-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "tenants" (
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "sites" (
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("tenant_id","site_id")
);

-- CreateTable
CREATE TABLE "bins" (
    "tenant_id" UUID NOT NULL,
    "bin_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bins_pkey" PRIMARY KEY ("tenant_id","bin_id")
);

-- CreateTable
CREATE TABLE "devices" (
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "bin_id" UUID,
    "serial_number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "binding_version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("tenant_id","device_id")
);

-- CreateTable
CREATE TABLE "command_receipts" (
    "tenant_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "command_type" TEXT NOT NULL,
    "command_id" UUID NOT NULL,
    "normalized_request" JSONB NOT NULL,
    "response_body" JSONB NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "command_receipts_pkey" PRIMARY KEY ("tenant_id","command_type","idempotency_key")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "event_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" BIGINT NOT NULL,
    "event_type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "correlation_id" UUID NOT NULL,
    "causation_id" UUID NOT NULL,
    "traceparent" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "audit_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "command_id" UUID NOT NULL,
    "event_id" UUID,
    "outcome" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("audit_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bins_tenant_id_site_id_bin_id_key" ON "bins"("tenant_id", "site_id", "bin_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_tenant_id_serial_number_key" ON "devices"("tenant_id", "serial_number");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_tenant_id_aggregate_type_aggregate_id_aggrega_key" ON "outbox_events"("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_resource_type_resource_id_idx" ON "audit_events"("tenant_id", "resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bins" ADD CONSTRAINT "bins_tenant_id_site_id_fkey" FOREIGN KEY ("tenant_id", "site_id") REFERENCES "sites"("tenant_id", "site_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_site_id_fkey" FOREIGN KEY ("tenant_id", "site_id") REFERENCES "sites"("tenant_id", "site_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_site_id_bin_id_fkey" FOREIGN KEY ("tenant_id", "site_id", "bin_id") REFERENCES "bins"("tenant_id", "site_id", "bin_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written below: constraints, tenant isolation and privileges that the
-- Prisma schema cannot express. See docs/FIRST_VERTICAL_SLICE.md section 4.
-- ---------------------------------------------------------------------------

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_status_check" CHECK ("status" IN ('active', 'disabled', 'deleted')),
  ADD CONSTRAINT "devices_binding_version_check" CHECK ("binding_version" > 0),
  ADD CONSTRAINT "devices_serial_number_check" CHECK (length("serial_number") BETWEEN 1 AND 128);
ALTER TABLE "command_receipts"
  ADD CONSTRAINT "command_receipts_key_check" CHECK (length("idempotency_key") BETWEEN 1 AND 200);
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_aggregate_version_check" CHECK ("aggregate_version" > 0),
  ADD CONSTRAINT "outbox_events_schema_version_check" CHECK ("schema_version" > 0);
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_outcome_check" CHECK ("outcome" IN ('succeeded', 'rejected'));

-- Tenant isolation. FORCE applies the policies to the table owner as well.
-- NULLIF: a transaction-local setting reads back as '' after its transaction ends,
-- and an unset or empty tenant must match no rows rather than raise an error.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','sites','bins','devices','command_receipts','outbox_events','audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- Runtime privileges: no DELETE anywhere; identity columns are never updatable;
-- receipts, outbox and audit are append-only.
GRANT SELECT, INSERT ON "tenants" TO inventory_app;
GRANT SELECT, INSERT ON "sites", "bins", "devices" TO inventory_app;
GRANT UPDATE ("name") ON "sites", "bins" TO inventory_app;
GRANT UPDATE ("site_id", "bin_id", "status", "binding_version", "updated_at") ON "devices" TO inventory_app;
GRANT SELECT, INSERT ON "command_receipts" TO inventory_app;
GRANT INSERT ON "outbox_events", "audit_events" TO inventory_app;
