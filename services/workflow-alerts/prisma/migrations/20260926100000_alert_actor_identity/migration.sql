-- ADR-0024: preserve issuer for newly verified actors; legacy rows remain unresolved.
-- Identity columns commit with episode, transition and outbox in the existing lock/transaction.
ALTER TABLE alert_episodes ADD COLUMN acknowledged_by_issuer TEXT;
ALTER TABLE alert_transitions ADD COLUMN actor_issuer TEXT;
ALTER TABLE outbox_events ADD COLUMN actor_issuer TEXT;
GRANT UPDATE (acknowledged_by_issuer) ON alert_episodes TO alerts_app;
-- Existing forced RLS and tenant-composite FK remain in force.
CREATE INDEX alert_transitions_history_idx ON alert_transitions
  (tenant_id, episode_id, episode_version, occurred_at, transition_id);
