-- Keep retention sweeps bounded and avoid scanning active conversation rows.
CREATE INDEX assistant_conversations_retention_idx
    ON assistant_conversations (tenant_id,user_id,deleted_at,conversation_id)
    WHERE deleted_at IS NOT NULL;
