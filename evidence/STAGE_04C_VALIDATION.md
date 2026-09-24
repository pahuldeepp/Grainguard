# Stage 04c fault validation — local live run

On 2026-09-24, `node scripts/events-faults.mjs` exited 0 against the local
Postgres/Kafka/Registry/Connect stack. The complete output is in
[`STAGE_04C_EVENTS_FAULTS.log`](STAGE_04C_EVENTS_FAULTS.log).

| Gate | Observed result |
| --- | --- |
| E03 | Temporary connector snapshot repeated a canonical event. A temporary transformer binary paused after broker acknowledgement and before the raw offset commit; SIGKILL and restart redelivered the same ID and bytes, then advanced the source frontier. |
| E04 quarantine failure | A temporary transformer binary rejected two quarantine publish attempts for one malformed raw record. Readiness returned 503, the source offset did not advance, and the valid record behind it was not delivered. No shared topic or broker configuration was changed. |
| E04 recovery | Releasing that injection allowed confirmed quarantine with original bytes and source coordinates; the valid following record was delivered and the raw offset advanced. |
| E05 | A singleton was delivered within the 15-second observation bound; another singleton pending during a transformer restart was delivered afterward. |

The harness used a unique consumer group and temporary connector/slot and removed
its host processes, temporary source and binary, connector/slot, group and
tenant-filtered synthetic outbox rows. Kafka fixture records remain until normal
retention/compaction. The broker is a single-node local development broker;
these results do not certify replicated durability or production recovery.

Local checks also passed: `node --check scripts/events-faults.mjs`, Prettier and
ESLint on the script, `go test -race -cover ./...` (100.0% statement coverage)
and `go vet ./...` in `services/cdc-transformer`. The Stage 04 milestone should
only be updated after the remaining stage gates are reconciled.

The full `node scripts/events-e2e.mjs` run also exited 0 on 2026-09-24. Its
output is [`STAGE_04C_EVENTS_E2E.log`](STAGE_04C_EVENTS_E2E.log): outbox to
binding, poison recovery, SIGKILL replay with one effect per event, six source
checkpoints, stale-feed 503 with receipt replay, and admission after recovery
all passed. The script stopped and restarted Connect for the freshness check;
Connect was running again at completion.

Coordinator rerun on the same local stack: `make events-faults` exited 0 with
all E03/E04/E05 assertions ([rerun log](STAGE_04C_EVENTS_FAULTS_RERUN.log)).
The first subsequent `make events-e2e` rerun timed out at `replay drain` after
the first two checks ([timeout log](STAGE_04C_EVENTS_E2E_TIMEOUT.log)). A second
rerun with a failure-only binding/inbox count diagnostic exited 0 and passed
all six checks ([rerun log](STAGE_04C_EVENTS_E2E_RERUN.log)). The intermittent timeout remains
unexplained. The local acceptance has passing evidence, but repeatability must
be resolved before treating the fault gate as production-ready.

A third sequential `make events-e2e` also exited 0 and passed all six checks
([repeat log](STAGE_04C_EVENTS_E2E_REPEAT.log)).

The replay-drain assertion now waits for the trailing event ID in
`consumer_inbox` and checks the binding count separately; timeout diagnostics
capture connector, group and database state. One run with this event barrier
passed all six checks ([event-barrier log](STAGE_04C_EVENTS_E2E_EVENT_BARRIER.log)).
The earlier timeout remains unexplained because its log did not capture enough
state to identify the stalled component.

Another fresh live run after the event-ID barrier change passed all six checks
([final rerun log](STAGE_04C_EVENTS_E2E_FINAL_RERUN.log)). The local E2E/fault
regression gate therefore has repeat passing runs with better diagnostics;
the old intermittent failure has not been reproduced under the new assertion.
This does not close the separate bounded recovery relay or multi-broker gates.
