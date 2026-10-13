-- Temporary owner/provider outages must not permanently fail valid documents.
ALTER TABLE knowledge_index_outbox ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX knowledge_index_retry_due_idx ON knowledge_index_outbox(tenant_id,available_at,event_id)
 WHERE published_at IS NULL AND processed_at IS NULL;
