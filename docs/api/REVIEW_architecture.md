# Architecture review of the four BFF API designs (2026-09-26)

Reviewer: `architecture-guard` (read-only; text saved here by the coordinator). Scope: `bff-alert-detail.md`, `bff-alert-history.md`, `bff-bin-readings.md`, `bff-alert-notifications.md`. A sample of their claims was checked against the code; live row counts were not re-verified.

## Verdicts

| Design | Verdict | Reason |
| --- | --- | --- |
| alert-detail | Approve with changes | Facility-projection path follows the invariants. Fix the migration-number collision, the stale cache claim, the missing projection notification, the `acknowledgedBy` conflict. |
| alert-history | Approve with changes | Most careful design. Needs an ADR for actor identity; `acknowledgedBy` redaction and shared `escalatedAt` must be settled with alert-detail. |
| bin-readings | Approve with changes | Sound. Does not flag that `services/projection-builder` is Codex-owned; collides on migration 000016 and shared files; mis-describes ADR-0016. |
| alert-notifications | Reject as written | Recommended option B (new `services/notification-history` reading the jobs, notifications and DynamoDB stores directly) breaks "no service reads another service's tables". Contract, privacy and state-mapping sections are reusable. Resubmit on option A (owner-provided read surfaces) or with an accepted ADR. |

## Claims checked against the code

- Facility-topic gap CONFIRMED: `projection-builder` (`event.go:55`, `consumer_kafka.go:21`, `replay.go:62`) subscribes only to inventory and telemetry topics; the transformer routes `site.changed`/`bin.changed` to `greenguard.inventory.facility.v1`; last projection migration is 000015. The H6 text in ARCHITECTURE_REVIEW.md is stale.
- `alert_transitions` claims CONFIRMED (index, checks, `recordSuppressedEscalation` reusing the version at `store.ts:283-300`, ack actor = `principal.subject`). Live counts not verified.
- Read-api hot window CONFIRMED: `main.ts` never passes `hotWindowMs`; `app.ts:70-74` defaults to 24 h + 5 min; `rollup_outside_hot_window` at `app.ts:199`.
- Notifications: UNIQUE `(tenant_id, episode_id, transition_version, channel)` exists; `delivery_generation` exists; `jobs-worker/store.go:43-44` skips critical intents; intent-id namespace identical in Go and Python.
- `toAlertDto` has no `escalatedAt` (`parse.ts:71`); two designs both claim to add it.
- "ADR-0016 does not exist": true for the file but misleading: the code cites it (`read-api/src/cache.ts:35,51,399`, `cache-invalidator/keys.go:10`) meaning the global epoch after a Redis outage plus device-versioned entries. It is a real gap to BACKFILL. `docs/adr/` also lacks 0012 and has two 0018 files.
- Stale claim in alert-detail: it says the cache-invalidation caller is unbuilt. `services/cache-invalidator` exists and the `projection_notifications` trigger (migration 000009) already gives non-telemetry events `scope = tenant`, so a facility consumer that writes a `projection_notifications` row in the same transaction invalidates the tenant cache generation.

## Definitive conflict list

- C1 Migration `000016` claimed twice (alert-detail `facility_views`, bin-readings `device_views_bin` index); both are Codex-owned projection-builder work. Use "next free number", ordered.
- C2 `escalatedAt` added twice in `toAlertDto` (`workflow-alerts/src/api/parse.ts`) and declared twice in SDL. One task.
- C3 Two detail operations for one field: `alertDetailEnriched` vs `alertDetailV2`. Merge into one.
- C4 Raw `acknowledgedBy` exposure: alert-detail adds it raw; alert-history calls the raw subject a privacy defect and redacts. Redaction applies everywhere; compute `isYou`/`handle` in `workflow-alerts` (the BFF cannot duplicate the hash).
- C5 Shared-file collisions needing ONE integrator in a fixed order: `services/bff/src/{query-policy,schema,rate-limit,main,read-client}.ts`, `packages/read-model/src/index.ts`, `services/read-api/src/{app,backends,cache,main}.ts`, `apps/mobile/src/alerts-client.ts`, `apps/dashboard/src/alerts-api.ts`.
- C6 Transitions route is a task in both history (T1) and notifications (task 3): merge; notifications consumes history's DTO (version as string, `include=lifecycle`, cap 100).
- C7 Read-api route additions (`POST /bins/batch`, `GET /bins/:binId/readings/{latest,trend}`) both change `cacheBackends` and cache kinds: order them.
- C8 Null semantics: three partial-availability conventions (nullable+counters, `complete`, `sources`); `bin_views` must land before bin-readings can distinguish unknown from unbound. Fix one convention in an ADR.
- C9 Enum policy differs (String vs new enums): pick one rule.
- C10 Naming: `alertListEnriched`/`alertDetailV2`; argument `id` vs `alertId`; a literal SHA-256 embedded in the notifications doc will go stale.
- C11 Codex-owned trees touched: alert-detail (`workflow-alerts` T4/T8, `projection-builder` T5); alert-history (`workflow-alerts` T1-T3); bin-readings (`projection-builder` T1, unflagged); notifications (`workflow-alerts` task 3, `infra/cdk` 9, `jobs-worker` 10, `notification-service` 11, plus grants inside the jobs and notifications databases).

## Required changes (file/section)

1. notifications §3, §9: replace option B (owner-provided views/endpoints agreed with the Codex session, or an accepted ADR exception with an expiry); DynamoDB reads go behind an owner surface too.
2. notifications §9 task 4: grants that alter another service's schema need owner agreement.
3. notifications §9 task 3 + history §7 T1: single transitions-route task.
4. notifications §1.2/§4.1/§4.2: argument `id`; drop the literal hash, use a golden-hash test.
5. notifications §3.1/§5: add the new service to `sonar-project.properties` and `scripts/coverage.mjs`; state channel mapping per notifying transition (unverified).
6. alert-detail §2.2: "next free number"; add the `projection_notifications` write; correct §4 Caching.
7. alert-detail §2.2/§7 Q5: task 5 is Codex-owned (projection-builder), agreement gate.
8. alert-detail §3.2 + history §3.2: merge into one detail and one list operation.
9. history §1.4/§3.3: redaction in `workflow-alerts` (`isYou`/`handle` in its DTO), not the BFF resolver; owner for the release note.
10. history §2.3 + alert-detail F11: one owner for `escalatedAt`.
11. history §4: reword the ADR-0016 line (cited by code, needs backfilling).
12. bin-readings §6.4 T1: Codex-owned migration, "next free number"; `bin_views` supersedes the "cannot check existence" limitation (§4.4).
13. bin-readings §6.3 Q6: describe ADR-0016 as global epoch + device version stamps.
14. bin-readings §3.1: `String` instead of enums, or an ADR carve-out.
15. bin-readings §6.4 T4: state whether `tests/integration/**` is intentionally outside Sonar coverage.
16. All four: drop "next free is 0023"; use the ADR numbers below.
17. `docs/MOBILE_DATA_AVAILABILITY.md` item 13 and `ARCHITECTURE_REVIEW.md` H6: update once the facility consumer lands.

## Recommended persisted-operation naming

Existing `alertList`, `alertDetail`, `acknowledgeAlert` stay frozen and byte-identical. New pattern `<domain><Noun><Qualifier>`, `V<n>` only when replacing an existing shape: `alertListV2`, `alertDetailV2` (one merged operation), `alertHistory`, `alertNotifications`, `binReadingsLatest`, `binReadingsTrend`. Arguments: `id` for alert-scoped, `binId` for bin-scoped. Hash = `sha256(exact string)` (unchanged); one golden-hash test file pins every shipped operation. Cost classes: alertListV2 read 2, alertDetailV2 read 1, alertHistory read 1, alertNotifications read 2, binReadingsLatest read 2, binReadingsTrend read 5.

## Recommended implementation order

1. ADRs before code. 2. One BFF foundation task (golden-hash test, single integrator for `query-policy.ts`, `schema.ts`, `rate-limit.ts`). 3. One reviewed `workflow-alerts` change, once the Codex session agrees: transitions route, `alert-rules` route, `escalatedAt`, `isYou`/`handle`, cross-tenant tests. 4. `projection-builder` (agreed with Codex): `bin_views`/`site_views`, facility topic in consumer and `replayTopics`, H5 validation, projection notification, `device_views_bin` index in next free migration numbers. 5. Read layer: `READ_HISTORY_HOT_WINDOW`, read-model queries, read-api routes with cache kinds. 6. BFF resolvers and operations. 7. Dashboard, then mobile last (a new client against an old BFF gets `operation_not_allowed`). 8. Notifications only after the ADR is accepted and the owner agrees. 9. Live E2E, evidence, doc updates.

## Invariants at risk

One owner per database (notifications option B); grants outside owner migrations; layered tenant isolation (explicit `tenant_id` predicates on `bin_views` and `alert-rules` in addition to forced RLS); idempotent consumers (the facility consumer must use the inbox, version guard and commit-after-effect pattern); privacy (raw `acknowledgedBy`); coverage (new service and `tests/integration` not in Sonar lists); pin `@aws-sdk/client-dynamodb`.

## ADRs needed

`docs/adr/` has 0011 and 0013 with 0012 and 0016 missing, and two files numbered 0018. Highest used: 0022.
- ADR-0016 (backfill) `read-cache-epoch-and-device-versions`.
- ADR-0023 `facility-projection-and-enriched-alert-reads`.
- ADR-0024 `alert-actor-identity-display`.
- ADR-0025 `notification-history-read-path`.
- ADR-0026 `bin-readings-history-routing` (optional).
- Do not renumber the duplicate 0018; record it in the ADR index.

## Safe to proceed?

Not for all four. alert-detail, alert-history and bin-readings can proceed once the collisions and stale claims are fixed and the Codex owner agrees to the `workflow-alerts` and `projection-builder` changes. Notifications is blocked on a read path that respects one-database-per-service.
