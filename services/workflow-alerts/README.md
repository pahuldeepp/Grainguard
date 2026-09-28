# services/workflow-alerts

Status: **Stage 06b implemented locally** (alert lifecycle core, command API, live
Postgres tests). The two-topic Kafka adapter is implemented; live Kafka intake
and CDC capture of the lifecycle outbox still require end-to-end evidence.
Evidence: [STAGE_06B_VALIDATION](../../evidence/STAGE_06B_VALIDATION.md).

Technology: NestJS 12, Prisma 7 (`@prisma/adapter-pg` over PgBouncer), `node:test`.

Owns `greenguard_alerts` (runtime role `alerts_app`, schema owner `alerts_migrator`).
Design: [Stage 06 plan](../../docs/STAGE_06_PLAN.md) row 06b and "alert lifecycle".

## Tables (`prisma/migrations/20260924100000_alert_lifecycle`)

| Table                   | Purpose                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `alert_rules`           | Tenant rule config; default `grain-risk-default` seeded on first event           |
| `alert_episodes`        | Episode per (tenant, rule, bin, open window); monotone `version`                 |
| `risk_stream_positions` | Per device `assessment_version` watermark; stale/reordered events are no-ops     |
| `consumer_inbox`        | Normalized source event + the effect it produced                                 |
| `alert_transitions`     | Append-only audit of every transition, incl. `escalation_suppressed` receipts    |
| `command_receipts`      | Idempotency-Key receipts for acknowledge                                         |
| `outbox_events`         | `greenguard.alerts.lifecycle.v1` events, CDC publication `greenguard_alerts_outbox` |

All tables: `tenant_id`, forced RLS, composite tenant FKs, no DELETE grant.

Default policy: open at score >= 40 with an alert-eligible severity, resolve only
below 25 (hysteresis), escalate once after 15 minutes unacknowledged.
`insufficient_data` never opens or resolves.

Backdated grain-lot placement emits `risk.assessment_invalidated` on
`greenguard.risk.assessment_invalidated.v1`. The second migration records the
current assessment ID on an episode. Invalidation advances the device stream
watermark and resolves an episode only if that assessment is still its cause;
newer scores win. All effects, inbox and outbox share one tenant transaction.

## Concurrency (ADR-0002)

- Scoring: advisory lock per (tenant, rule, bin), backed by `UNIQUE (tenant_id,
  rule_id, monitored_resource_id, open_window_start)` and a partial unique index
  allowing one unresolved episode.
- Acknowledge vs escalate: `SELECT ... FOR UPDATE` on the episode row, bounded by
  `lock_timeout` (409 `resource_locked` + `Retry-After`). Escalation re-checks state
  under the lock and writes a no-op receipt when the episode is no longer open.
- API: optimistic `If-Match: "<version>"` (428 missing, 412 stale with current ETag).

A command **timeout is not a rejection**: the first attempt may have committed.
Clients retry with the same `Idempotency-Key` and receive the stored outcome.

## Event IDs

Lifecycle event IDs are `deterministicId(tenant, episode, version, type)`; episode
IDs derive from (tenant, rule, bin, window start). Replays reproduce the same IDs.

## API

- `GET /v1/alerts?limit&after&state` (viewer, operator, admin): keyset pagination.
- `GET /v1/alerts/:id` with `ETag`.
- `POST /v1/alerts/:id/acknowledge` (operator, admin) with `Idempotency-Key` and
  `If-Match`. Tenant comes only from the signed token; foreign IDs return 404.

## Consumer

`handleRiskEvent(db, event)` (framework-agnostic) validates `risk.assessed` or
`risk.assessment_invalidated`, then in
one tenant transaction writes inbox, episode, transition and outbox. Duplicates
return the stored effect; same `event_id` with different content returns
`conflict` for quarantine. `runConsumer` is the transport loop behind the
`EventSource` interface: commit only after the effect or a confirmed quarantine,
bounded retry, never skip. With `KAFKA_BROKERS` set, KafkaJS subscribes to both
risk topics under `ALERTS_KAFKA_GROUP` (default `workflow-alerts`). It publishes
poison records to `greenguard.quarantine.v1` before committing their offsets.
The Kafka adapter needs a live broker restart/redelivery test before the stage gate.

Not yet built: the cross-tenant escalation scheduler (the worker function
`escalateIfStillUnacknowledged` exists and is tested per episode).

## Commands

```bash
set -a; . ./.env; set +a
npm run migrate -w services/workflow-alerts
npm test -w @greenguard/workflow-alerts
npm run coverage -w @greenguard/workflow-alerts
```

## Owner alert reads and privacy (ADR-0023/0024)

- `GET /v1/alert-rules?ids=` accepts 1–50 lowercase UUIDs, deduplicates them and
  returns only caller-visible rules to viewer/operator/admin. `openScore` and
  `clearScore` are risk-score hysteresis, not agronomic measurement limits.
- `GET /v1/alerts/:id/transitions?limit&after&include` defaults to lifecycle rows,
  limits pages to 1–100 (default 50), and permits `include=all` only for admins.
  Unknown/foreign alerts return the same 404 before history/coverage reads.
  Page, episode and coverage use one repeatable-read tenant transaction.
  Ordering is version, timestamp (including microseconds), transition UUID.
  Signed cursors bind tenant, alert, mode and full ordering position.
- History `complete` describes retained lifecycle versions from opening through
  the episode version, independently of page size or diagnostics. Missing
  coverage returns `source.status=partial`; no historical score is fabricated.
- All public alert DTOs use owner-mapped `{kind,isYou,handle}` actors; they expose
  no raw subject, cause ID or event ID in history. `escalatedAt` is the stored
  nullable episode timestamp. Service and device principals are denied.

Authenticated startup requires server-only `ALERTS_ACTOR_HMAC_KEY` and
`ALERTS_HISTORY_CURSOR_KEY`, each at least 32 bytes. Provision independent random
keys through deployment secrets; rotate display keys knowing handles change,
and rotate cursor keys knowing outstanding cursors expire. There is no hash or
unsigned fallback. Audit pseudonyms use a separate HMAC purpose and full digest.
New HTTP acknowledgements atomically persist the verified issuer in episode,
transition and outbox metadata, retaining the existing v1 event payload bytes.

Privacy compatibility release note: `acknowledgedBy` remains nullable text but
now returns `you`, `member-<keyed handle>` or `team-member`. Legacy issuerless
identities never claim “You” and return a null handle. Old API selections get
this redaction without changing operation documents. Raw stored identities and
historical outboxes still need the later retention/erasure policy in ADR-0024.
For Cognito user access tokens, set `AUTH_TOKEN_MODE=cognito-access`,
`AUTH_COGNITO_CLIENT_IDS`, `AUTH_ISSUER`, and `AUTH_JWKS_URL`. The runtime
requires `AUTH_MEMBERSHIP_SOURCE=control-plane`, `CONTROL_PLANE_URL`,
`CONTROL_LOOKUP_TOKEN`, and the membership Redis/Kafka settings used by the
shared membership client. The token's issuer and subject are mapped to tenant
roles by the control plane; tokens with no membership are denied. The default
Dex audience mode remains unchanged.

## Tenant placement routing

Set `SHARD_REGISTRY_FILE` to the private version 1 `workflow-alerts` / `greenguard_alerts` registry with all four `s1`–`s4` primaries, incarnation UUIDs and `alerts_app` credentials. Set `CONTROL_PLANE_URL` / `CONTROL_LOOKUP_TOKEN` for authenticated placement authority. Production PostgreSQL URLs require `sslmode=verify-full` and `sslrootcert`; local loopback manifests require `SHARD_LOCAL_LOOPBACK=true`. `ALERTS_DATABASE_URL` is required only for the legacy runtime when no registry is supplied.

HTTP operations, risk-event consumption and explicit tenant escalation all resolve the tenant owner and admit its exact incarnation and epoch inside the existing Prisma transaction, before business SQL. Inbox/effect/position/episode/transition/outbox atomicity and receipt/event IDs stay unchanged. No request or event route field selects a database endpoint; inactive, unknown or locally stale placement fails closed. HTTP placement failures return a retryable 503 problem. Risk handlers do not commit an offset on placement failure.

Readiness checks all owner primaries concurrently with a one-second caller timeout. Consumer shutdown still precedes database closure; closing all shard pools has a five-second caller bound.
