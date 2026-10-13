CREATE TABLE knowledge_graph_entities (
    tenant_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    entity_type text NOT NULL CHECK (entity_type IN
        ('grain','hazard','symptom','condition','measurement','practice')),
    normalized_label text NOT NULL CHECK (length(normalized_label) BETWEEN 1 AND 160),
    display_label text NOT NULL CHECK (length(display_label) BETWEEN 1 AND 160),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, entity_id),
    UNIQUE (tenant_id, entity_type, normalized_label)
);

CREATE INDEX knowledge_graph_entities_label_fts_idx
    ON knowledge_graph_entities USING gin (to_tsvector('simple', display_label));

CREATE TABLE knowledge_graph_facts (
    tenant_id uuid NOT NULL,
    fact_id char(64) NOT NULL CHECK (fact_id ~ '^[0-9a-f]{64}$'),
    source_entity_id uuid NOT NULL,
    predicate text NOT NULL CHECK (predicate IN
        ('has_hazard','indicated_by','occurs_under','measured_by','mitigated_by')),
    target_entity_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_version bigint NOT NULL CHECK (document_version > 0),
    chunk_id uuid NOT NULL,
    span_start integer NOT NULL CHECK (span_start >= 0),
    span_end integer NOT NULL CHECK (span_end > span_start),
    trust text NOT NULL CHECK (trust IN ('curated','licensed','tenant_uploaded')),
    status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','reviewed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, fact_id),
    FOREIGN KEY (tenant_id, source_entity_id)
        REFERENCES knowledge_graph_entities (tenant_id, entity_id),
    FOREIGN KEY (tenant_id, target_entity_id)
        REFERENCES knowledge_graph_entities (tenant_id, entity_id),
    FOREIGN KEY (tenant_id, document_id, document_version)
        REFERENCES knowledge_document_outlines (tenant_id, document_id, document_version)
        ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, document_id, document_version, chunk_id)
        REFERENCES knowledge_outline_chunks (tenant_id, document_id, document_version, chunk_id)
        ON DELETE CASCADE
);

CREATE INDEX knowledge_graph_facts_source_idx
    ON knowledge_graph_facts (tenant_id, source_entity_id, status, predicate);
CREATE INDEX knowledge_graph_facts_provenance_idx
    ON knowledge_graph_facts (tenant_id, document_id, document_version, chunk_id);

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['knowledge_graph_entities','knowledge_graph_facts'] LOOP
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
        GRANT SELECT, INSERT ON knowledge_graph_entities, knowledge_graph_facts TO knowledge_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_reviewer') THEN
        GRANT SELECT ON knowledge_graph_entities, knowledge_graph_facts TO knowledge_reviewer;
        GRANT UPDATE (status) ON knowledge_graph_facts TO knowledge_reviewer;
    END IF;
END $$;
