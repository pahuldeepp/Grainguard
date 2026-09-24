# Stage 04b validation

Local implementation; **full telemetry coverage gate and live acceptance UNVERIFIED**.
No commit, push or milestone edit was performed by this task. Pre-existing workspace
changes were preserved. Sonar/coverage gate execution remains with the coordinator.

## Baseline review fixes

Before consumer implementation, ran from `services/telemetry-ingest`:

```sh
GOFLAGS=-mod=mod GOPROXY=off go test -race -coverprofile=/tmp/greenguard-telemetry-before.cover -cover ./...
go tool cover -func=/tmp/greenguard-telemetry-before.cover
go tool cover -func=../../coverage/go.raw.out
```

The full run failed immediately in `TestAuthValidToken`: `httptest` could not bind
`[::1]:0` (`operation not permitted`). Its partial profile contains migration
packages only: `cmd/migrate.run` 75%, `migrations.Up` 60%, combined 77.3%. Those are
not measurements of the review fixes. The pre-existing `coverage/go.raw.out` reported
100% for every function when inspected; this task did not generate that report and
cannot reproduce the user's earlier 97.3% full-run figure in the sandbox.

Added listener-free regression tests in `review_regression_test.go`, preserving the
production fixes. The first focused race run passed (31.7% package coverage, because
only a small selection ran). Initial writes to the default Go build cache were denied;
subsequent commands used the writable `GOCACHE=/tmp/greenguard-go-cache`.

The focused profiles exposed `jwksCache.key` at 84.4%, `lookup` at 70% and `fetch`
at 31.2% before additional socket-free tests, and the new `parseCheckpoint` at 93.8%
before its invalid source-position test. Added deterministic `testing/synctest` waiter
completion and HTTP transport recovery tests. These functions now report 100%, as do
`RejectionRecorder.allow`, `Record` and `storeReading`. The broader run caught a real
failing expectation in `TestMetricsExactText`: it lacked the new stale-feed reason.
Updated the expected exposition; retained the counter.

## Executed Go checks

Commands used `GOCACHE=/tmp/greenguard-go-cache GOFLAGS=-mod=mod GOPROXY=off`.

```sh
# services/telemetry-ingest
 go test -race -coverprofile=/tmp/greenguard-04b.cover \
   -run 'TestBinding|TestReview|TestThrottleMap|TestRecordNever|TestEveryStatement|TestScripted' .
 go tool cover -func=/tmp/greenguard-04b.cover
 go vet ./...

# services/cdc-transformer
 go test -race -coverprofile=/tmp/greenguard-cdc.cover ./...
 go tool cover -func=/tmp/greenguard-cdc.cover
 go vet ./...
```

- Focused telemetry run passed: **68.6% package statement coverage**. All functions
  in the new consumer, Kafka adapter, schema, runtime and binding-feed source files
  reported **100% statements**. This does not establish full-module or branch coverage.
- A broader listener-free selection also passed under `-race`: telemetry **88.7%**,
  cmd/migrate **87.5%**, migrations **0%** (no selected tests in that package).
  `go tool cover -func` reports combined **87.6%**. The exact selected test names are
  recorded below. Database tests in this selection skip when their URLs are absent;
  explicit URL-configured attempts are recorded separately below.
- Transformer full suite passed: **100.0% statements**. Includes kfake virtual-network
  checkpoint fan-out to all six partitions, as well as the prior transformer tests.
- `go vet ./...` passed in both services.
- Telemetry kfake tests proved quarantine then good progress, broker offset recovery
  after effect-before-offset failure, retry exhaustion with broker offset still -1,
  restart at the uncommitted record, and a single record committing without later
  traffic. Scripted tests cover every quarantine reason, transient/permanent failures,
  duplicate/stale/gap dispositions, freshness and lifecycle behavior.

[Function-level output](STAGE_04B_FUNCTION_COVERAGE.txt) is from the broader partial
selection, **not** a replacement for the full coverage gate. Go statement coverage
alone does not prove the requested 100% branch gate. No exclusions or gates changed.

## Explicit database attempts

Loaded `.env` using `node --env-file=.env`, then spawned these commands from the
telemetry directory with the Go environment settings above:

```sh
go test -race -run '^TestBindingConsumerDatabaseCrashAndTenantIsolation$' .
go test -race -run '^TestBindingFeedDatabaseMonotonicityAndPrivileges$' .
```

Both failed because the sandbox prohibits connections. All four crash-boundary
subtests failed at PgBouncer `127.0.0.1:56432` with `connect: operation not permitted`.
The checkpoint/privilege test failed opening its admin connection to Postgres
`127.0.0.1:55432` with the same error. No assertion about database effects, RLS,
migration 000004 or grants is claimed from these attempts.

## Other executed checks and blockers

- `node --check scripts/events-e2e.mjs`: passed.
- `node_modules/.bin/prettier --write scripts/events-e2e.mjs`, then `--check`:
  formatted/passed. The script was formatted again after adding broker-frontier checks.
- `node_modules/.bin/eslint scripts/events-e2e.mjs`: passed, including after those checks.
- `python3 scripts/check_plan.py`: passed (368 catalog entries, 141 coverage rows).
- `git diff --check`: passed at the time run.
- `make verify`: planning checks passed; failed at `db-up` because Docker socket
  `/Users/pahuldeepsingh/.docker/run/docker.sock` access is denied. Application checks
  behind that dependency did not execute through Make.
- `coderabbit review --uncommitted --include-untracked --dir services/telemetry-ingest --agent`:
  failed during authentication with `Failed to start server. Is port 0 in use?`.
  No review verdict was obtained; the CodeRabbit gate remains outstanding.
- No Sonar scan or full `make coverage` ran here. Full listener tests, live Postgres
  tests, Docker acceptance and deployed heartbeat behavior remain **UNVERIFIED**.

## Implemented scope and decisions to review

New telemetry consumer/schema/Kafka/runtime files, binding-feed state/gate and
migration 000004; regression, scripted and kfake tests; config/HTTP/main/metrics and
schema packaging updates; pinned cached franz-go dependencies. Existing ADR-0005
binding application remains the write path. The freshness protocol required minimal
connector routing/heartbeat configuration plus a transformer checkpoint extension.
No cdc_access migration or prior Kafka/events helper script was changed.

`events-e2e.mjs` builds host binaries, uses `.env`, and checks source outbox delivery,
poison continuation, SIGKILL during a stream lock, recovery/replay and persisted
source checkpoints. Added `make events-e2e` outside verify and immediately after
`make events-test` in the existing CI job. **The live script was not run here.**

Review [ADR-0009](../docs/adr/0009-binding-feed-freshness.md): one raw/six canonical
partitions, a 30-second transactional WAL heartbeat, five-second clock-skew bound,
five-minute default freshness, and gating every new observation after receipt replay.
Actual source/connector ordering and recovery must pass the live test before deployment.

## Exact broader test selection

The local selection is only an execution record. The repository's full test and
coverage commands remain unchanged. It was run from telemetry with:

```text
go test -race -coverprofile=/tmp/greenguard-04b-safe.cover -run '^(NAME|NAME|...)$' ./...
```

where the alternatives were the following names:

```text
TestCorrelationID
TestCorrelationTraceparent
TestCorrelationPrefersActiveSpan
TestRequestMetaFromWithoutMiddleware
TestD02RuntimeRoleCannotBypassRLSAndOwnsNothing
TestD02WithoutTenantContextNoRowsAreVisible
TestD02OneTenantCannotReadOrWriteAnother
TestRuntimeRoleCannotDeleteRewriteIdentityOrReadHistory
TestD03TenantContextNeverOutlivesItsTransaction
TestIngestStoresOneReadingEventAuditAndReceiptWithMatchingIDs
TestIngestOmitsAbsentMeasurementsAndNeverWritesZero
TestIngestRetryReturnsTheStoredResultAndCreatesNothing
TestIngestSameMessageWithDifferentContentConflictsAndKeepsTheOriginal
TestTwentyConcurrentIdenticalRequestsStoreOneReading
TestConcurrentDistinctReadingsGetGaplessVersionsAndOtherDevicesProgressIndependently
TestIngestRefusalsStoreNothing
TestOperatorsAndAdminsMayPostForAnyDeviceOfTheirTenantOnly
TestIngestRejectsAnInvalidTenantAndSurfacesInternalErrors
TestNewIngestorDefaultsTheClock
TestTimestampBoundariesAgainstTheServerClock
TestCrashBeforeAnyWriteRollsBackEverythingAndARetrySucceedsOnce
TestAmbiguousCommitIsResolvedByTheReceiptOnRetry
TestEveryStatementFailureInIngestIsReportedAsAnInternalError
TestScriptedRefusalsAndCorruptReceipts
TestIngestRefusesMalformedRequestMetaBeforeTouchingTheDatabase
TestDefaultLimitConfigMatchesTheCapacityAssumptions
TestDeviceBucketAllowsABurstThenThrottlesAndRefills
TestOneNoisyDeviceDoesNotThrottleAnother
TestTenantBucketLimitsAllOfATenantsDevicesAndDeniedRequestsConsumeNothing
TestConcurrentRequestsNeverExceedTheBurst
TestBucketsBackToFullAreReclaimedWhenTheStoreIsFull
TestMemoryPressureNeverResetsAThrottledDevice
TestTheTenantSetRefusesNewTenantsUnderMemoryPressureToo
TestUnusableLimitConfigurationFallsBackToTheDefaults
TestParseRejectsEveryQualityViolationWithItsReason
TestParseAcceptsBoundaryValuesAndNormalisesTime
TestParseHonoursACustomPolicy
TestBindingRuntimeConfigLifecycleAndApply
TestBindingRunWorkerFailureAndCancellation
TestBindingHTTPReadinessMetricsAndRetryAfter
TestBindingRunStopsHTTPOnWorkerFailure
TestBindingWorkerResultDuringShutdown
TestMetricsExactText
TestMetricsHandlerMethodAndHeaders
TestMetricsConcurrent
TestBindingKafkaAdapterSeams
TestBindingKafkaPoisonThenGoodAndRestartFrontier
TestBindingKafkaRetryExhaustionPreservesBrokerOffset
TestHundredRejectionsLeaveAtMostTwentySamplesAndNeverStoreTheBody
TestRejectionSamplesAreThrottledPerDevice
TestRejectionsWithoutValidIdentityAreOnlyCounted
TestThrottleMapEvictsOnlyExpiredEntries
TestRecordNeverFailsTheCallerWhenTheDatabaseDoes
TestRejectionSamplesAreTenantIsolatedAndOverwriteOnly
TestOnlyDevicesWithABindingGetRejectionSamples
TestNotReadyRejectionsAreCountedButNeverSampled
TestWithTenantRejectsInvalidTenant
TestWithTenantBeginFailure
TestWithTenantSetConfigFailure
TestWithTenantSetsTransactionLocalTenant
TestWithTenantFnErrorRollsBack
TestWithTenantRollbackErrorDoesNotMaskOriginal
TestWithTenantPanicRollsBackAndRepanics
TestWithTenantCommitFailure
TestWithTenantRollbackSurvivesCancelledContext
TestWithTenantDoesNotLeakOnPooledConnection
TestBindingFeedFreshStaleDisabledMissingAndClockSkew
TestBindingFeedRejectsMalformedCheckpoint
TestBindingFeedPersistenceAndMetricsFailures
TestBindingConsumerCheckpointDisposition
TestBindingFeedAdmissionAfterReceiptAndBinding
TestBindingFeedConfig
TestBindingFeedDatabaseMonotonicityAndPrivileges
TestBindingFeedCommitFailureNeverCommitsKafkaOffset
TestReviewRefreshDoesNotLockCachedReaders
TestReviewReceiptPrecedesAgeAndPreservesConflict
TestReviewUnknownBindingDoesNotAllocateThrottle
TestReviewColdCacheWaitersShareCompletion
TestReviewRefreshRecoveryAndInvalidResponses
TestBindingConsumerEveryQuarantineReason
TestBindingConsumerRetryAndCommitFrontier
TestBindingConsumerExhaustionAndPermanentFailuresNeverCommit
TestBindingConsumerPoisonThenGoodAndStopsAtFailure
TestBindingConsumerRetryCancellationAndClassification
TestBindingConsumerExistingApplyPathDuplicateStaleAndGap
TestBindingConsumerDatabaseCrashAndTenantIsolation
TestBindingConsumerSchemaBoundary
TestConfigDefaultsLeaveTheEndpointDisabled
TestConfigReadsEveryOverride
TestConfigRejectsMistakesWithoutEchoingValues
TestABurstOfExactlyOneIsAccepted
TestParseInventoryEventAcceptsSharedFixtures
TestParseInventoryEventRejectsUnsafeFixtures
TestParseInventoryEventEdgeCases
TestRegisteredEventCreatesBindingAndStream
TestDuplicateDeliveryHasOneEffectAndReusedIDsConflict
TestChangesMustFollowTheDeviceSequence
TestChangeForAnUnknownDeviceWaitsForRegistration
TestConcurrentDuplicateDeliveriesConvergeOnOneEffect
TestConcurrentCompetingChangesApplyOnce
TestApplyReportsDatabaseFailures
TestEveryDatabaseFailureIsReportedAndNothingIsAppliedTwice
TestParseRejectsAVersionThatFitsTheFormatButOverflowsInt64
TestRunRejectsBadConfiguration
TestMainExitsNonZeroOnFailure
TestRunReportsPoolInitializationFailure
TestRunReportsInvalidIngestConfigurationBeforeConnecting
TestBuildAppReportsSetupFailures
TestRunReportsAppSetupFailures
TestWriteAuthErrorHandlesEveryStatus
TestAuthRequireRole
TestAuthNewVerifierValidation
TestAuthAuthErrorString
TestTraceContinuation
TestRootOnBadTraceparent
TestSampling
TestServerErrorMarksSpan
TestSpanNamesHaveNoIdentifiers
TestActiveTraceparent
TestOTLPBranchShutdownDoesNotHang
TestInvalidEndpoint
TestNoExporterAndReinit

```
