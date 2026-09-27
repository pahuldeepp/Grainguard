-- Stage 09d. Run as billing migrator, never through PgBouncer. The runtime role
-- billing_app and cdc_reader are provisioned by infra/compose/init-databases.sql.
-- Tenant tables are forced RLS plus application tenant filters. No runtime DELETE.

CREATE TABLE billing_catalog (
  plan_key text PRIMARY KEY,
  plan_version bigint NOT NULL CHECK (plan_version > 0),
  stripe_lookup_key text NOT NULL UNIQUE,
  limits jsonb NOT NULL,
  features jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE billing_customers (
  tenant_id uuid PRIMARY KEY,
  stripe_customer_id text NOT NULL UNIQUE,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A tenant has at most one current subscription. Stripe object timestamps and
-- event-created frontiers are guarded while holding this row FOR UPDATE. The local
-- version is incremented only with a substantive, newer remote state.
CREATE TABLE subscriptions (
  tenant_id uuid PRIMARY KEY,
  stripe_subscription_id text NOT NULL UNIQUE,
  stripe_customer_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('incomplete','trialing','active','past_due','unpaid','canceled')),
  plan_key text NOT NULL,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  stripe_object_created bigint NOT NULL,
  stripe_event_created bigint NOT NULL,
  stripe_state_hash text NOT NULL,
  entitlement_plan_key text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  grace_until timestamptz,
  pending_plan_key text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT subscription_period CHECK (current_period_start < current_period_end),
  CONSTRAINT subscription_customer FOREIGN KEY (tenant_id) REFERENCES billing_customers(tenant_id) ON DELETE RESTRICT
);

CREATE TABLE billing_commands (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create_customer','checkout','portal','meter_report')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','quarantined')),
  stripe_idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, command_id)
);
CREATE INDEX billing_commands_work ON billing_commands(status, created_at)
  WHERE status IN ('pending','running');

-- The tenant cannot be trusted at webhook receipt time. This separate schema is
-- the sole RLS exception; its payload is encrypted before insert. Processing
-- re-fetches remote objects and resolves tenant through billing_customers.
CREATE SCHEMA billing_inbox;
-- Restricted cross-tenant Stripe-customer lookup. Written in the same transaction
-- as the tenant-scoped customer row; processing re-checks that row under RLS.
CREATE TABLE billing_inbox.customer_directory (
  stripe_customer_id text PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE
);
CREATE TABLE billing_inbox.stripe_webhook_inbox (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  stripe_created bigint NOT NULL,
  tenant_id uuid,
  encrypted_payload bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','applied','quarantined')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX stripe_webhook_work ON billing_inbox.stripe_webhook_inbox(status, received_at)
  WHERE status IN ('pending','processing');
CREATE TABLE billing_inbox.webhook_redrive_audit (
  redrive_id uuid PRIMARY KEY,
  event_id text NOT NULL,
  tenant_id uuid,
  actor_id text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE webhook_applied_events (
  tenant_id uuid NOT NULL,
  event_id text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, event_id)
);

-- Deduplicate source events before incrementing hourly buckets. A row-level lock
-- on usage_periods is held for both ingestion and close, so a closing period
-- cannot lose an accepted event. Closed-period arrivals are carried forward.
CREATE TABLE usage_periods (
  tenant_id uuid NOT NULL,
  meter text NOT NULL CHECK (meter IN ('accepted_readings','active_devices')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','reported')),
  total bigint NOT NULL DEFAULT 0 CHECK (total >= 0),
  report_idempotency_key text NOT NULL UNIQUE,
  closed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, meter, period_start),
  CONSTRAINT usage_period_range CHECK (period_start < period_end)
);
CREATE TABLE usage_sources (
  tenant_id uuid NOT NULL,
  meter text NOT NULL,
  source_event_id uuid NOT NULL,
  source_period_start timestamptz NOT NULL,
  attributed_period_start timestamptz NOT NULL,
  bucket_hour timestamptz NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  late boolean NOT NULL DEFAULT false,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, meter, source_event_id)
);
CREATE TABLE usage_ledger (
  tenant_id uuid NOT NULL,
  meter text NOT NULL,
  period_start timestamptz NOT NULL,
  bucket_hour timestamptz NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, meter, period_start, bucket_hour),
  FOREIGN KEY (tenant_id, meter, period_start) REFERENCES usage_periods(tenant_id, meter, period_start)
);
CREATE TABLE usage_reports (
  tenant_id uuid NOT NULL,
  meter text NOT NULL,
  period_start timestamptz NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  identifier text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reported')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, meter, period_start),
  FOREIGN KEY (tenant_id, meter, period_start) REFERENCES usage_periods(tenant_id, meter, period_start)
);

CREATE TABLE invoice_mirrors (
  tenant_id uuid NOT NULL,
  invoice_id text NOT NULL,
  status text NOT NULL,
  amount_due bigint NOT NULL,
  currency text NOT NULL,
  stripe_event_created bigint NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, invoice_id)
);
CREATE TABLE dispute_mirrors (
  tenant_id uuid NOT NULL,
  dispute_id text NOT NULL,
  status text NOT NULL,
  amount bigint NOT NULL,
  currency text NOT NULL,
  stripe_event_created bigint NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, dispute_id)
);

CREATE TABLE reconciliation_runs (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id)
);
CREATE TABLE reconciliation_findings (
  tenant_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  run_id uuid NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  diff_class text NOT NULL,
  local_value jsonb NOT NULL,
  remote_value jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, finding_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES reconciliation_runs(tenant_id, run_id)
);

CREATE TABLE billing_audit_events (
  tenant_id uuid NOT NULL,
  audit_id uuid NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  object_id text NOT NULL,
  detail jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, audit_id)
);

-- Canonical CDC shape, one insert per externally visible state transition.
CREATE TABLE outbox_events (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid NOT NULL,
  traceparent text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_customers','subscriptions','billing_commands','webhook_applied_events','usage_periods',
    'usage_sources','usage_ledger','usage_reports','invoice_mirrors','dispute_mirrors',
    'reconciliation_runs','reconciliation_findings','billing_audit_events','outbox_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT ON billing_catalog TO billing_app;
GRANT SELECT, INSERT ON billing_customers, subscriptions, billing_commands,
  webhook_applied_events, usage_periods, usage_sources, usage_ledger, usage_reports, invoice_mirrors, dispute_mirrors,
  reconciliation_runs, reconciliation_findings TO billing_app;
GRANT UPDATE ON billing_customers, subscriptions, billing_commands, usage_periods,
  usage_ledger, usage_reports, invoice_mirrors, dispute_mirrors TO billing_app;
GRANT INSERT ON billing_audit_events, outbox_events TO billing_app;
GRANT USAGE ON SCHEMA billing_inbox TO billing_app;
GRANT SELECT, INSERT ON billing_inbox.customer_directory TO billing_app;
GRANT SELECT, INSERT, UPDATE ON billing_inbox.stripe_webhook_inbox TO billing_app;
GRANT INSERT ON billing_inbox.webhook_redrive_audit TO billing_app;

GRANT USAGE ON SCHEMA public TO cdc_reader;
GRANT SELECT ON outbox_events TO cdc_reader;
CREATE POLICY cdc_outbox_snapshot ON outbox_events FOR SELECT TO cdc_reader USING (true);
CREATE PUBLICATION greenguard_billing_outbox FOR TABLE outbox_events WITH (publish = 'insert');
