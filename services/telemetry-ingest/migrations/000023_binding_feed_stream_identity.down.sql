-- Refuse lossy rollback if more than the original stream exists.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM binding_feed_checkpoints WHERE transport_topic <> 'greenguard.inventory.device.v1') THEN
  RAISE EXCEPTION 'archive additional stream checkpoints before rollback';
 END IF;
END $$;
ALTER TABLE binding_feed_checkpoints DROP CONSTRAINT binding_feed_checkpoints_pkey;
ALTER TABLE binding_feed_checkpoints DROP COLUMN transport_topic;
ALTER TABLE binding_feed_checkpoints ADD PRIMARY KEY (partition_id);
