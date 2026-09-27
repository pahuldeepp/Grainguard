-- A denied JIT user has no membership row, so membership_events.identity_id is
-- intentionally NULL for this one auditable security outcome. The event remains
-- in the existing tenant-scoped audit stream and is included in audit exports.
ALTER TABLE membership_events DROP CONSTRAINT IF EXISTS membership_events_action_check;
ALTER TABLE membership_events ADD CONSTRAINT membership_events_action_check
  CHECK (action IN ('organization_created', 'invited', 'granted', 'accepted',
                    'role_changed', 'revoked', 'jit_seat_limit_denied'));
ALTER TABLE membership_events ADD CONSTRAINT membership_events_jit_denial_target_check
  CHECK (action <> 'jit_seat_limit_denied' OR identity_id IS NULL);
