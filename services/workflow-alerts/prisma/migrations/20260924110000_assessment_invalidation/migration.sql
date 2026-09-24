-- The current causal assessment is retained across acknowledgement and escalation.
-- An invalidation can resolve an episode only while that assessment remains current.
-- The tenant/rule/resource advisory lock serializes invalidation against new scores;
-- the episode row is also locked before a state transition.
ALTER TABLE alert_episodes ADD COLUMN current_assessment_id UUID;
CREATE INDEX alert_episodes_assessment_idx
  ON alert_episodes (tenant_id, current_assessment_id)
  WHERE current_assessment_id IS NOT NULL AND state <> 'resolved';
GRANT UPDATE (current_assessment_id) ON alert_episodes TO alerts_app;
