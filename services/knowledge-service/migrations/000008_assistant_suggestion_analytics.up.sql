-- Relay bookkeeping for at-least-once Kafka publication.
ALTER TABLE assistant_suggestion_usage_outbox
    ADD COLUMN claim_token uuid,
    ADD COLUMN claimed_until timestamptz,
    ADD COLUMN published_at timestamptz,
    ADD CONSTRAINT assistant_suggestion_usage_claim_pair
        CHECK ((claim_token IS NULL) = (claimed_until IS NULL)),
    ADD CONSTRAINT assistant_suggestion_usage_published_unclaimed
        CHECK (published_at IS NULL OR claim_token IS NULL);
CREATE INDEX assistant_suggestion_usage_pending_idx
    ON assistant_suggestion_usage_outbox (tenant_id,created_at,event_id)
    WHERE published_at IS NULL;

-- Consumer deduplication ledger. Rows are the immutable source event shape and
-- are retained to make Kafka replay safe even after daily aggregate updates.
CREATE TABLE assistant_suggestion_usage_events (
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    suggestion_id text NOT NULL CHECK (suggestion_id IN
        ('grain_moisture','storage_checks','mold_risk','grain_drying','document_summary')),
    created_at timestamptz NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,event_id)
);

CREATE TABLE assistant_suggestion_usage_daily (
    tenant_id uuid NOT NULL,
    usage_date date NOT NULL,
    suggestion_id text NOT NULL CHECK (suggestion_id IN
        ('grain_moisture','storage_checks','mold_risk','grain_drying','document_summary')),
    usage_count bigint NOT NULL CHECK (usage_count > 0),
    last_used_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,usage_date,suggestion_id)
);

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'assistant_suggestion_usage_events',
        'assistant_suggestion_usage_daily'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',
            table_name
        );
        EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
    END LOOP;
END $$;
REVOKE ALL ON assistant_suggestion_usage_outbox FROM PUBLIC;

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
  GRANT SELECT,INSERT,UPDATE ON assistant_suggestion_usage_outbox TO knowledge_app;
  GRANT SELECT,INSERT ON assistant_suggestion_usage_events TO knowledge_app;
  GRANT SELECT,INSERT,UPDATE ON assistant_suggestion_usage_daily TO knowledge_app;
 END IF;
END $$;
