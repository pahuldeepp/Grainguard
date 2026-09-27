-- Track which provisioning saga activated a device. Compensation may only
-- deactivate its own activation, including after a command redelivery.
ALTER TABLE devices ADD COLUMN active_saga_id uuid;
