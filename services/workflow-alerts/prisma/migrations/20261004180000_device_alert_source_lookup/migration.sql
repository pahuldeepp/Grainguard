-- Owner read only: associate an episode with the device that produced its current
-- assessment. This is source provenance, not a current device/bin binding proof.
CREATE INDEX consumer_inbox_assessment_source_device_idx
  ON consumer_inbox (tenant_id, consumer_name,
    (event->'payload'->>'assessment_id'), (event->'payload'->>'device_id'))
  WHERE event->>'event_type' = 'risk.assessed';
