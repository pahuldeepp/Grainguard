CREATE TABLE knowledge_documents (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    current_version bigint NOT NULL DEFAULT 0 CHECK (current_version >= 0),
    latest_version bigint NOT NULL DEFAULT 0 CHECK (latest_version >= current_version),
    min_role text NOT NULL DEFAULT 'viewer' CHECK (min_role IN ('viewer','operator','admin')),
    trust text NOT NULL DEFAULT 'tenant_uploaded' CHECK (trust IN ('curated','licensed','tenant_uploaded')),
    acl_principals uuid[] NOT NULL DEFAULT '{}',
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, document_id)
);

CREATE TABLE knowledge_document_versions (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_version bigint NOT NULL CHECK (document_version > 0),
    source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    media_type text NOT NULL CHECK (media_type IN ('application/pdf')),
    source_object_key text,
    min_role text NOT NULL DEFAULT 'viewer' CHECK (min_role IN ('viewer','operator','admin')),
    acl_principals uuid[] NOT NULL DEFAULT '{}',
    processing_status text NOT NULL DEFAULT 'queued'
        CHECK (processing_status IN ('queued','parsed','ready','failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, document_id, document_version),
    FOREIGN KEY (tenant_id, document_id)
        REFERENCES knowledge_documents (tenant_id, document_id) ON DELETE CASCADE
);

CREATE TABLE knowledge_chunks (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_version bigint NOT NULL,
    chunk_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    content text NOT NULL CHECK (length(content) BETWEEN 1 AND 12000),
    content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    page_start integer NOT NULL CHECK (page_start > 0),
    page_end integer NOT NULL CHECK (page_end >= page_start),
    heading_path text[] NOT NULL DEFAULT '{}',
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, document_id, document_version, chunk_id),
    UNIQUE (tenant_id, document_id, document_version, ordinal),
    FOREIGN KEY (tenant_id, document_id, document_version)
        REFERENCES knowledge_document_versions (tenant_id, document_id, document_version)
        ON DELETE CASCADE
);

CREATE INDEX knowledge_chunks_fts_idx ON knowledge_chunks USING gin(search_vector);
CREATE INDEX knowledge_chunks_current_idx
    ON knowledge_chunks (tenant_id, document_id, document_version, ordinal);

CREATE TABLE knowledge_index_outbox (
    event_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_version bigint NOT NULL,
    chunk_ids uuid[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz,
    claim_token uuid,
    claimed_until timestamptz,
    published_at timestamptz,
    FOREIGN KEY (tenant_id, document_id, document_version)
        REFERENCES knowledge_document_versions (tenant_id, document_id, document_version)
        ON DELETE CASCADE
);

CREATE INDEX knowledge_index_outbox_pending_idx
    ON knowledge_index_outbox (tenant_id, created_at, event_id)
    WHERE published_at IS NULL;

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'knowledge_documents','knowledge_document_versions','knowledge_chunks',
        'knowledge_index_outbox'
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
            knowledge_documents, knowledge_document_versions, knowledge_chunks,
            knowledge_index_outbox TO knowledge_app;
    END IF;
END $$;
