ALTER TABLE knowledge_document_versions ADD COLUMN source_file_name text
    CHECK (source_file_name IS NULL OR length(source_file_name) BETWEEN 1 AND 240);
