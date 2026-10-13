# Read admission optimization: local evidence

This slice retains authoritative request-scoped leases and final response
admission. It does not replace those leases with reusable pod grants.

## Implemented

- Device/current aggregation uses one tenant-filtered SQL statement and one
  Read API request; BFF device/latest consumers share that request.
- Original request deadlines and disconnect cancellation bound authority calls,
  fair-queue waits, PostgreSQL admission, SQL and cache side effects.
- Guarded warm hits use four Redis commands and three authority calls
  (acquire, final admit, release). Tenant-slot Lua checks preserve exact BIGINT,
  recovery, revision and epoch fencing; the global recovery key stays separate.
- Pool saturation and caller cancellation do not mark a healthy replica failed.
- Authority metrics use fixed operation/outcome labels, without tenant labels.

## Executed local checks

- Read API and shared placement/authority/owner tests: 129 passed, eight live tests
  skipped in the offline run, including snapshot deadline, pooled-reuse, bounded
  placement response parsing and busy-response regressions.
- Coverage: Read API lines/statements 86.26%, branches 86.52%, functions 80.10%;
  membership-client lines/statements 88.25%, branches 87.74%, functions 90.47%.
- BFF 80 tests, dashboard 90 tests, mobile 71 tests passed.
- Risk: 97 tests passed, one opt-in test skipped; aggregate coverage 91%.
- All eleven Go modules passed the separate offline race checks.
- Repaired legacy live ownership fixtures now pass: Device 166, Alerts 74,
  Notifications 131; Telemetry, Projection, Jobs, Saga and Hardware Go suites.
  Existing opt-in broker/cloud skips are retained. Fixture setup uses privileged
  isolated bootstrap plus explicit placement; production fences remain enabled.
- Notification provider capacity is acquired before the tenant transaction.
  Actual PostgreSQL lock tests verify the owner fence remains held across the
  admitted provider call and is released after completion.
- Isolated PostgreSQL/Redis acceptance passed: control leases 3, placement API 3,
  risk ownership 1, PostgreSQL snapshot/aggregate parity/isolation/cancellation 1,
  Redis fencing 4, and Go cache invalidator tests.

The isolated harness is `scripts/read-freshness-local.mjs`. It provisions and
removes only its own temporary containers and credentials. Logs and review
dispositions are saved here: `offline-tests.txt`, `isolated-acceptance.txt`,
`make-verify.txt`, `verification-summary.md`, `full-local-coverage.md`, and
`review-dispositions.md`. Local progress notes also remain in the task ledger.

Full isolated `make verify` passed: 1,018 Node passes, zero failures and 26
existing opt-in skips; risk, Go vet/race checks and final builds passed.
Weighted local instrumentation coverage is 85.33% (40,114/47,013 units across
32 scopes). The original literal coverage command failed on a missing
Kafka-security coverage script. That script is now fixed and tested; actual
workspace coverage plus the Go/Python continuation completed successfully.
This is not a claim that a fresh literal coverage command or external Sonar
new-code gate passed. The failed command and successful continuation are retained.

This batch supplies Stage 11 read-admission telemetry, Stage 12 bounded
admission/ownership and Stage 13 local read-correctness evidence. It does not
mark those whole stages complete.

## Remaining gate boundaries

Whole-repository live tests exposed legacy fixtures missing required ownership
context. Those fixtures are repaired and the isolated repository gate passed. Shared
database migration history is dirty; no force/reset/drop was performed.

No AWS apply, full tenant-mover acceptance, production load benchmark,
physical-iPhone OAuth acceptance or teardown inventory proof is implied.
Cutover waits for live leases; a response already admitted before cutover can
finish transport afterward. Full movement also needs writer drain, verified
copy, external-effect reconciliation and target activation.
