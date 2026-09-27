-- Stage 09a (ADR-0017): tenant-control-plane owns greenguard_control and is the single
-- writer of organizations, memberships and invitations. Forward-only (review O5).

-- Placement columns follow PLATFORM_CONTRACTS_AND_OPERATIONS line 29 (D10: one home
-- region recorded now, single region implemented).
CREATE TABLE "organizations" (
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "home_region" TEXT NOT NULL DEFAULT 'local',
    "cell_id" TEXT NOT NULL DEFAULT 'local-1',
    "routing_epoch" BIGINT NOT NULL DEFAULT 1,
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "organizations_name_check" CHECK (length("name") BETWEEN 1 AND 200),
    CONSTRAINT "organizations_state_check" CHECK ("state" IN ('active', 'suspended', 'deleting')),
    CONSTRAINT "organizations_version_check" CHECK ("version" > 0 AND "routing_epoch" > 0)
);

-- Documented exception (ADR-0017): one person can belong to many tenants, so an
-- identity is not tenant-scoped. It holds only the IdP issuer and opaque subject,
-- with a deterministic identity_id; insert-only, no personal data.
CREATE TABLE "identities" (
    "identity_id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "identities_pkey" PRIMARY KEY ("identity_id"),
    CONSTRAINT "identities_issuer_subject_unique" UNIQUE ("issuer", "subject"),
    CONSTRAINT "identities_length_check" CHECK (length("issuer") BETWEEN 1 AND 512 AND length("subject") BETWEEN 1 AND 512)
);

-- CONCURRENCY (ADR-0002, ADR-0017):
--  * Every membership command first takes SELECT ... FOR UPDATE on the organization
--    row (pessimistic, bounded by lock_timeout). Lock order: organization, then
--    membership. This serializes last-admin checks and actor re-authorization.
--  * Membership edits are optimistic on top: "version" +1 per change, If-Match
--    required (428 missing, 412 stale). Rows are never deleted: state = 'removed'.
CREATE TABLE "memberships" (
    "tenant_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "version" BIGINT NOT NULL DEFAULT 1,
    "granted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "memberships_pkey" PRIMARY KEY ("tenant_id", "identity_id"),
    CONSTRAINT "memberships_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "memberships_identity_fkey" FOREIGN KEY ("identity_id") REFERENCES "identities"("identity_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    -- "device" is a credential role, never a human membership (plan 2.1).
    CONSTRAINT "memberships_role_check" CHECK ("role" IN ('viewer', 'operator', 'admin')),
    CONSTRAINT "memberships_state_check" CHECK ("state" IN ('active', 'removed')),
    CONSTRAINT "memberships_version_check" CHECK ("version" > 0)
);
CREATE INDEX "memberships_identity_idx" ON "memberships"("identity_id") WHERE "state" = 'active';

-- Single-use invitation: only the SHA-256 of the token and of the normalized email
-- are stored. Acceptance is one atomic UPDATE ... WHERE accepted_at IS NULL.
CREATE TABLE "invitations" (
    "tenant_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "email_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_digest" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_identity_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "invitations_pkey" PRIMARY KEY ("tenant_id", "invitation_id"),
    CONSTRAINT "invitations_token_digest_unique" UNIQUE ("token_digest"),
    CONSTRAINT "invitations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "invitations_accepted_identity_fkey" FOREIGN KEY ("accepted_identity_id") REFERENCES "identities"("identity_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "invitations_role_check" CHECK ("role" IN ('viewer', 'operator', 'admin')),
    CONSTRAINT "invitations_digest_check" CHECK ("token_digest" ~ '^[0-9a-f]{64}$' AND "email_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "invitations_accepted_check" CHECK (("accepted_at" IS NULL) = ("accepted_identity_id" IS NULL))
);

-- Append-only audit of every membership and organization change.
CREATE TABLE "membership_events" (
    "tenant_id" UUID NOT NULL,
    "audit_id" UUID NOT NULL,
    "identity_id" UUID,
    "action" TEXT NOT NULL,
    "actor_identity_id" UUID NOT NULL,
    "from_role" TEXT,
    "to_role" TEXT,
    "membership_version" BIGINT,
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "membership_events_pkey" PRIMARY KEY ("tenant_id", "audit_id"),
    CONSTRAINT "membership_events_member_fkey" FOREIGN KEY ("tenant_id", "identity_id") REFERENCES "memberships"("tenant_id", "identity_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "membership_events_action_check" CHECK ("action" IN ('organization_created', 'invited', 'granted', 'role_changed', 'removed'))
);

CREATE TABLE "command_receipts" (
    "tenant_id" UUID NOT NULL,
    "command_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "normalized_request" JSONB NOT NULL,
    "response_body" JSONB NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "command_receipts_pkey" PRIMARY KEY ("tenant_id", "command_type", "idempotency_key"),
    CONSTRAINT "command_receipts_key_check" CHECK (length("idempotency_key") BETWEEN 1 AND 200)
);

-- Same shape as the other outboxes; captured by CDC after commit (no direct publish).
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
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("event_id"),
    CONSTRAINT "outbox_events_aggregate_unique" UNIQUE ("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version"),
    CONSTRAINT "outbox_events_version_check" CHECK ("aggregate_version" > 0 AND "schema_version" > 0)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','memberships','invitations','membership_events','command_receipts','outbox_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- Membership lookup (verifiers map iss|sub to tenant): read-only and limited to the
-- one identity named by the transaction-local app.identity_id.
CREATE POLICY identity_lookup ON "memberships" FOR SELECT
  USING ("identity_id" = NULLIF(current_setting('app.identity_id', true), '')::uuid);

-- Runtime privileges: no DELETE or TRUNCATE; audit, receipts and outbox append-only.
GRANT SELECT, INSERT ON "organizations", "identities", "memberships", "invitations", "membership_events", "command_receipts" TO control_app;
GRANT UPDATE ("name", "state", "version", "updated_at") ON "organizations" TO control_app;
GRANT UPDATE ("role", "state", "version", "granted_by", "updated_at") ON "memberships" TO control_app;
GRANT UPDATE ("accepted_at", "accepted_identity_id") ON "invitations" TO control_app;
GRANT INSERT ON "outbox_events" TO control_app;

-- R1/H2: CDC snapshot access is limited to the immutable outbox. The Debezium
-- connector itself is not registered in 09a (plan R-c: wait for H3 WAL alerts).
GRANT USAGE ON SCHEMA public TO cdc_reader;
GRANT SELECT ON TABLE public.outbox_events TO cdc_reader;
CREATE POLICY cdc_outbox_snapshot ON public.outbox_events
  FOR SELECT TO cdc_reader USING (true);
CREATE PUBLICATION greenguard_control_outbox FOR TABLE public.outbox_events
  WITH (publish = 'insert');
