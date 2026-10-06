-- Transport streams have independent offsets. Preserve prior canonical checkpoints
-- while requiring a new namespace to establish its own complete fresh barriers.
ALTER TABLE binding_feed_checkpoints ADD COLUMN transport_topic text NOT NULL
  DEFAULT 'greenguard.inventory.device.v1' CHECK (length(transport_topic) BETWEEN 1 AND 249);
ALTER TABLE binding_feed_checkpoints DROP CONSTRAINT binding_feed_checkpoints_pkey;
ALTER TABLE binding_feed_checkpoints ADD PRIMARY KEY (transport_topic, partition_id);
