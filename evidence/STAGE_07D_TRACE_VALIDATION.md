# Stage 07d: saga trace-context propagation

Date: 2026-09-25. Local, uncommitted checkout. Remote CI has not run.

## Change

The saga worker used to derive a `traceparent` from the saga and command IDs. That broke the ADR-0004 rule that trace IDs are never invented. It now uses the start request's context. The new rules are in the "Saga" section of [ADR-0004](../docs/adr/0004-tracing.md).

- `services/saga-orchestrator`: migration `000007_trace_context` adds nullable `provisioning_sagas.traceparent`/`trace_origin` and `saga_command_outbox.traceparent`. `saga/trace.go` holds the sanitizer, the random root and the generate-once logic. Every write happens under the existing saga row lock (ADR-0013). The publisher fills a pre-migration row with `SKIP LOCKED` and never waits.
- The API passes the `traceparent` header to `Store.Start`. The header is not part of the idempotency hash.
- Participants: hardware `000004_result_trace_context`, where the trace is excluded from the command identity hash; telemetry `000008_saga_binding_trace`; device-service `20260925090000_saga_result_trace` plus `src/saga/trace.ts`. Each one stores the command's context on its result outbox and echoes it in Kafka headers. Inventory CDC events use it too.
- BFF: `ProvisioningClient.start(..., traceparent?)` forwards a valid header.

## Results (real output)

```
go test -race -count=1 ./saga   (x3)   ok 5.526s / ok 6.118s / ok 5.765s
make saga-test                          ok cmd/api, cmd/worker, saga
--- PASS: TestSanitizeTraceparent, TestNewRootTraceparentIsRandomValidAndSampled, TestStartTraceOrigin
--- PASS: TestLivePropagatedTraceCrossesEveryCommand
--- PASS: TestLiveMissingTraceGeneratesOneRootReusedByDeadlineAndRedrive
--- PASS: TestLivePreMigrationRowsGetOneStoredRoot
hardware-service go test -race ./...    ok (TestResultHeadersCarrySagaTraceContext, TestCommandTraceIsSanitizedAndExcludedFromRequestHash)
telemetry-ingest go test -race ./...    ok (TestBindingAwaitCommandKeepsOnlyAValidSagaTrace, TestBindingResultEchoesTheCommandTrace)
device-service npm test                 tests 120, pass 119, fail 0, skipped 1
bff npm test                            tests 31, pass 31, fail 0
```

## Live end-to-end validation (2026-09-25)

The real Kafka, Kafka Connect, PostgreSQL and MQTT stack was running. `STAGE07_SKIP_BROKER_PAUSE=1 node scripts/stage07-e2e.mjs` exited 0 ([full log](stage07/STAGE_07D_TRACE_FULL_E2E.log)). The start request's unsampled trace was stored as `propagated`, then found unchanged on 4 published commands, 4 participant results (hardware, inventory, telemetry), and the `device.registered` event. The two-tenant path, coordinator restart, duplicate result, inventory rejection/asset release, race, 12 worker SIGKILL rotations, participant outage, configure timeout, redrive and stale lease gates passed. The broker pause gate was intentionally skipped because Kafka was shared with another running test.

`STAGE07_TRACE_ONLY=1 STAGE07_SKIP_BROKER_PAUSE=1 node scripts/stage07-e2e.mjs` exited 0 ([compensation log](stage07/STAGE_07D_TRACE_COMPENSATION_E2E.log)). It repeated the activation assertion and checked a separate caller trace across the compensation saga: the saga row, 4 published commands including `asset.release`, and 4 hardware/inventory results including the rejected `inventory.activate` and successful release all carried the original trace.

The HTTP entry path is covered by `npm run test -w @greenguard/gateway` (7/7, caller header reaches GraphQL BFF) and `npm run test -w @greenguard/bff` (33/33, GraphQL request context forwards valid trace to the saga API and discards invalid trace). The BFF resolver now passes the incoming header to `ProvisioningClient.start`. The API and participants validate it again. No separate real gateway-to-BFF-to-Kafka process test was run; the two HTTP tests and real saga Kafka test cover the boundaries independently.
