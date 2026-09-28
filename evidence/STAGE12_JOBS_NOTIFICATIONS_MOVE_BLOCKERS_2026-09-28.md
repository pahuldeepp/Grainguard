# Jobs + Notifications tenant move readiness

## Status

**Not move-enabled.** This change adds a fail-closed drain preflight, not owner
move receipts and not an accepted tenant migration. Jobs Worker and
Notifications must be fenced and drained together before their data can move.

The gate lives in
`services/tenant-control-plane/src/tenant-move/jobs-notifications-drain-gate.ts`.
It requires the exact source `(shard, incarnation, epoch)` to be locally fenced,
rejects schema or partition drift, then refuses cutover until:

- Jobs has no nonterminal notification intents, undelivered dispatch-outbox
  rows, or unpublished dead-letter-outbox rows.
- Notifications has no nonterminal delivery records. `received`, `retry`,
  `in_progress`, `unknown`, and `dead` all block the move; in particular an
  uncertain provider result cannot be treated as a completed send.

This catches queued/retry work through its durable intent/ledger state. It does
not inspect RabbitMQ queue contents directly. Requiring all job intents to be
terminal and all dispatch/DLQ outboxes to be drained is the conservative guard
against moving while broker deliveries or receipt updates remain outstanding.

## Why the owners are coupled

Jobs owns the intent/inbox/dispatch history and publishes RabbitMQ tasks.
Notifications owns provider preferences, delivery attempts, and provider
outcomes. A provider call can succeed while the task or outcome receipt is
replayed. Moving only one database can split the same intent across shards,
resend an external effect, or strand an uncertain delivery. The move coordinator
must therefore fence both source owners, run both drain gates, copy and verify
both owner snapshots, compare intent/delivery outcomes, and activate neither
target until both copy receipts are durable. Abort/recovery must keep both
targets inactive until both can prove cleanup. That two-owner coordinator and
the owner-specific durable copy/activation receipts are still missing.

## Validation

The unit coverage checks source-identity fencing, schema drift refusal, queued
dispatch/DLQ refusal, and provider-uncertainty refusal. These tests exercise the
gate contract with a fake `pg.Pool`; they are not a database migration or
cross-owner acceptance test. Do not count this owner pair as complete in the
tenant-move roster.
