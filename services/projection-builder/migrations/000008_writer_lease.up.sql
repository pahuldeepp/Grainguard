-- One active writer per version. Row locks fence every effect transaction against
-- lease takeover and promotion. Expiry uses the database clock, not host clocks.
CREATE TABLE public.projection_writer_leases (
 tenant_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid
  CHECK (tenant_id = '00000000-0000-4000-8000-000000000001'::uuid),
 schema_name text NOT NULL CHECK (schema_name ~ '^read_v[1-9][0-9]{0,8}$'),
 holder uuid NOT NULL,
 epoch bigint NOT NULL CHECK (epoch > 0),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (tenant_id,schema_name)
);
ALTER TABLE public.projection_writer_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projection_writer_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.projection_writer_leases
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE(holder,epoch,expires_at) ON public.projection_writer_leases TO projection_app;
