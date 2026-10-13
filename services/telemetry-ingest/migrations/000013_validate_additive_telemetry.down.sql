-- Validation is additive and remains in place on rollback. The 000012 down
-- migration refuses to remove immutable v2 data, including under forced RLS.
SELECT 1;
