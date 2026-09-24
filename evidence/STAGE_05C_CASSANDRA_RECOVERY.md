# Stage 05c Cassandra writer recovery evidence (2026-09-24)

The opt-in `TestLiveKafkaCassandraCrashReplay` used the local Kafka and Cassandra
Compose overlays, a fresh consumer group and unique tenant, device, event and
reading IDs. It produced a valid telemetry event followed by a malformed event
on source partition 0. A separate worker process wrote the valid row and
watermark to Cassandra, then blocked before offset commit. The test sent
`SIGKILL`, read the unchanged broker group offset, restarted the writer with
the same group, and checked replay, one history row, watermark, quarantine,
and final offset.

Command from `services/cassandra-writer`:

```bash
KAFKA_BROKERS=127.0.0.1:59092 CASSANDRA_HOSTS=127.0.0.1:59042 \
  KAFKA_CASSANDRA_LIVE=1 go test -count=1 -race \
  -run '^TestLiveKafkaCassandraCrashReplay$' -v .
```

Result: **PASS** in 45.15 seconds. Source offsets were 869 (valid) and 870
(poison). Broker committed offset stayed 869 after the kill, then advanced to
871 after restart. The final Cassandra row count was one; watermark offset
was 869; the poison event was quarantined with `bad_envelope`.

The existing Cassandra-only live suite also passed:

```bash
CASSANDRA_HOSTS=127.0.0.1:59042 CASSANDRA_LIVE=1 \
  go test -count=1 -race -run Live -v ./...
```

After the Kafka run, self-review added an assertion that the row exists before
replay and a unit test that quarantine publish failure prevents offset commit.
`go test -race ./...` and `go vet ./...` passed on that final source. The new
pre-replay assertion has not yet been exercised in another Kafka live run.

This is local single-broker/RF1 evidence. TTL expiry and node-down pause and
catch-up remain separate Stage 05c acceptance work.
