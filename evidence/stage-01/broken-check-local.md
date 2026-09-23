# Deliberately broken required checks — local `make verify`

Run: 2026-09-23T16:43:24Z on base commit e675d22. Each case changes one file, runs `make verify`, then restores the file.

## Go unit test fails

Exit code: **2**

```text
--- FAIL: TestDeliberatelyBroken (0.00s)
    main_test.go:207: deliberate failure
FAIL
FAIL	greenguard.local/telemetry-ingest	0.344s
FAIL
```

## TypeScript unit test fails (device-service)

The injected test is Prettier-formatted, so formatting passes and the failure comes from the test runner.

Exit code: **2**

```text
✖ deliberately broken (0.365917ms)
ℹ fail 1
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
make: *** [verify] Error 1
```

## Formatting check fails (dashboard)

Exit code: **2**

```text
[warn] apps/dashboard/src/health.ts
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
make: *** [verify] Error 1
```

## Control: restored tree

Exit code: **0**. All checks pass with the original files restored.
