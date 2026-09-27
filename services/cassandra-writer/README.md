# services/cassandra-writer

Status: **implementation in progress; not yet accepted end to end**.

Stages: 05,13.

Technology: Go, Cassandra.

Responsibility: Time-bucketed telemetry history and retention. A Kafka consumer,
Cassandra store, migration command and opt-in Compose profile exist. The unit
tests cover write → watermark → offset-commit ordering and quarantine publish
before commit. `make cassandra-test` checks duplicate upserts, tenant-isolated
reads and watermark access against local Cassandra.

The canonical telemetry contract permits `bin_id: null` for a sensor without a
bin binding. The writer preserves that reading while omitting the Cassandra `bin_id`
column; it still rejects malformed non-null bin identifiers. A
`telemetry.recorded` event is immutable: redelivery uses the same reading ID
and payload. Corrections require a separate versioned event contract, so this
insert path does not attempt to change a previously recorded bin binding.

With the opt-in Kafka and Cassandra overlays running and migrated, run the real
broker crash/replay test:

```bash
cd services/cassandra-writer
KAFKA_BROKERS=127.0.0.1:59092 CASSANDRA_HOSTS=127.0.0.1:59042 \
  KAFKA_CASSANDRA_LIVE=1 go test -count=1 -race -run '^TestLiveKafkaCassandraCrashReplay$' -v .
```

It kills a worker after Cassandra confirms the row and watermark, checks the
Kafka group offset stayed put, restarts with the same group, and checks one
history row, the watermark, poison quarantine and final offset. The full local
history gate is opt-in because it stops the local Cassandra container:

```bash
make history-test
```

`TestLiveHistoryShortTTLExpires` writes a three-second TTL row and waits for
expiry. `TestLiveCassandraNodeOutageCatchUp` uses
`KAFKA_CASSANDRA_FAULT_LIVE=1`, stops `greenguard-dev-cassandra-1` (override
with `CASSANDRA_TEST_CONTAINER`), checks readiness and held broker offset,
then restarts Cassandra and verifies replay. This single-node stop/start does
not establish RF3 multi-node failover or production capacity behavior.

## Outage behavior

The writer never exits because Cassandra is unavailable. The session is opened
lazily (`history.Reconnecting`): a worker that starts while Cassandra is down
waits in `Run` with bounded exponential backoff and equal jitter (base 1 s,
cap 30 s) before consuming. A statement that fails with a transient error
(no hosts, timeouts, connection refused/closed, unavailable, overloaded) or
hits the per-record deadline retries the same record with the same backoff;
its offset stays uncommitted, so nothing is skipped and the replay is an
idempotent upsert. The session is discarded and re-created after a driver
"no hosts available" error or three consecutive transient failures, because
gocql re-dials DOWN hosts only every 60 s. While degraded, `/readyz` returns
503, `/healthz` stays 200, and `/metrics` reports
`history_cassandra_degraded`, `history_cassandra_outage_seconds`,
`history_cassandra_outages_total` and `history_cassandra_sessions_opened_total`
(no tenant or device labels). The process still stops, holding its offset, for
a lost committed offset, invalid configuration, a non-transient CQL error
(schema drift) or an oversized poison record. `TestLiveWriterSurvivesCassandraOutages`
(`KAFKA_CASSANDRA_RESILIENCE_LIVE=1`, part of `make history-test`) proves the
startup-while-down and long-outage (`CASSANDRA_OUTAGE_SECONDS`, default 130)
cases.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
