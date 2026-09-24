-- Stage 06b: alert rules, episodes, source inbox, lifecycle audit, command receipts
-- and the CDC-ready lifecycle outbox, all owned by workflow-alerts (greenguard_alerts).
-- Forward-only (review O5): a failed deploy is fixed by a new migration.

-- Tenant-scoped rule configuration. The default policy (rule_key 'grain-risk-default',
-- open at score >= 40, resolve below 25, escalate after 15 minutes unacknowledged) is
-- seeded per tenant on that tenant's first risk event, with a rule_id derived from the
-- tenant so replays converge on the same row.
CREATE TABLE "alert_rules" (
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_key" TEXT NOT NULL,
    "resource_kind" TEXT NOT NULL,
    "open_score" INTEGER NOT NULL,
    "clear_score" INTEGER NOT NULL,
    "escalation_timeout_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("tenant_id", "rule_id"),
    CONSTRAINT "alert_rules_key_unique" UNIQUE ("tenant_id", "rule_key"),
    CONSTRAINT "alert_rules_resource_kind_check" CHECK ("resource_kind" IN ('bin')),
    -- Hysteresis: the clear threshold is strictly below the open threshold.
    CONSTRAINT "alert_rules_threshold_check" CHECK ("open_score" BETWEEN 1 AND 100 AND "clear_score" BETWEEN 0 AND 100 AND "clear_score" < "open_score"),
    CONSTRAINT "alert_rules_escalation_check" CHECK ("escalation_timeout_seconds" > 0)
);

-- CONCURRENCY (ADR-0002):
--  * Scoring: every risk event for one (tenant, rule, resource) first takes a
--    transaction-scoped advisory lock on that key (pessimistic), so two concurrent
--    scores serialize. The UNIQUE window key and the one-active partial index are the
--    database backstop: even without the lock only one episode can exist.
--  * Acknowledge vs escalate: both take SELECT ... FOR UPDATE on the episode row
--    (pessimistic, bounded by lock_timeout), then re-check state; the loser observes
--    the winner's committed state.
--  * API commands are optimistic on top: "version" is monotone (+1 per emitted
--    lifecycle event); acknowledge requires If-Match with the current version
--    (428 when missing, 412 when stale).
CREATE TABLE "alert_episodes" (
    "tenant_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "monitored_resource_id" UUID NOT NULL,
    "open_window_start" TIMESTAMPTZ(6) NOT NULL,
    "state" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "escalation_level" INTEGER NOT NULL DEFAULT 0,
    "escalated_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "alert_episodes_pkey" PRIMARY KEY ("tenant_id", "episode_id"),
    CONSTRAINT "alert_episodes_window_unique" UNIQUE ("tenant_id", "rule_id", "monitored_resource_id", "open_window_start"),
    CONSTRAINT "alert_episodes_rule_fkey" FOREIGN KEY ("tenant_id", "rule_id") REFERENCES "alert_rules"("tenant_id", "rule_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "alert_episodes_state_check" CHECK ("state" IN ('open', 'acknowledged', 'resolved')),
    CONSTRAINT "alert_episodes_severity_check" CHECK ("severity" IN ('warning', 'critical')),
    CONSTRAINT "alert_episodes_score_check" CHECK ("score" BETWEEN 0 AND 100),
    CONSTRAINT "alert_episodes_version_check" CHECK ("version" > 0),
    CONSTRAINT "alert_episodes_escalation_check" CHECK ("escalation_level" >= 0),
    CONSTRAINT "alert_episodes_ack_check" CHECK (("acknowledged_at" IS NULL) = ("acknowledged_by" IS NULL)),
    CONSTRAINT "alert_episodes_resolved_check" CHECK (("state" = 'resolved') = ("resolved_at" IS NOT NULL))
);
-- At most one unresolved episode per rule and resource.
CREATE UNIQUE INDEX "alert_episodes_one_active" ON "alert_episodes"("tenant_id", "rule_id", "monitored_resource_id") WHERE "state" <> 'resolved';
CREATE INDEX "alert_episodes_escalation_due" ON "alert_episodes"("tenant_id", "opened_at") WHERE "state" = 'open' AND "escalation_level" = 0;

-- Per device risk stream watermark: a risk.assessed event whose assessment_version is
-- not newer than the stored one is stale and cannot change an episode.
CREATE TABLE "risk_stream_positions" (
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "assessment_version" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "risk_stream_positions_pkey" PRIMARY KEY ("tenant_id", "device_id"),
    CONSTRAINT "risk_stream_positions_version_check" CHECK ("assessment_version" > 0)
);

-- Source inbox: the normalized event and the effect it produced, so a duplicate
-- delivery returns the original effect and a changed payload is detected.
CREATE TABLE "consumer_inbox" (
    "consumer_name" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event" JSONB NOT NULL,
    "effect" JSONB NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "consumer_inbox_pkey" PRIMARY KEY ("consumer_name", "tenant_id", "event_id")
);

-- Append-only audit of every lifecycle transition, including no-op receipts
-- (escalation_suppressed) that emit no event.
CREATE TABLE "alert_transitions" (
    "tenant_id" UUID NOT NULL,
    "transition_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "episode_version" BIGINT NOT NULL,
    "transition_type" TEXT NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "cause_id" UUID NOT NULL,
    "event_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "alert_transitions_pkey" PRIMARY KEY ("tenant_id", "transition_id"),
    CONSTRAINT "alert_transitions_episode_fkey" FOREIGN KEY ("tenant_id", "episode_id") REFERENCES "alert_episodes"("tenant_id", "episode_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "alert_transitions_type_check" CHECK ("transition_type" IN ('opened', 'updated', 'acknowledged', 'escalated', 'resolved', 'escalation_suppressed')),
    CONSTRAINT "alert_transitions_actor_check" CHECK ("actor_type" IN ('system', 'user')),
    CONSTRAINT "alert_transitions_event_check" CHECK (("transition_type" = 'escalation_suppressed') = ("event_id" IS NULL))
);
CREATE INDEX "alert_transitions_episode_idx" ON "alert_transitions"("tenant_id", "episode_id", "episode_version");

-- Idempotent acknowledge: one receipt per tenant, command type and Idempotency-Key.
CREATE TABLE "command_receipts" (
    "tenant_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "command_type" TEXT NOT NULL,
    "command_id" UUID NOT NULL,
    "normalized_request" JSONB NOT NULL,
    "response_body" JSONB NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "command_receipts_pkey" PRIMARY KEY ("tenant_id", "command_type", "idempotency_key"),
    CONSTRAINT "command_receipts_key_check" CHECK (length("idempotency_key") BETWEEN 1 AND 200)
);

-- Same shape as the inventory and telemetry outboxes; captured by CDC after commit.
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
    CONSTRAINT "outbox_events_aggregate_version_check" CHECK ("aggregate_version" > 0),
    CONSTRAINT "outbox_events_schema_version_check" CHECK ("schema_version" > 0)
);

-- Tenant isolation. FORCE applies the policies to the table owner as well; an unset
-- or empty tenant matches no rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alert_rules','alert_episodes','risk_stream_positions','consumer_inbox','alert_transitions','command_receipts','outbox_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- Runtime privileges: no DELETE anywhere; inbox, transitions, receipts and outbox are
-- append-only; only lifecycle columns of an episode are updatable.
GRANT SELECT, INSERT ON "alert_rules", "alert_episodes", "risk_stream_positions", "consumer_inbox", "alert_transitions", "command_receipts" TO alerts_app;
GRANT UPDATE ("state", "severity", "score", "version", "acknowledged_at", "acknowledged_by", "resolved_at", "escalation_level", "escalated_at", "updated_at") ON "alert_episodes" TO alerts_app;
GRANT UPDATE ("assessment_version", "updated_at") ON "risk_stream_positions" TO alerts_app;
GRANT INSERT ON "outbox_events" TO alerts_app;

-- R1/H2: CDC snapshot access is limited to the immutable outbox; runtime isolation
-- is unchanged. Executed by the owning migrator, never by the replication login.
GRANT USAGE ON SCHEMA public TO cdc_reader;
GRANT SELECT ON TABLE public.outbox_events TO cdc_reader;
CREATE POLICY cdc_outbox_snapshot ON public.outbox_events
  FOR SELECT TO cdc_reader USING (true);
CREATE PUBLICATION greenguard_alerts_outbox FOR TABLE public.outbox_events
  WITH (publish = 'insert');
