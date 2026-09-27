-- Only public projection notifications may carry a synthetic promotion
-- receipt. Shadow read_vN schemas retain the projection-builder-only check.
ALTER TABLE public.projection_notifications
 DROP CONSTRAINT projection_notifications_consumer_name_check;
ALTER TABLE public.projection_notifications
 ADD CONSTRAINT projection_notifications_consumer_name_check
 CHECK (consumer_name IN ('projection-builder','promotion'));
