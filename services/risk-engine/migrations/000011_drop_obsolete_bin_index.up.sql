-- 000007 replaced the broad publication index with the current-bin/current-lot index.
-- Preserve applied checksums; remove obsolete write amplification with a forward step.
-- Deploy in the same measured maintenance window as the preceding migrations.
DROP INDEX risk_assessments_bin_publication_idx;
