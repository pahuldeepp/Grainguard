-- Readers use stable, invoker-security views. Initial routing remains on public.
-- A future promotion replaces all views in one transaction after replay gates.
CREATE SCHEMA IF NOT EXISTS read;
REVOKE ALL ON SCHEMA read FROM PUBLIC;
GRANT USAGE ON SCHEMA read TO projection_app;

CREATE VIEW read.device_views WITH (security_invoker=true, security_barrier=true) AS
 SELECT * FROM public.device_views;
CREATE VIEW read.device_latest WITH (security_invoker=true, security_barrier=true) AS
 SELECT * FROM public.device_latest;
CREATE VIEW read.reading_history WITH (security_invoker=true, security_barrier=true) AS
 SELECT * FROM public.reading_history;
CREATE VIEW read.stream_gaps WITH (security_invoker=true, security_barrier=true) AS
 SELECT * FROM public.stream_gaps;

GRANT SELECT ON read.device_views, read.device_latest, read.reading_history,
 read.stream_gaps TO projection_app;
