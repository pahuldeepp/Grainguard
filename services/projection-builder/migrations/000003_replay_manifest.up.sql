-- Shadow progress is bound to the original topic incarnation and hot window.
-- Unique keys serialize identity creation; identities are immutable to runtime.
CREATE TABLE projection_replay_manifest (
 tenant_id uuid NOT NULL, topic text NOT NULL, topic_id uuid NOT NULL,
 hot_window_seconds bigint NOT NULL CHECK(hot_window_seconds BETWEEN 3600 AND 7776000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,topic));
ALTER TABLE projection_replay_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_replay_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON projection_replay_manifest
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON projection_replay_manifest TO projection_app;
