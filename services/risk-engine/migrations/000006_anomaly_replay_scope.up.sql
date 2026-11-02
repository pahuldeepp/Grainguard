-- Forward-only: preserve receipts written before anomaly deduplication was scoped
-- independently of the Kafka group. The migration runner owns one transaction;
-- ALTER locks keep runtime access blocked until FORCE RLS is restored at commit.
ALTER TABLE consumer_inbox NO FORCE ROW LEVEL SECURITY;
ALTER TABLE anomaly_decisions NO FORCE ROW LEVEL SECURITY;
INSERT INTO consumer_inbox (consumer_name, tenant_id, event_id, event_type,
    source_topic, source_partition, source_offset, event_sha256, event, processed_at)
SELECT DISTINCT ON (i.tenant_id, i.event_id) 'risk-engine.anomaly.v1',
    i.tenant_id, i.event_id, i.event_type, i.source_topic, i.source_partition,
    i.source_offset, i.event_sha256, i.event, i.processed_at
FROM consumer_inbox i JOIN anomaly_decisions d
    ON d.tenant_id = i.tenant_id AND d.anomaly_event_id = i.event_id
WHERE i.event_type = 'telemetry.anomaly'
ORDER BY i.tenant_id, i.event_id, i.processed_at, i.consumer_name
ON CONFLICT DO NOTHING;
ALTER TABLE consumer_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE anomaly_decisions FORCE ROW LEVEL SECURITY;

CREATE INDEX risk_assessments_bin_publication_idx
    ON risk_assessments (tenant_id, bin_id, device_id, aggregate_version DESC);
