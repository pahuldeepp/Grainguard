-- The exporter runs as a separate process and receives no control API credential.
-- It can claim opaque work IDs, read tenant-scoped audit rows, and update only
-- the columns that implement its lease/retry/result state machine.
GRANT SELECT ON membership_events, audit_export_jobs, audit_export_actions
  TO control_audit_worker;
GRANT UPDATE (state, lease_until, attempts, next_attempt_at, failed_at,
              last_error, file_sha256, completed_at)
  ON audit_export_jobs TO control_audit_worker;
GRANT EXECUTE ON FUNCTION claim_audit_export_job() TO control_audit_worker;
