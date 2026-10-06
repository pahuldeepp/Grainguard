-- Recover execution claims left by a crashed Advisor worker. The owner command
-- always receives the stable execution_idempotency_key, so reclaiming a lease
-- cannot apply the action twice.
ALTER TABLE action_proposals
  ADD COLUMN IF NOT EXISTS execution_claimed_at timestamptz;
GRANT UPDATE(execution_claimed_at) ON action_proposals TO advisor_app;
