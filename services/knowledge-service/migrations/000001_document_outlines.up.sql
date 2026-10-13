-- I7 outline projection tied to canonical version and chunk rows.

CREATE TABLE knowledge_document_outlines (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_version bigint NOT NULL CHECK (document_version > 0),
    source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, document_id, document_version),
    FOREIGN KEY (tenant_id, document_id, document_version)
        REFERENCES knowledge_document_versions (tenant_id, document_id, document_version)
        ON DELETE CASCADE
);

CREATE TABLE knowledge_outline_nodes (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_version bigint NOT NULL,
    node_id uuid NOT NULL,
    parent_node_id uuid,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
    level smallint NOT NULL CHECK (level BETWEEN 0 AND 6),
    page_start integer NOT NULL CHECK (page_start > 0),
    page_end integer NOT NULL CHECK (page_end >= page_start),
    PRIMARY KEY (tenant_id, document_id, document_version, node_id),
    FOREIGN KEY (tenant_id, document_id, document_version)
        REFERENCES knowledge_document_outlines (tenant_id, document_id, document_version)
        ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, document_id, document_version, parent_node_id)
        REFERENCES knowledge_outline_nodes (tenant_id, document_id, document_version, node_id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX knowledge_outline_nodes_parent_ordinal_uq
    ON knowledge_outline_nodes (
        tenant_id, document_id, document_version,
        COALESCE(parent_node_id, '00000000-0000-0000-0000-000000000000'::uuid), ordinal
    );

CREATE TABLE knowledge_outline_chunks (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_version bigint NOT NULL,
    node_id uuid NOT NULL,
    chunk_id uuid NOT NULL,
    page_start integer NOT NULL CHECK (page_start > 0),
    page_end integer NOT NULL CHECK (page_end >= page_start),
    heading_path text[] NOT NULL CHECK (cardinality(heading_path) <= 16),
    PRIMARY KEY (tenant_id, document_id, document_version, chunk_id),
    FOREIGN KEY (tenant_id, document_id, document_version, chunk_id)
        REFERENCES knowledge_chunks (tenant_id, document_id, document_version, chunk_id)
        ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, document_id, document_version, node_id)
        REFERENCES knowledge_outline_nodes (tenant_id, document_id, document_version, node_id)
        ON DELETE CASCADE
);

CREATE INDEX knowledge_outline_nodes_parent_idx
    ON knowledge_outline_nodes (tenant_id, document_id, document_version, parent_node_id, ordinal);
CREATE INDEX knowledge_outline_nodes_title_fts_idx
    ON knowledge_outline_nodes USING gin (to_tsvector('simple', title));
CREATE INDEX knowledge_outline_chunks_node_idx
    ON knowledge_outline_chunks (tenant_id, document_id, document_version, node_id);

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'knowledge_document_outlines',
        'knowledge_outline_nodes',
        'knowledge_outline_chunks'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name
        );
    END LOOP;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON
            knowledge_document_outlines, knowledge_outline_nodes, knowledge_outline_chunks
            TO knowledge_app;
    END IF;
END $$;
