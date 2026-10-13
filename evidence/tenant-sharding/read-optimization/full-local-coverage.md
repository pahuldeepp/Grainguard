# Full local coverage evidence

Weighted local instrumentation coverage: **85.33%** (40114/47013 units).

Sum covered executable lines (JS/TS/Python) plus Go statements divided by total instrumented units; local aggregate, not Sonar new-code coverage or an every-workspace threshold.

| Scope | Instrumentation | Covered / total | Percent |
|---|---|---:|---:|
| apps/dashboard | LCOV executable lines | 714/833 | 85.71% |
| apps/mobile | LCOV executable lines | 1252/1308 | 95.72% |
| packages/otel | LCOV executable lines | 264/264 | 100.0% |
| packages/tenant-auth | LCOV executable lines | 772/784 | 98.47% |
| packages/contracts | LCOV executable lines | 498/529 | 94.14% |
| packages/read-model | LCOV executable lines | 450/518 | 86.87% |
| packages/membership-client | LCOV executable lines | 1298/1468 | 88.42% |
| packages/feature-flags | LCOV executable lines | 565/706 | 80.03% |
| packages/entitlements | LCOV executable lines | 246/403 | 61.04% |
| packages/kafka-security | LCOV executable lines | 26/32 | 81.25% |
| packages/audit | LCOV executable lines | 1265/1306 | 96.86% |
| services/tenant-control-plane | LCOV executable lines | 5881/6282 | 93.62% |
| services/billing-service | LCOV executable lines | 1627/2240 | 72.63% |
| services/bff | LCOV executable lines | 2928/3371 | 86.86% |
| services/gateway | LCOV executable lines | 631/765 | 82.48% |
| services/device-service | LCOV executable lines | 4267/4693 | 90.92% |
| services/workflow-alerts | LCOV executable lines | 2304/2440 | 94.43% |
| services/notification-service | LCOV executable lines | 3376/4012 | 84.15% |
| services/read-api | LCOV executable lines | 3268/3755 | 87.03% |
| coverage/cache-invalidator.out | Go statements | 168/409 | 41.08% |
| coverage/cassandra-writer.out | Go statements | 351/580 | 60.52% |
| coverage/cdc-transformer.out | Go statements | 416/439 | 94.76% |
| coverage/go-common.out | Go statements | 313/555 | 56.4% |
| coverage/go-migrations.out | Go statements | 28/36 | 77.78% |
| coverage/go.out | Go statements | 1629/1915 | 85.07% |
| coverage/hardware-service.out | Go statements | 411/720 | 57.08% |
| coverage/jobs-worker.out | Go statements | 883/1065 | 82.91% |
| coverage/kafka-transport.out | Go statements | 29/63 | 46.03% |
| coverage/projection-builder.out | Go statements | 1690/2275 | 74.29% |
| coverage/saga-orchestrator.out | Go statements | 795/1289 | 61.68% |
| services/search-indexer/coverage.xml | Python executable lines | 295/335 | 88.06% |
| services/risk-engine/coverage.xml | Python executable lines | 1474/1623 | 90.82% |

Run: `npm run coverage` after all migrations in a separate fresh PostgreSQL scratch instance on port55592. Broker/cloud opt-in tests retain their existing skips. Credential/URL values are redacted in the accompanying log.

This is local executable evidence. External SonarQube new-code coverage and quality-gate evaluation were not run by this command.

## Exact command status

The initial literal `npm run coverage` exited1 after all configured workspace
coverage tests passed, because kafka-security had no coverage script. Root
authorized adding that package's peer c8 command and normalization. Its new
coverage command passed2tests and produced81.25% executable-line coverage.

A temporary copy of the unchanged Go/Python continuation of scripts/coverage.mjs
then executed on the same isolated55592 database and exited0. All workspaces, Go
modules and both Python services therefore have actual coverage reports. The
original literal command failure is retained in full-local-coverage-original.log;
completed continuation is in full-local-coverage-tail.log. This resumed evidence
does not relabel the failed original command as passing. A fresh literal rerun
after the tooling correction has not been executed here.

Language breakdown: Go statements 71.83% (6713/9346), LCOV executable lines 88.58% (31632/35709), Python executable lines 90.35% (1769/1958).

Only the newly owned coverage PostgreSQL container was removed after the completed run. Shared database, environment and verifier container were preserved.
