# Model gateway

Status: **HTTP/provider and local gateway controls implemented; production identity and full I6 certification remain pending**.

This Go service exposes the endpoints consumed by `knowledge-service`:

- `POST /v1/embeddings`
- `POST /v1/rerank`
- `POST /v1/answers`

It validates bounded request bodies, authenticates a bearer token by SHA-256
digest against a server-side tenant/scope binding, checks that request tenant IDs
match that binding, applies per-task model allowlists, calls configured providers over HTTPS, and validates dimensions, ranking indexes, and cited chunk
IDs. It does not log prompt or response bodies. Legacy mode uses JSON-mode chat completions. Native mode is described below.

## Configure and run

`MODEL_GATEWAY_ACCESS_FILE` points to a secret-managed JSON file shaped like:

```json
{
  "token_hashes": {
    "<sha256-of-caller-token>": {
      "tenant_id": "<tenant-uuid>",
      "scopes": ["knowledge:embed", "knowledge:rerank", "knowledge:answer"],
      "trusted_user_context": true
    }
  },
  "embedding_models": {"embed-v1": "provider-embedding-model"},
  "reranker_models": {"rerank-v1": "provider-chat-model"},
  "answer_models": {"answer-v1": "provider-chat-model"}
}
```

Set `MODEL_GATEWAY_PROVIDER_URL` to the provider's HTTPS base ending in `/v1`,
`MODEL_GATEWAY_PROVIDER_KEY` from the secret manager, and optionally
`MODEL_GATEWAY_LISTEN_ADDR` (default `:8080`). Never put bearer tokens or provider
keys in this file; only SHA-256 caller-token digests belong there. Caller tokens
are tenant-bound and need secure rotation by the runtime that provisions them.

Run `make model-gateway-test` for unit tests and static checks. Local development
can use an OpenAI-compatible mock on loopback HTTP; non-loopback provider URLs
must use HTTPS.

## Not production-complete yet

- The current caller registry is a static digest-to-tenant/scope file. It is not
  the repository's OIDC/JWKS client-credentials verifier and does not rotate or
  revoke tokens dynamically.
- Local Redis admission/concurrency and PostgreSQL accounting/outbox are implemented below. Full sharded I6 budgets and billing reconciliation remain pending.
- Real Voyage/Pinecone acceptance was previously run. Funded Claude generation, streaming, Bedrock routes, entitlement projection, and production deployment remain pending.

Do not expose this service publicly or treat it as the production AI admission
gateway until those I6 controls are in place.

## Native Voyage and Anthropic mode

Set `MODEL_GATEWAY_VOYAGE_URL=https://api.voyageai.com/v1` and
`MODEL_GATEWAY_ANTHROPIC_URL=https://api.anthropic.com/v1`.
`MODEL_GATEWAY_VOYAGE_KEY_FILE` and `MODEL_GATEWAY_ANTHROPIC_KEY_FILE`
point to regular key files with no group/other permission bits (0600).
Invalid/unreadable key files produce missing-key startup errors.
Voyage uses native `/embeddings` (passage maps to document, 1024 dimensions,
truncation disabled) and `/rerank` (top_n maps to top_k).
Claude uses native `/messages`, separate credentials, bounded output and
citation validation. Redirects are refused. SIGTERM/SIGINT publish draining readiness for 5 seconds, then allow up to 135 seconds for active HTTP requests to finish. The drain covers the maximum 120-second provider request budget plus the HTTP response margin. Dependency pools remain open until draining completes. If draining exceeds its bound, active connections are closed and the shutdown returns an error.
Gateway deployments must use `terminationGracePeriodSeconds: 150` or greater in Kubernetes and `stop_grace_period: 150s` or greater in Compose. This includes 5-second readiness withdrawal, 135-second request drain and 10-second process-exit margin. There is currently no Gateway deployment manifest in this repository; carry these settings into its eventual deployment. Add any preStop hook time to the 150-second minimum.

Logical routes: embed-v1 → voyage-4-large, rerank-v1 → rerank-2.5,
answer-v1 → claude-haiku-4-5-20251001 for the local staging probe.
Real Claude acceptance passed locally on 2026-10-03 for a six-page document summary; production acceptance remains separate.

## Gateway production controls (local acceptance)

BFF rate limiting remains unchanged. AI calls additionally run through:

`validated tenant/user → Redis tenant/workload/user admission → provider account admission → Postgres worst-case hold → bounded provider attempt → usage settlement + transactional outbox`

- Redis uses the same token-bucket/Lua approach as BFF, with separate `ai:rate:{tenant}:...` keys. Tenant/user/workload checks are atomic in one Cluster slot; provider-account admission has its own slot. A provider denial releases tenant concurrency but conservatively keeps its consumed rate token. Distributed sorted-set leases recover after crashes. Redis failure denies egress with 503. Indexing concurrency must leave query headroom.
- Postgres owns money and token quotas. Runtime cannot provision accounts, increase limits, own tables, or bypass RLS. A pessimistic global→tenant→user lock order with `FOR UPDATE NOWAIT` prevents overspending. Busy rows return 429 `budget_busy` with a one-second retry hint, as required by the I6 money/quota design; no waiting queue is hidden behind provider admission. Ledger settlement and usage outbox are one transaction; repeated settlement is idempotent. Unknown transport/5xx usage charges the full hold. A 60-second reaper settles holds older than five minutes at full reservation after crashes. There is no automatic refund of uncertain usage.
- Every retry/fallback obtains new admission and a new reservation. Transport errors and 5xx retry with bounded exponential jitter. Provider 429 responses return immediately with their Retry-After hint; permanent 4xx do not retry. Config caps attempts at three and total gateway deadline at 120 seconds. Ordinary authenticated RAG queries propagate a shared 20-second remaining model-call deadline. Explicit complete-document summaries use a bounded 280-second workflow deadline and up to 110 seconds per call; configured attempt/total controls may shorten each call.
- Circuit breakers are **per gateway process and provider/model**, with a single half-open probe. Redis admission and budgets remain shared across replicas. Circuit state is deliberately ephemeral; a pod restart closes it. Distributed circuit state is not claimed.
- Fallback is explicit, same-provider/protocol, and allowlisted for the same task. Each target requires prices and its own funded hold. Embedding fallback is prohibited. The live configuration has no fallback target enabled because no alternate generation provider is provisioned.
- Knowledge query code propagates its verified membership principal through request-scoped ContextVar state. Only a caller binding marked `trusted_user_context` can assert that header. Alternatively bind `principal_id` to a specific user, or `workload: indexing` with embedding-only scope. Query embedding/rerank/answer require user context for those bindings; indexing passages use workload capacity. This trusts the authenticated knowledge workload and is **not** the future short-lived delegated-token protocol.

### Run locally

```sh
python3 services/model-gateway/setup-local-controls.py --execute --principal <verified-user-uuid>
services/model-gateway/run-local-providers.sh
make model-gateway-acceptance
```

The setup uses the isolated `gg-rag-local-1001-postgres-1` stack (override with
`GATEWAY_ACCEPTANCE_POSTGRES_CONTAINER` / `GATEWAY_ACCEPTANCE_POSTGRES_PORT`),
a dedicated `greenguard_ai_usage` database and loopback Redis on 18179. Provider
keys remain under `~/.config/greenguard/secrets`; DSNs and configuration are 0600.
No AWS deployment or provider billing changes occur. Account seeding preserves
existing spending: global $300/month, tenant $30/month, configured user $5/month.
Provision each real membership principal before querying; missing budget rows
fail closed. Provision the next UTC monthly period before rollover.

Set `redis_cluster: true` in the controls file to use cluster discovery from the protected seed URL; Lua keys stay within their hash slots. Only single-node Redis was exercised locally. Redis and Postgres require TLS outside loopback.

Production startup requires `MODEL_GATEWAY_CONTROLS_FILE`,
`MODEL_GATEWAY_REDIS_URL_FILE`, and `MODEL_GATEWAY_BUDGET_DSN_FILE`.
Uncontrolled mocks require `MODEL_GATEWAY_ALLOW_UNCONTROLLED_LOCAL=true` and a
loopback listen address. Pricing uses configured USD microdollars per million
tokens; estimates assume no free-tier/cache discount. Voyage rerank estimates
repeat query tokens per document, per the [provider pricing contract](https://docs.voyageai.com/docs/pricing).

The same image also includes `/model-gateway-budget-bootstrap`. Run it after
the schema migration and before the gateway becomes ready, then monthly with
the same explicit cap document. It reads `MODEL_GATEWAY_BUDGET_DSN_FILE`,
`MODEL_GATEWAY_BUDGET_CAPS_FILE`, and `AI_RDS_HOST`; both files must be private
0600 files. The cap document defines a platform cap and explicit tenant rows,
with optional explicit user rows. The command authenticates as the verified
`model_gateway_migrator` owner over `verify-full` TLS, requires non-superuser
and `NOBYPASSRLS` role attributes, applies tenant RLS context for every tenant,
and updates only the current UTC-month caps. It does not delete omitted accounts
or reset held/spent usage; any cap below already held plus spent usage rejects
the entire transaction. The disposable AI runtime chart runs this as an Argo
sync-wave Job before the Gateway Deployments and repeats it in a UTC-monthly
CronJob. Terraform emits its protected Secret only when the caller supplies
explicit cap JSON whose tenant set exactly matches the configured Gateway
tenants. Chart and Secret contracts have static/local checks; no RDS execution
or AWS acceptance is implied.

### Scope and remaining deployment gates

This is a working local controls slice, not full I6 certification. Budget accounts
currently have one row per scope (no shard spreading); no 10M-user throughput
claim is made. The usage outbox is durable but its billing/CDC consumer and provider
invoice reconciliation are separate integrations. Uncertain charges may need
manual reconciliation. Entitlement/data-policy projection, delegated identity,
streaming, multi-provider failover, TLS/ACL Redis deployment, cloud secret stores,
and production load/availability proof remain deployment work. No hosted IdP or
AWS acceptance is implied by local tests.

### Trusted prompt caching profile

Native Claude requests mark only the versioned application evidence protocol in
`prompt_cache.go` with a 5-minute cache breakpoint. The task-specific system
instruction, question, observations, and tenant data follow that breakpoint.
Caching does not replace fresh authorization, owner reads, or citation checks.
Only sanitized creation/read token counts are logged as `anthropic_prompt_cache`.
Token quotas include ordinary input, cache creation, cache reads, and output;
settlement applies the configured model's input rate at 1×, 1.25× and 0.1×,
respectively, with one final rounding to microcurrency. Reservations assume the
entire bounded input may incur a cache creation surcharge.

The local Haiku 4.5 `answer-v1` default remains unchanged and its 4,096-token
minimum exceeds this shared protocol. Opt in with a separate access-file alias,
for example `answer-cache-v1: claude-sonnet-4-6` under `answer_models`, and a
`claude-sonnet-4-6` controls price of `input_micros_per_million: 3000000` and
`output_micros_per_million: 15000000`. BFF `BFF_AGENT_MODEL=answer-cache-v1`
selects that profile for planning and final synthesis. This alias is operator
configuration, not a model name accepted from a user request. The live local
Sonnet profile reported 1,474 cache creation tokens, then 1,474 cache read tokens;
this does not claim cache hits for the default Haiku profile.

Provider contract and pricing reference:
https://platform.claude.com/docs/en/build-with-claude/prompt-caching
