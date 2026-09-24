# Stage 05e read access validation (2026-09-24)

Implemented `@greenguard/read-model` with typed device, latest, reading, history,
and freshness queries. `withReadTenant` uses a read-only transaction and a
transaction-local tenant setting; each SQL query filters on tenant ID. A separate
`read_query` role has SELECT only on the stable views and the underlying four
RLS tables required by security-invoker views. Its password differs from the
projection writer's password.

Local commands:

```bash
npm run test -w @greenguard/read-model
READ_MODEL_LIVE=1 node --env-file=.env --test packages/read-model/dist/index.test.js
```

Both passed. The live test inserted two tenant devices in a rollback transaction,
verified tenant A could see only its own device and reading through all six query
functions, checked a missing tenant context returned no row, and checked the role has no INSERT/UPDATE or checkpoint SELECT
privilege. A separate PgBouncer connection using `READ_QUERY_DATABASE_URL`
authenticated as `read_query`.

The GraphQL schema is a proposed contract for Stage 08; the BFF resolver and
unified Cassandra/search routing are later slices. Remote CI has not run because
the working tree has not been pushed.

A scoped CodeRabbit CLI review completed with two minor, valid findings. The
transaction helper now discards a pooled connection if rollback itself fails
while preserving the original error, and history queries reject invalid Date
values before reaching PostgreSQL. Unit and live read-role tests pass after
those fixes.

Review follow-up: migration 000007 adds `read.latest_readings`, an invoker-security
view that joins the RLS-protected latest pointer to the durable source event in
`consumer_inbox`. The read role receives only the inbox columns required by the
view and still has no checkpoint or write grant. The live test now removes a hot
history row inside its rollback transaction and verifies that latest reading
and measurements remain available, while direct history returns no row. `npm
run test -w @greenguard/read-model` and the live command above passed again.
