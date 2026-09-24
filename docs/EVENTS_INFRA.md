# Stage 04a event infrastructure

Opt-in local, single-broker infrastructure. Implementation is present; runtime validation
in this session was blocked by sandbox Docker/network access. See
[validation evidence](../evidence/STAGE_04A_VALIDATION.md), including image provenance.
Transformer and binding-consumer wiring are implemented locally; the Stage 04b
heartbeat and acceptance additions are described below. On 2026-09-23/24 the live
stack ran `make events-test` and `make events-e2e` to a pass on this machine; see
[Stage 04b evidence](../evidence/STAGE_04B_VALIDATION.md). That is local single-broker
evidence, not production readiness.

```text
inventory outbox  ─┐  direct postgres:5432   Debezium/Connect   Kafka raw topics
telemetry outbox ──┴───────────────────────────────>───────────────>
                                                            Schema Registry
```

Run from the repository root:

```sh
make bootstrap
make events-up
make events-test
make events-down
```

The overlay is `infra/kafka/compose.yaml`; base `db-up`, `dev`, `verify`, `coverage`
and `smoke` do not load it. Postgres logical WAL is enabled in the base stack;
ten slots/senders leave room for two normal connectors and temporary snapshot tests.
`events-up` applies migrations, waits for Kafka, provisions topics, starts Registry
and Connect, then PUTs the connector configurations and waits for their tasks.
Topic provisioning refuses existing partition/RF/cleanup/minISR drift.
`events-down` stops only Connect, Registry and Kafka. It retains containers, Kafka
storage, source slots and offsets, and leaves Postgres/PgBouncer running.

| Endpoint        | Host (loopback only) | Containers             |
| --------------- | -------------------- | ---------------------- |
| Kafka           | `127.0.0.1:59092`    | `kafka:29092`          |
| Schema Registry | `127.0.0.1:58081`    | `schema-registry:8081` |
| Connect REST    | `127.0.0.1:58083`    | `connect:8083`         |
| Source Postgres | `127.0.0.1:55432`    | `postgres:5432`        |

The local listeners use plaintext and have no external exposure or production ACLs.
Connect never uses PgBouncer. `CDC_DB_PASSWORD` is generated in ignored `.env`;
Connect resolves `${env:CDC_DB_PASSWORD}` using its environment config provider.
JSON configurations never contain the password. Do not share rendered Compose
configuration or container environment dumps: those contain local credentials.

Exactly five domain topics are provisioned: the two `greenguard.raw.*.outbox`
topics (one partition each), `greenguard.inventory.device.v1` and
`greenguard.telemetry.recorded.v1` (six each), and `greenguard.quarantine.v1` (one).
Connect also requires three explicitly provisioned compacted internal topics,
`greenguard.connect.{configs,offsets,status}`; Registry uses compacted `_schemas`.
Kafka maintains its own consumer-offset internal topic. Broker and Connect domain
topic auto-creation are disabled. Raw values retain Debezium `before/after/source/op`
envelopes as plain JSON (converter schemas disabled), and the event-ID record key;
RegexRouter changes only the topic name. Canonical topics remain empty in this slice.

All local topics use RF1/minISR1 and producers use `acks=all`. **This is not HA.**
The future resilient profile requires at least three brokers, RF3/minISR2 for
application and internal topics, and broker-leader failure tests. Changing only the
replication setting on one broker cannot provide that guarantee. Local Kafka retains
seven days of raw data; it is not an archive.

## R1: narrow snapshot access

The idempotent database init script provisions `cdc_reader` with LOGIN and
REPLICATION, but no superuser, role/database creation, inheritance or BYPASSRLS.
Migrator-owned migrations grant schema USAGE and outbox SELECT only, install a
permissive `FOR SELECT TO cdc_reader USING (true)` policy, and create the explicit
insert-only `greenguard_outbox` publication in each database. Tenant policies and
FORCE RLS stay enabled. The ordinary application roles receive no extra privileges.
Publication auto-creation is disabled; CDC is not a table owner.

The connector's lock-free snapshot assumes migrations finish before startup; do not
change outbox schemas during a snapshot. PostgreSQL replication credentials remain
privileged: table grants constrain ordinary reads, while REPLICATION is a trusted
server-level capability. This local role is not an untrusted tenant login.

`events-test` inserts synthetic outbox rows as each runtime role with transaction-local
tenant context. A fresh temporary connector/slot per database must emit `op=r` for
rows from two tenants created before registration. The test then deletes its temporary
connector/slot, checks `op=c` for commits and no rollback event over at least 30 seconds,
and stops Connect, commits three rows per database, restarts and accounts for every ID.
Delivery assertions allow duplicates. Tests clean up only their own random fixture IDs;
Kafka records remain until retention; temporary connector offset keys remain in the
compacted Connect offset topic (connector deletion does not reset offsets).
Run one smoke invocation at a time because it stops the shared local Connect process.

## Troubleshooting and R7

Use the overlay when inspecting services:

```sh
docker compose --env-file .env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml ps
curl --fail http://127.0.0.1:58083/connectors/inventory-outbox/status
curl --fail http://127.0.0.1:58083/connectors/telemetry-outbox/status
```

A healthy REST endpoint alone does not prove a healthy connector; task state must be
RUNNING. Inspect Connect logs locally for permission errors, missing topics, password
rotation, or inactive slots. Rerun `make bootstrap` and `make events-up` after rotation.
For WAL growth, inspect `pg_replication_slots` (active, restart_lsn, confirmed_flush_lsn,
wal_status) and `pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)` as the administrator.
Stopped connectors retain WAL: restart promptly and monitor disk. Do not drop a normal
slot or delete Kafka storage as a repair without deciding how to replay retained outbox
rows. Unexpectedly terminated smoke tests may leave `snapshot-*` connectors and
`gg_test_*` slots; remove only positively identified inactive test slots after deleting
the corresponding test connector. Normal `greenguard_*_outbox` slots must be preserved.

### R7: binding-feed freshness (passed local live acceptance)

[ADR-0009](adr/0009-binding-feed-freshness.md) specifies the source heartbeat,
partition barrier and clock assumptions. Every 30 seconds the inventory connector
emits a transactional logical WAL message. The message and outbox rows share the
single raw inventory partition. The transformer forwards each barrier to all six
canonical partitions, preserving source commit time and WAL position; telemetry
persists it after prior binding effects. Healthy idle feeds therefore make progress
without device changes. Keep the one-raw/six-canonical partition topology fixed.

With `KAFKA_BROKERS` set, telemetry runs group `telemetry-binding-consumer` alongside
HTTP. `INGEST_BINDING_FEED_MAX_STALE` defaults to `5m`; explicit `0` disables gating.
Receipt replays precede the gate; **every new observation** requires fresh evidence.
Missing checkpoints, excessive lag or a failed freshness read yield
`503 binding_feed_stale`, `Retry-After: 5`. Without brokers, existing standalone
behavior is retained. Runtime roles cannot delete checkpoints or change partition IDs.

Metrics: `binding_feed_age_seconds` is oldest source time plus five seconds of
clock-skew allowance (`+Inf` for unavailable evidence); `binding_feed_stale_total`
counts stale admissions. Consumer retry/quarantine counters have no tenant labels.
Warn at age >120 seconds for one minute; critical above the configured admission
bound or for missing evidence. Synchronize source/consumer clocks within five seconds.

Recovery: inspect connector task state and retained WAL, then transformer and consumer
readiness. Restore the failed component and drain backlog until every partition has
a recent source checkpoint. Delayed disables apply before the covering checkpoint.
Never clear the inbox or reset offsets to restore admission. Topic recreation or
partition changes require stopped admission and an explicit rebuild plan.

Debezium itself also writes a heartbeat record to
`__debezium-heartbeat.greenguard_inventory` on every heartbeat interval. Broker
auto-creation is off, so `scripts/kafka-topics.mjs` provisions that topic (compacted,
one partition). Without it the connector task blocks on the missing topic, cannot stop
gracefully, and an orphaned task keeps holding its replication slot; the first live
smoke run found exactly this. A temporary connector on a different `topic.prefix`
(the R1 snapshot check) therefore sets `heartbeat.interval.ms=0` and excludes all
logical messages (`message.prefix.exclude.list=.*`), because its slot also decodes the
live connector's checkpoint messages.

Committed offsets that fall out of range (retention expired while a consumer was
down) are fatal in both the transformer and the telemetry binding consumer: a new
group starts at the log start, but an expired commit stops the process with a non-zero
exit instead of silently skipping to the remaining log. Recovery is a replay of the
retained outbox through a fresh connector and slot, then a deliberate offset reset; see
[WAL retention](WAL_RETENTION.md).

### Stage 04b live acceptance

Run `make events-e2e` with the stack from `make events-up`. CI runs it immediately
after `make events-test`; it is deliberately outside `make verify`. The Node script
uses existing tooling and builds **host transformer/consumer processes**, reading
connection URLs from `.env`; no Compose service was added. Ports 18080/18081 must be
free, and no other worker may use the same groups during this acceptance run.

Before starting the services it moves `greenguard-cdc-transformer-v1` and
`telemetry-binding-consumer` to the log end. Dev topics keep history from earlier runs
whose telemetry rows the migration tests have since rolled back; replaying that history
halts the consumer on a version gap (`device binding is not available yet`), which is
correct fail-closed behaviour but not what this test measures. This reset is a test
harness action only: never do it to restore admission in a real cell.

It checks, in order: committed inventory outbox -> raw -> transformer -> canonical ->
telemetry binding; a poisoned raw record reaches quarantine and the next good event
still applies; a consumer SIGKILL while blocked on a stream lock, then restart and a
full raw replay leave exactly one inbox row and effect per event; six persisted source
checkpoints on an idle feed; and the freshness gate. For the gate the script serves a
loopback JWKS, enables authenticated ingest with `INGEST_BINDING_FEED_MAX_STALE=45s`,
accepts a reading, stops Connect until a new reading gets `503 binding_feed_stale`,
checks that an identical retry of an already accepted reading is still answered from
its receipt (same `reading_id` and `event_id`), restarts Connect and waits until new
readings are admitted again. Synthetic rows use a random tenant and remain for
inspection. Processes, the JWKS server and temporary binaries are cleaned up.

Passing this proves the local single-broker flow only. It does not cover a multi-broker
cluster, production retention, or the E04 quarantine-publish-failure case (see
[Stage 04c evidence](../evidence/STAGE_04C_VALIDATION.md)).
