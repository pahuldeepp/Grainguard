# Whole-tree gate, 2026-09-25

Run by the coordinating session on the uncommitted working tree (HEAD `176f449`, about 140 changed files) after the Stage 07 close-out, the Stage 08 OIDC, Redis Cluster, CI wiring and browser work, and four rounds of SonarQube clean-up by separate agents. Every line is a command that was run and its real outcome. This is local evidence only: nothing was pushed and none of the new CI jobs has run remotely.

## Static and unit gates

| Command | Result |
| --- | --- |
| `make verify` | exit 0 (after formatting four files) |
| `make coverage` | exit 0 |
| SonarQube scan, `-Dsonar.scm.disabled=true` | quality gate PASSED: coverage 84.3% (new 84.3%), duplicated lines 0.0%, violations 0; all six conditions OK |

Scan notes: the default scan hangs in the scanner's Git blame step under emulation, so SCM attribution was disabled. CI runs the default scan, so its "new code" conditions may differ. An earlier scan crashed because the scanner's JavaScript engine ran out of Docker memory (Cassandra, Elasticsearch and SonarQube running together) and uploaded nothing; Sonar then kept showing the older analysis. Cassandra, Elasticsearch and Dex were stopped for the scan that counts.

## Live tests

| Command | Result |
| --- | --- |
| `make hardware-kafka-test` | PASS after the live-test refactor |
| `node scripts/stage07-e2e.mjs` | exit 0: two-tenant provisioning with signed MQTT ack; race (202 and 409); kill of all four workers at each saga version (16 kills); outage; timeout compensation (configure receipt `cancelled`); redrive; stale lease; broker pause |
| `make browser-e2e` | ALL BROWSER E2E CHECKS PASSED in 100 s: Dex login (auth code + PKCE), provisioning from the UI, reload and reconnect, failure and repair states, read views (latest, recent, 48 h history from Cassandra, search), two-tenant isolation, viewer limits, read-error and recovery states |

Earlier the same day the same coordinating session ran `make redis-test` (8 of 8 scenarios) and `make oidc-test` (26 checks) against the live cluster and Dex; those are recorded in their own evidence files.

## Not verified

- No remote CI run of any of the above, including the new `redis-integration`, `oidc-integration`, `oidc-browser-integration`, `history-integration`, `search-integration`, `stage06-integration` and `stage07-integration` jobs.
- The cache invalidator (owned by another session) has no live proof recorded here.
- mTLS between services is not implemented (Stage 07 slice 5).
- The saga worker derives its traceparent from saga and command IDs instead of carrying the API request's real trace context.
- The Cassandra writer exits for good when Cassandra dies instead of retrying.
- The Read API startup bound (2 s wait for Redis) has no in-repo test.
- Independent tenant-isolation and architecture reviews of Stages 06 to 08, and a CodeRabbit review of this tree, have not been run.
- axe-core was not installed; accessibility was checked with Playwright snapshots and custom checks.
