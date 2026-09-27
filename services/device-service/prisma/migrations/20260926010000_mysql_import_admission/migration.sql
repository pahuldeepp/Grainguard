-- Durable last-coordinate fence. A transaction lock serializes one source entity
-- before this state and its canonical inventory/outbox/audit are updated.
CREATE TABLE inventory_import_state (
  tenant_id uuid NOT NULL,
  source_id text NOT NULL,
  entity_type text NOT NULL,
  external_id text NOT NULL,
  entity_id uuid NOT NULL,
  connector_generation text NOT NULL,
  topic text NOT NULL,
  partition_id integer NOT NULL,
  source_offset bigint NOT NULL,
  payload_sha256 text NOT NULL,
  response_body jsonb NOT NULL,
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT inventory_import_state_pkey PRIMARY KEY (tenant_id, source_id, entity_type, external_id),
  CONSTRAINT inventory_import_state_entity_key UNIQUE (tenant_id, entity_type, entity_id),
  CONSTRAINT inventory_import_state_type_check CHECK (entity_type IN ('site', 'bin', 'device')),
  CONSTRAINT inventory_import_state_coordinate_check CHECK (partition_id >= 0 AND source_offset >= 0),
  CONSTRAINT inventory_import_state_digest_check CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inventory_import_state_source_check CHECK (length(source_id) BETWEEN 1 AND 128),
  CONSTRAINT inventory_import_state_external_check CHECK (length(external_id) BETWEEN 1 AND 128),
  CONSTRAINT inventory_import_state_generation_check CHECK (length(connector_generation) BETWEEN 1 AND 128),
  CONSTRAINT inventory_import_state_topic_check CHECK (length(topic) BETWEEN 1 AND 512)
);
ALTER TABLE inventory_import_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_import_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_import_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON inventory_import_state TO inventory_app;
GRANT UPDATE (source_offset, payload_sha256, response_body, updated_at)
  ON inventory_import_state TO inventory_app;
