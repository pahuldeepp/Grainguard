# ADR-0011: Retention of the read-side telemetry history

Status: Proposed
Date: 2026-09-24

## Context

`reading_history` in `greenguard_read` is a rebuildable projection, not the source
telemetry ledger. Retaining it forever duplicates cold history and makes the hot
read database unbounded. The owner requested daily partitions and a configurable
hot window. This decision supersedes the unconditional "all accepted readings
remain in history" rule for this read-side table only.

## Decision

Partition `reading_history` daily by `observed_at`, using UTC half-open bounds.
Its primary key is `(tenant_id, observed_at, reading_id)`. Remove history-level
uniqueness on event/version identities that cannot span partitions. The durable
`consumer_inbox` primary key provides semantic event idempotency. Inbox unique
indexes also preserve telemetry reading identity and device stream-version
identity across partition drops.

`PROJECTION_HISTORY_HOT_WINDOW` is a Go duration, default `24h`, minimum `1h`.
Bound it to `2160h` (90 days) so each maintenance pass has bounded creation work.
`PROJECTION_HISTORY_AHEAD_DAYS` defaults to `3`, with bounds 1–30. Drop a partition
only if its upper bound is at or before database time minus the hot window minus
a fixed **one-hour safety margin**. Daily granularity can retain nearly an extra
day beyond that margin. Drop at most 32 expired partitions per pass.

Run `cmd/maintain` once before consumers start, then schedule it every ten minutes
using the direct `PROJECTION_MIGRATION_URL` as `projection_migrator`. Each pass
has a 30-second context, a 25-second SQL statement timeout and two-second lock
wait. Run it as a separate process/job; consumer processes never need migrator
credentials. Alert on nonzero job exit. A missed partition is SQLSTATE `55000`, a
hard consumer error with the offset uncommitted, not a poison-data quarantine.
No runtime DDL, maintenance-function execution or DELETE privilege is granted.

Maintenance takes exclusive transaction advisory lock `7240511` before computing
the boundary or changing partitions. Writers take the shared form after inbox
identity insertion and before stream/latest locks or history admission. Admission
uses database `statement_timestamp()` after acquiring the lock. This prevents a
partition drop racing an admitted insert. Existing per-device pessimistic lock
order is preserved. Parent and every child partition enable and force RLS and
carry the same tenant policy, including for direct child-table access.

An observation strictly before `now - hot window` skips history insertion but
still enters the inbox, gap/watermark tracking, deterministic latest selection,
notifications and checkpoints in the same transaction. Count a successfully
committed skip in `projection_history_out_of_window_total`; duplicate delivery
is a no-op and does not increment it. This is a process-local operational counter,
not an exact durable accounting ledger across restarts or ambiguous commits.
In-window timestamps without a partition fail closed. Runtime never creates a
partition, so replay cannot resurrect pruned history.

`device_latest` references the inbox's tenant/event/device/reading identity;
notifications reference its tenant/event identity. Neither references expiring
history. Latest values needed after history expires must be read from its durable
inbox event (tenant filtered), rather than an inner join to history.

Migration 000002 copies **all** existing history to matching daily partitions in
one migration transaction, preserving dependent latest/notification rows. It
prunes nothing during conversion. Pause consumers for this DDL and allow temporary
space for both copies. The next scheduled maintenance pass starts retention.

## Boundary shared with Cassandra and write-side safeguards

Future query routing between PostgreSQL hot history and Cassandra cold history
must use the **same `PROJECTION_HISTORY_HOT_WINDOW` boundary configuration** and
UTC cutoff convention. Route times at/after the cutoff to PostgreSQL and earlier
times to Cassandra. The drop safety margin is operational overlap, not a separate
routing boundary. Deploy consumers, maintenance and query routing with identical
configuration. Expanding the window does not restore data already pruned; restoring
that interval requires explicit replay/backfill from retained sources.

Read projections may prune because they can be reconstructed from retained
canonical/source data; this does not imply an unlimited replay horizon. The
**write-side telemetry PostgreSQL ledger must not delete source readings until a
durable Cassandra confirmation watermark proves those readings persisted**. Such
confirmation, source-retention coordination and deletion are **not built in Stage
05**. No source-table deletion is authorized by this ADR.

## Consequences and review

History is bounded by time; inbox, notifications and gap bookkeeping need separate
future lifecycle decisions. Inbox cannot simply be pruned with history because it
owns replay idempotency and latest/notification references. Review the one-hour
margin, 90-day configuration cap, scheduler deployment and recovery horizon before
production adoption. SQLSTATE `42501` remains a hard error: quarantining RLS denial
would mask an application tenant-isolation bug.
