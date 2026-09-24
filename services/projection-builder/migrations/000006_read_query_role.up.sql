-- The BFF receives SELECT on stable read views only. Underlying base-table
-- SELECT is required by security_invoker views; no write or checkpoint grants.
GRANT USAGE ON SCHEMA read, public TO read_query;
GRANT SELECT ON read.device_views, read.device_latest, read.reading_history,
 read.stream_gaps TO read_query;
GRANT SELECT ON public.device_views, public.device_latest,
 public.reading_history, public.stream_gaps TO read_query;
