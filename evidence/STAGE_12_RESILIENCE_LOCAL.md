# Stage 12.12 local resilience checks (2026-09-26)

Scope: deterministic process-local fault injection. This is partial Stage 12.12 evidence, not disposable-cluster or production acceptance.

## Checks and observed output

| Check | Injected fault | Bounded and duplicate-effect assertion |
| --- | --- | --- |
| `services/gateway/src/resilience.test.ts` | The saga upstream accepts a provisioning POST but never responds. | A gateway configured with a 100 ms deadline returns HTTP 504 within a 2,000 ms local test bound; the upstream observes exactly one POST with the original idempotency key. The gateway does not automatically replay an ambiguous mutation. The final gateway suite reported this case passing in 115.77 ms. |
| `services/telemetry-ingest/consumer_test.go`, `TestBindingConsumerRetryAndCommitFrontier` | Binding apply commits one modeled effect but loses its acknowledgement (`io.EOF`); the first offset commit also fails. | Exactly two apply attempts and two offset-commit attempts after the first delivery, with two total retry increments and one effect. An additional broker redelivery leads to a third apply/commit attempt, no additional retry increment, and still one effect. The fake models the receipt-backed `BindingDuplicate` outcome; real store receipt behavior is covered separately by ingest and binding store tests. |
| `TestBindingConsumerExhaustionAndPermanentFailuresNeverCommit` | Repeatable transient or permanent apply failures. | Transient calls equal the configured `Attempts` (3); permanent calls equal 1; neither advances the offset. |
| `services/bff/src/read-client.test.ts` | Injected transient 503, stalled fetch/body, open breaker, concurrent pre-trip success, and failed recovery probe. | Safe GET makes at most three attempts with one 8-second overall deadline and 2-second per-attempt cap covering headers and JSON body (shorter values injected in timeout tests). A stalled call ends with controlled `read_timeout`; 403 is never retried. Transient response bodies are cancelled before retry. POST batch reads make one attempt. Three exhausted transient calls open the circuit for 5 seconds; open calls make zero upstream requests; one recovery probe closes or reopens it. An older in-flight success cannot change newer breaker state. |

Commands run from the repository root unless noted:

```text
$ npm run test -w services/gateway
✔ a stalled provisioning POST has a bounded deadline and one upstream effect (115.766875ms)
ℹ tests 10
ℹ pass 10
ℹ fail 0

$ (cd services/telemetry-ingest && go test ./... -run 'TestBindingConsumer(RetryAndCommitFrontier|ExhaustionAndPermanentFailuresNeverCommit|RetryCancellationAndClassification)$' -count=1)
ok  greenguard.local/telemetry-ingest  0.665s
ok  greenguard.local/telemetry-ingest/cmd/migrate  0.850s [no tests to run]
ok  greenguard.local/telemetry-ingest/migrations  0.323s [no tests to run]

$ (cd services/telemetry-ingest && go test ./... -count=1)
ok  greenguard.local/telemetry-ingest  3.555s
ok  greenguard.local/telemetry-ingest/cmd/migrate  0.693s
ok  greenguard.local/telemetry-ingest/migrations  0.233s

$ git diff --check -- services/telemetry-ingest/consumer_test.go
(no output; exit 0)

$ npm run test -w services/bff
✔ safe GET retries transient failures at most three times
✔ safe GET does not retry an owner authorization failure
✔ read timeout obeys one overall deadline and never retries POST batches
✔ breaker rejects without upstream calls then recovers after a successful probe
✔ a failed recovery probe reopens the breaker for another cooldown
ℹ tests 51
ℹ pass 51
ℹ fail 0

$ npm run test -w services/bff  # fix round 2
✔ safe GET retries transient failures at most three times
✔ a prompt header with a stalled body uses the per-attempt deadline
✔ a pre-trip success cannot close an open breaker or clear its recovery probe
ℹ tests 53
ℹ pass 53
ℹ fail 0
```

## Existing local boundaries inspected

- Telemetry binding consumer: configured attempts, retry delay, per-message timeout, offset frontier, duplicate outcome, and quarantine path (`consumer.go`, `consumer_runtime.go`, `consumer_test.go`).
- Telemetry ingest: token bucket and 429/`Retry-After` tests (`ratelimit.go`, `httpapi_test.go`); receipt-based retry and ambiguous-commit tests (`ingest_test.go`).
- BFF: Redis rate limiting and failure-closed 503 handling (`rate-limit.ts`, `main.test.ts`); bounded Read API GET retries, one overall deadline, and a circuit breaker per ReadClient instance (`read-client.ts`, `read-client.test.ts`).
- Gateway: bounded HTTP proxy deadline (`server.ts`), now with a stalled POST check.

## Still required for Stage 12.12

The Helm profiles inspected have no Istio `VirtualService` retry/timeout policy or `DestinationRule` outlier detection/circuit-breaker policy. No disposable mesh was exercised. A disposable cluster must prove route-specific mesh retry limits, per-try and overall timeouts, outlier ejection, edge/WAF rate limits, and that retried operations retain the same idempotency key with one durable side effect. The BFF breaker is per ReadClient instance; `main.ts` currently constructs separate instances for request handling and subscriptions. These checks do not establish coordination across either those instances or replicas. Local fake counters do not establish database, broker, or mesh behavior under a partition.
