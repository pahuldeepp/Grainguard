-- Stage 09a owner decision (ADR-0017): revocation is a state change, never a delete.
-- A revoked membership records when and by whom; version +1 and the membership.changed
-- outbox row commit in the same transaction. Forward-only (review O5).
ALTER TABLE "memberships" ADD COLUMN "revoked_at" TIMESTAMPTZ(6), ADD COLUMN "revoked_by" UUID;

-- Existing rows are rewritten by the owning migrator with RLS briefly not forced
-- (the migrator has no tenant context); FORCE is restored in the same transaction.
ALTER TABLE "memberships" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "membership_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_state_check";
UPDATE "memberships" SET "state" = 'revoked', "revoked_at" = "updated_at", "revoked_by" = "granted_by" WHERE "state" = 'removed';
ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_state_check" CHECK ("state" IN ('active', 'revoked')),
  ADD CONSTRAINT "memberships_revoked_check" CHECK (("state" = 'revoked') = ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL));
ALTER TABLE "membership_events" DROP CONSTRAINT "membership_events_action_check";
UPDATE "membership_events" SET "action" = 'revoked' WHERE "action" = 'removed';
ALTER TABLE "membership_events" ADD CONSTRAINT "membership_events_action_check"
  CHECK ("action" IN ('organization_created', 'invited', 'granted', 'accepted', 'role_changed', 'revoked'));
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "membership_events" FORCE ROW LEVEL SECURITY;

GRANT UPDATE ("revoked_at", "revoked_by") ON "memberships" TO control_app;
