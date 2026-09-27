-- Lookup returns revoked memberships as well as active memberships. The original
-- partial index excluded revoked rows, so replace it with an identity-wide index.
DROP INDEX "memberships_identity_idx";
CREATE INDEX "memberships_identity_idx" ON "memberships" ("identity_id");
