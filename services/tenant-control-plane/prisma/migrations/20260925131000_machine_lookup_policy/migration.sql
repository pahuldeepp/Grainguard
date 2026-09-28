-- SECURITY DEFINER resolver functions execute as control_migrator. FORCE RLS still
-- applies to that role, so permit this narrowly trusted owner to resolve public
-- IDs before the caller opens a tenant-scoped transaction. control_app cannot use
-- this policy directly; it receives only the single tenant ID returned by a resolver.
CREATE POLICY credential_resolver ON api_keys FOR SELECT TO control_migrator USING (true);
CREATE POLICY credential_resolver ON service_principals FOR SELECT TO control_migrator USING (true);
