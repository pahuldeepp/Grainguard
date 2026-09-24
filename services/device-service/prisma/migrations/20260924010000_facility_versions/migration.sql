-- H6: optimistic concurrency for low-contention facility edits (ADR-0002).
-- Creation starts at version 1; future edits must compare and increment version.
-- Existing forced RLS, tenant policies and composite foreign keys remain intact.
ALTER TABLE sites ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT sites_version_positive CHECK (version > 0);
ALTER TABLE bins ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT bins_version_positive CHECK (version > 0);
GRANT UPDATE (version) ON sites, bins TO inventory_app;
