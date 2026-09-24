# Stage 05c Cassandra history validation (2026-09-24)

The writer's live acceptance gates ran against the local Kafka single broker
and Cassandra single-node RF1 Compose overlays. These are local durability and
recovery checks; RF3 failover and capacity behavior remain unmeasured.

From `services/cassandra-writer`:

```bash
CASSANDRA_HOSTS=127.0.0.1:59042 CASSANDRA_LIVE=1 \
  go test -count=1 -race -run '^TestLiveHistoryShortTTLExpires$' -v ./history
KAFKA_BROKERS=127.0.0.1:59092 CASSANDRA_HOSTS=127.0.0.1:59042 \
  KAFKA_CASSANDRA_FAULT_LIVE=1 \
  go test -count=1 -race -run '^TestLiveCassandraNodeOutageCatchUp$' -v .
KAFKA_BROKERS=127.0.0.1:59092 CASSANDRA_HOSTS=127.0.0.1:59042 \
  KAFKA_CASSANDRA_LIVE=1 CASSANDRA_LIVE=1 \
  go test -count=1 -race -run Live -v ./...
go test -race ./...
go vet ./...
```

All passed. The short-TTL test wrote a row with a three-second TTL, read it
immediately, then observed expiry after 2.58 seconds. The outage test opened
an active Cassandra session, stopped the local container, fetched source
offset 907, attempted the write, observed the processor become unready, and
verified the broker committed offset remained 907. After the container
restarted and passed a Cassandra ping, a new worker replayed offset 907,
committed 908 and found exactly one history row. The container was healthy
after the test. The test restores the container via cleanup if an assertion
fails while it is stopped.

The full live rerun passed crash/replay (source offsets 908 and 909, final
commit 910, one row, watermark 908, poison quarantine), tenant-isolated
history reads and watermark reads, and TTL expiry. The Kafka crash/replay
test includes the pre-replay row assertion added after the prior evidence
file. The node outage test is separately gated by
`KAFKA_CASSANDRA_FAULT_LIVE=1` because it stops the shared local node.

The oversized quarantine payload path is covered by unit tests as a
no-commit failure. It is deliberately not quarantined with truncated bytes;
the worker stops so an operator can recover the complete source record.

The combined `make history-test` gate was run again on this local stack. Its
first attempt exposed a startup race after the outage test: Docker health and
one successful session preceded a usable pool for the next package's TTL
test. The live history tests now retry a real CQL ping for up to 30 seconds
after node restart. The next full target run passed outage/catch-up, Kafka
SIGKILL/replay, tenant isolation, and short-TTL expiry together (source offsets
913–915; committed frontiers 914 and 916). This remains single-node RF1
evidence, not multi-node failover certification.

A scoped CodeRabbit review found three valid issues, which were fixed:
invalid CQL requests now hold the offset instead of being treated as row
poison; `HISTORY_TTL` rejects values above Cassandra's 630720000-second
limit; and the service README documents both live gates. After those edits,
`go test -race ./...` and `go vet ./...` passed again. The review process was
stopped after these findings to free the shared review slot; no final
CodeRabbit verdict is claimed.
# CodeRabbit follow-up (2026-09-24)

The Cassandra migration now verifies the actual existing keyspace replication
class, datacenter and factor after `CREATE KEYSPACE IF NOT EXISTS`, before
creating history tables. The crash-child test reads buffered stderr only after
the child has exited, avoiding a concurrent buffer read. Unit coverage includes
matching, missing and mismatched replication configurations. After these fixes,
`make history-test` passed again: node outage/catch-up, process crash/replay,
tenant isolation and TTL expiry all passed. Log:
`/tmp/greenguard-history-test-review-20260924.log`.
