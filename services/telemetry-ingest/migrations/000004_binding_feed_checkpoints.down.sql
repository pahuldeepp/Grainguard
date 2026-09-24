-- Operational rollback requires stopping admission first: removing progress evidence
-- cannot make a stale binding safe. Normal deployments migrate forward.
DROP TABLE binding_feed_checkpoints;
