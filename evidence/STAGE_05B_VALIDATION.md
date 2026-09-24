# Stage 05b validation — incomplete

Stage 05b is **not validated or promotable**. The bounded tenant replay writes to a separate `greenguard_read_replay_*` database. A `compare` command now independently folds the selected tenant's shadow inbox events and checks device fields, latest selections, stream frontiers and open gaps against the shadow projection. It requires zero lag at a captured Kafka frontier. This is a prerequisite check, not P06/X14 acceptance.

The required gate remains open: `read_v<N>` schemas and stable `read` views now
exist, and a gated atomic view-swap function has tests, but no production
verifier is wired to it. There is no comparison against an independently read
canonical source and the live projection at a common frontier, nor a post-swap
consumer proof. The live consumer still targets `public` in `greenguard_read`.
Canonical retention can remove offset zero; global replay refuses that
condition rather than claiming a complete rebuild.

The local `node --env-file=.env scripts/projection-replay-test.mjs` acceptance
passed on 2026-09-24 after `compare` was added to its real-Kafka/scratch-Postgres
path. This exercises a newly generated tenant at a captured frontier, crash and
resume, tenant isolation, and a clean shadow semantic comparison. It does not
prove a complete historical rebuild. No swap was executed. Do not mark Stage 05b
complete or use the current replay command to promote production reads.

Additional local acceptance on 2026-09-24: `make projection-replay` passed
`TestGlobalVersionedReplayFromZero` against a clean in-process Kafka broker and
a disposable `read_v<N>` schema in PostgreSQL, plus both existing live replay
tests. `PROJECTION_VIEW_TEST=1` passed the security-invoker view isolation test
against local PostgreSQL. These results prove the prerequisites only; no real
read-view promotion was executed.

The independent canonical comparison now checks semantic `reading_history`
rows (including source and binding identity, event times, measurements, and
enrichment) and notification identities, along with device views, latest
selections, streams, and open gaps. The reference fold derives these from Kafka
records without consulting the shadow inbox. `cd services/projection-builder &&
go test ./...` passed locally after this change. If read-side history retention
has removed older canonical readings, comparison fails closed.

The promotion gate remains closed. The current projector has no site/bin view
tables or hourly rollup to compare. `projection_app` cannot enumerate live-only
tenants through forced RLS. The verifier checks `public`, not the actual
`read.*` route after a prior promotion, and it does not hand a stable proof to
`PromoteReadViews` under its advisory lock. No live Kafka/PostgreSQL test ran
this expanded comparison, and no post-swap consumer proof exists. These are
required before calling P06/X14 complete or allowing a swap.

Further promotion work: `PromoteReadViews` now resolves every active `read.*`
view under its advisory lock and rejects mixed or unexpected routes. A
`CanonicalPromotionVerifier` can check a captured Kafka frontier, durable
shadow checkpoints, exact tenant census in active and shadow schemas, and
semantic equality inside the locked promotion transaction. The census uses
`row_security=off` so a role subject to forced RLS gets an error rather than a
partial tenant list. The verifier requires a privileged database role; it is
not exposed as an enabled production command. Local `go test ./...` passes
for this code, including mixed-route and extra-tenant rejection.

The promotion proof now requires `PostSwapConsumerReady`. The live consumer
currently writes `public`, so the canonical verifier deliberately leaves this
field false and cannot authorize a swap. A safe cutover needs a versioned
consumer that continues writing the promoted schema, a disposable database and
Kafka swap test with a new event after the switch, and a live operational
procedure. No shared read view was switched.

The normal service now accepts `PROJECTION_WRITE_SCHEMA=read_vN` only with the
restricted `projection_app` role against `greenguard_read`, checks forced RLS,
and resumes the global replay group. The disposable versioned replay test now
appends an event after the captured frontier, processes it through that same
group and the normal `Store.Apply` path, and finds the new history row in the
versioned schema. Run on 2026-09-24 with `node --env-file=.env` and
`go test -run '^TestGlobalVersionedReplayFromZero$' -count=1 -v ./...` from
`services/projection-builder`: PASS. The test never changed shared `read.*`
views. It proves continued writes, not a complete swap/post-swap gate;
`PostSwapConsumerReady` still remains false in the canonical verifier.

Promotion now also checks that `read.latest_readings` joins the active
version's inbox, and its single transaction grants the target schema/table
privileges to `read_query` and repoints that view to the target inbox alongside
the four existing read views. The migration 000007 definition was used without
editing the migration. A disposable PostgreSQL database test passed: the
restricted projection role could not enumerate tenants with `row_security=off`,
while the privileged transaction resolved the active route and found both
tenants. Promotion unit tests verify the fifth view and its target inbox route.
`cd services/projection-builder && go test ./...` passed after these changes.
This was the state before the lease and disposable cutover proof below.

## Versioned writer lease and disposable swap acceptance (2026-09-24)

Migration 000008 adds a public, forced-RLS lease table under the reserved
infrastructure tenant. Only `projection_app` can acquire/renew a versioned
writer lease; `read_query` receives no lease grants. Acquisition serializes with
finite replay, uses a random holder token and a monotone epoch, and takes over
only after PostgreSQL-clock expiry. Every versioned event and heartbeat locks
and checks the row inside its effect transaction. A stale holder cannot write or
renew. The continuous writer updates the global replay checkpoint and tenant
registry in the same transaction as each effect, including equal duplicate
deliveries and heartbeats. Collisions still fail closed.

`CanonicalPromotionVerifier` now requires the target lease under a row lock,
checks it again after the canonical scan, and requires at least five seconds of
remaining life before returning its post-swap consumer proof. The full
promotion function still checks source frontier, all tenants, live and shadow
semantic state, and lag under one transaction. A repeated canonical scan now
resumes partitions paused at the end of its previous scan.

Executed from `services/projection-builder` with the local `.env` loaded:
`go test ./...` passed. `TestWriterLeaseFencesStaleHolder` uses a fresh migrated
PostgreSQL database and proves concurrent acquisition refusal, epoch takeover,
stale renewal refusal and stale event write refusal. The disposable
`TestDisposablePromotionAndPostSwapEvent` uses a fresh PostgreSQL database and
in-process Kafka broker. It builds `read_v1`, promotes it, rebuilds `read_v2`
from retained canonical records, rejects a deliberately lagging v2 checkpoint,
then promotes v2 with the real canonical verifier. A new Kafka record is consumed
through the resumed v2 group, and `read.reading_history`, `read.device_latest`
and `read.latest_readings` show the new event through the v2 route. The test
does not modify the shared database's read views.

This establishes the disposable P06/X14 cutover path. A production swap command
and deployed operational cutover procedure are still absent, and no shared
read-view switch has been performed. The lease proves a recent, fenced writer;
it cannot guarantee a process will remain alive after the promotion transaction
commits. Stage 05b should remain open until its live deployment gate and
retention prerequisites are recorded.

## Projection review follow-up (2026-09-24)

CodeRabbit's scoped projection review identified five valid issues. The
canonical Kafka verifier now folds validated records into per-tenant projection
state as they arrive, retaining stream versions and inventory deltas rather than
all raw Kafka bodies. History comparison uses one PostgreSQL-clock cutoff with a
one-minute boundary margin on both the independent reference and SQL rows, so
retained but out-of-window rows do not falsely fail the comparison. This does
not change the tenant `compare` command's inbox collection path.

History maintenance accepts `PROJECTION_HISTORY_SCHEMA=read_vN` and invokes
that version's maintenance function; each provisioned version needs its own
scheduled maintenance job. Replay and writer admission now use a two-key
advisory lock scoped to the validated version number. Canonical promotion scans
and compares before locking the lease row, then locks it briefly and rechecks
the Kafka frontier, durable checkpoint and remaining lease time. Writer lease
checks and renewals have a two-second database lock timeout. A concurrent
update during the repeatable-read promotion transaction can abort promotion;
that is a safe retry, not a partial swap.

The local PostgreSQL-backed `go test ./...` passed after these fixes, including
new accumulator/cutoff, versioned maintenance and cross-version lock tests.
The earlier disposable v1→v2 test still passes with the real verifier and a
Kafka event visible through the promoted read views.
