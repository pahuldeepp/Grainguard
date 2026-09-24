# services/cassandra-writer

Status: **implementation in progress; not yet accepted end to end**.

Stages: 05,13.

Technology: Go, Cassandra.

Responsibility: Time-bucketed telemetry history and retention. A Kafka consumer,
Cassandra store, migration command and opt-in Compose profile exist. The unit
tests cover write → watermark → offset-commit ordering and quarantine publish
before commit. `make cassandra-test` checks duplicate upserts, tenant-isolated
reads and watermark access against local Cassandra. With the opt-in Kafka and
Cassandra overlays running and migrated, run the real broker crash/replay test:

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

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
