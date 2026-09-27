# Stage 05c: Cassandra writer outage resilience

Date: 2026-09-25. Status: live outage/recovery gate passed on the local Kafka
and single-node Cassandra stack. [Full run log](stage-05c/history-test-2026-09-25.log).

## Root cause

Reproduced against the live stack on 2026-09-25:

- Startup while Cassandra is down: `buildApp` opened the gocql session
  eagerly, so the binary exited at once:
  `ERROR service stopped error="connect cassandra: gocql: unable to create session: ... connection refused"`, exit 1.
- Idle outage (`docker stop` 20 s, `docker start`): the old writer survived,
  because no record needed a write.
- Outage with traffic: `Processor.retry` allowed 5 attempts (about 11 s of
  backoff) inside a 30 s per-record deadline, then `Run` returned the error and
  `RunMain` exited. gocql re-dials DOWN hosts only every 60 s
  (`ReconnectInterval`), so any record arriving during or shortly after a node
  restart (the Stage 08 exit 137) ended the process for good.

## Fix

- `history.Reconnecting`: lazy, replaceable session; dropped and re-created on
  "no hosts available" or three consecutive transient failures; `Ping` never
  dials.
- `Processor.until`: whole-record retry with bounded exponential backoff and
  equal jitter (1 s base, 30 s cap) while the error is transient or the
  per-record deadline expired; the offset stays uncommitted. `Run` waits on
  `Connect` the same way before consuming.
- Degraded state: `/readyz` 503, `/healthz` 200, metrics
  `history_cassandra_degraded`, `history_cassandra_outage_seconds`,
  `history_cassandra_outages_total`, `history_cassandra_sessions_opened_total`
  (no labels).
- Still fatal (offset held): lost committed offset, invalid config,
  non-transient CQL error, oversized poison record.

## Results

```
go vet ./...                          vet-ok
go test -count=1 -race -cover ./...   (3 runs)
ok  greenguard.local/cassandra-writer          coverage: 64.7% of statements
ok  greenguard.local/cassandra-writer/history  coverage: 46.9% of statements
```

Read API: `npm test -w @greenguard/read-api`: tests 31, pass 30, skipped 1
(live), fail 0, including "startup completes within the bound when Redis never
connects".

## Live gate

- `make history-test` exited 0. Node-outage catch-up passed in 15.79 s;
  Kafka crash/replay passed in 45.28 s. The resilience test held offsets
  1021–1023 while Cassandra was unavailable at startup, then held 1024–1028
  through a 2m10s connected-worker outage and recovered without advancing
  the committed offset prematurely. It reported two outage episodes and two
  opened sessions; the test passed in 197.06 s. Three live history tests also
  passed, covering replay/tenant isolation, unbound-bin data and TTL expiry.
- This is a single-node local outage exercise. It does not prove multi-node
  quorum behavior or a consumer-group rebalance during the outage.

## Other open gates

- `make verify` currently fails in the concurrently implemented Stage 09
  tenant-control-plane suite; Cassandra writer and Read API checks pass on
  their own.
