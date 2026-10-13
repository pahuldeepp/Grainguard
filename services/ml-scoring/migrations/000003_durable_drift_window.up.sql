-- Add an exact bounded PSI ring checkpoint to the aggregate drift row. Values
-- are fixed histogram-bin ordinals, not raw sensor measurements.
ALTER TABLE ml_drift_status
    ALTER COLUMN psi DROP NOT NULL,
    DROP CONSTRAINT ml_drift_status_psi_check,
    ADD CONSTRAINT ml_drift_status_psi_check
        CHECK (psi IS NULL OR (psi >= 0 AND psi < 'Infinity'::double precision)),
    DROP CONSTRAINT ml_drift_status_sample_count_check,
    ADD CONSTRAINT ml_drift_status_sample_count_check
        CHECK (sample_count BETWEEN 0 AND 100000),
    ADD COLUMN window_size integer CHECK (window_size BETWEEN 1 AND 100000),
    ADD COLUMN window_bins bytea CHECK (octet_length(window_bins) <= 200000 AND octet_length(window_bins) % 2 = 0),
    ADD COLUMN bin_counts integer[] CHECK (cardinality(bin_counts) BETWEEN 3 AND 1025),
    ADD COLUMN seen_count bigint CHECK (seen_count >= 0),
    ADD COLUMN last_update_count bigint CHECK (last_update_count >= 0),
    ADD COLUMN window_state_version integer CHECK (window_state_version = 1),
    ADD CONSTRAINT ml_drift_status_window_psi_check
        CHECK (psi IS NOT NULL OR window_bins IS NOT NULL),
    ADD CONSTRAINT ml_drift_status_window_size_pair_check
        CHECK ((window_bins IS NULL) = (window_size IS NULL)),
    ADD CONSTRAINT ml_drift_status_window_counts_pair_check
        CHECK ((window_bins IS NULL) = (bin_counts IS NULL)),
    ADD CONSTRAINT ml_drift_status_window_seen_pair_check
        CHECK ((window_bins IS NULL) = (seen_count IS NULL)),
    ADD CONSTRAINT ml_drift_status_window_update_pair_check
        CHECK ((window_bins IS NULL) = (last_update_count IS NULL)),
    ADD CONSTRAINT ml_drift_status_window_version_pair_check
        CHECK ((window_bins IS NULL) = (window_state_version IS NULL)),
    ADD CONSTRAINT ml_drift_status_window_update_order_check
        CHECK (last_update_count IS NULL OR last_update_count <= seen_count);

COMMENT ON TABLE ml_drift_status IS 'Per-tenant/model/feature PSI snapshots and bounded sliding-window bin ordinals; raw sensor measurements are never stored here.';
