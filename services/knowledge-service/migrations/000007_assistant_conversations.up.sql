-- Durable, per-principal assistant history. RLS requires both trusted settings.
CREATE TABLE assistant_conversations (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    title text NOT NULL DEFAULT 'New chat' CHECK (length(title) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_message_at timestamptz,
    deleted_at timestamptz,
    PRIMARY KEY (tenant_id,user_id,conversation_id),
    CHECK (last_message_at IS NULL OR last_message_at >= created_at)
);

CREATE INDEX assistant_conversations_recent_idx
    ON assistant_conversations (tenant_id,user_id,last_message_at DESC NULLS LAST,updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE assistant_messages (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('user','assistant')),
    content text NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
    model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128),
    token_count integer CHECK (token_count IS NULL OR token_count >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,user_id,conversation_id,message_id),
    FOREIGN KEY (tenant_id,user_id,conversation_id)
        REFERENCES assistant_conversations (tenant_id,user_id,conversation_id) ON DELETE CASCADE
);

CREATE INDEX assistant_messages_order_idx
    ON assistant_messages (tenant_id,user_id,conversation_id,created_at,message_id);

CREATE TABLE assistant_message_citations (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    citation_ordinal smallint NOT NULL CHECK (citation_ordinal >= 0),
    document_id uuid NOT NULL,
    document_version bigint NOT NULL CHECK (document_version > 0),
    chunk_id uuid NOT NULL,
    page_start integer NOT NULL CHECK (page_start > 0),
    page_end integer NOT NULL CHECK (page_end >= page_start),
    heading_path text[] NOT NULL DEFAULT '{}',
    trust text NOT NULL CHECK (trust IN ('curated','licensed','tenant_uploaded')),
    PRIMARY KEY (tenant_id,user_id,conversation_id,message_id,citation_ordinal),
    FOREIGN KEY (tenant_id,user_id,conversation_id,message_id)
        REFERENCES assistant_messages (tenant_id,user_id,conversation_id,message_id) ON DELETE CASCADE
);

CREATE INDEX assistant_citations_document_idx
    ON assistant_message_citations (tenant_id,document_id,document_version,chunk_id);

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'assistant_conversations','assistant_messages','assistant_message_citations'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
        EXECUTE format(
            'CREATE POLICY principal_isolation ON %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid AND user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid AND user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',
            table_name
        );
        EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
    END LOOP;
END $$;

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON assistant_conversations TO knowledge_app;
  GRANT SELECT,INSERT ON assistant_messages,assistant_message_citations TO knowledge_app;
 END IF;
END $$;
