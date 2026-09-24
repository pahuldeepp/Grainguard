# Read model access (Stage 05e)

`withReadTenant` opens a read-only transaction and sets `app.tenant_id` with
transaction scope, so PgBouncer transaction pooling cannot leak tenant context.
Use only `READ_QUERY_DATABASE_URL` (role `read_query`) for this package. Every
query supplies its own `tenant_id` predicate in addition to PostgreSQL RLS.
`getLatestReading` reads `read.latest_readings`, which reconstructs the selected
reading from the durable inbox after its hot-history partition expires. Its
`inventory_enrichment` is `source` when the hot row is gone.

The package reads stable `read.*` views. Stage 05b may atomically repoint those
views to a rebuilt projection version. It does not query Cassandra or the search
index; those routes belong to the later unified Read API.

`npm run test -w @greenguard/read-model` runs unit tests. Set `READ_MODEL_LIVE=1`
and `POSTGRES_ADMIN_URL` to run the role/RLS acceptance test against the local
read database after migrations.
