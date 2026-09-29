# GreenGuard Intelligence: I6 Model gateway, LLM serving and vLLM · I11 QLoRA fine-tuning and model lifecycle

Status: draft design section, 2026-09-28; conformed to the binding [README](README.md) rev 2 (R14, R19–R24, R29, R31, name registry §3, stage table §5) on 2026-09-29. Where this file and the README disagree, the README wins. Every capacity, latency and dollar figure below is **UNMEASURED** until a stage evidence file under `evidence/` replaces it. API claims were checked against the bundled `claude-api` skill (models cached 2026-09-25), vLLM docs and TRL v1.0.0 docs through context7. Recheck them when you pin versions.

Invariants carried from the platform: one write owner per database; every tenant table has `tenant_id`, forced RLS and a non-owner runtime role; a state change and its event commit together through the outbox; consumers are idempotent through an inbox; IDs are created once; every contended row has a documented lock choice.

**Dependencies (README §5).** I6 depends on GG-02b (tenant auth, contracts), **GG-04** (outbox/CDC onboarding of the new `greenguard_ai_usage` source DB) and **GG-05**; under the README §5 rule no I-stage other than I0 starts before the GG-04 and GG-05 exit gates (linked evidence and green remote CI, or an owner-signed waiver, ADR-0023). Plan tiers and entitlements come from GG-09; until GG-09 exists the gateway reads a **local budget/entitlement config file** (per-tenant monthly cap, allowed model classes), loaded at start-up and validated like the route table. All EKS work (g6 L4 GPU capacity via Karpenter, KEDA, S3-backed weights, Kueue, EKS Pod Identity) follows [ADR-0024](../adr/0024-aws-platform.md) (accepted; R29) and is certified in I13; until then I6 serves vLLM from a **local/Compose profile**. I11 depends on I6 and I9.

---

## Part A: I6 Model gateway, LLM serving and vLLM

### A1. What we are building, in plain language

Every AI feature (the Grain Advisor agent in I8, RAG answers in I7, fault triage in I11, eval judges in I9) calls **one internal service, `services/model-gateway`**. No other service may hold a provider API key or call a model directly. The gateway:

1. works out who is calling and for which tenant, **only from a verified tenant-bound token** (never from the request body), and what the tenant allows (plan, budget, data-routing policy);
2. picks a model and provider for the task from a versioned routing table;
3. reserves money before the call (a hold), streams the answer back, then records what the call actually cost (settle);
4. records which prompt version and model version produced every answer, so any output can be traced and reproduced. It records **metadata only**: the gateway never stores prompt or response text (R23). Content lives only in grain-advisor's encrypted `ai_interaction_content` store.

A useful comparison: the gateway does for LLM calls what `telemetry-ingest` does for readings. It is the single admission point, with authentication, rate limits, quotas, an idempotency receipt and a durable ledger.

### A2. Language and shape: Go

| Option | Verdict | Reasoning |
|---|---|---|
| **Go service** (chosen) | Accepted | Hot path is I/O-bound fan-in/fan-out of long-lived streams (thousands of concurrent SSE connections per pod). Goroutines plus `context` cancellation map directly onto "client disconnected → cancel upstream". It reuses `packages/go-common`, the Go tenant helper (Stage 02b) and the `run(ctx, getenv)` testable entry-point convention from `telemetry-ingest`. Official Anthropic Go SDK exists (including the Bedrock client `bedrock.WithLoadDefaultConfig`, which uses the AWS default credential chain, i.e. EKS Pod Identity in-cluster); vLLM and Ollama speak the OpenAI-compatible HTTP API. Small static image with fast cold start. |
| Python FastAPI | Rejected for gateway | AI-ecosystem convenience (tokenizers, LiteLLM) but GIL + asyncio for thousands of streams needs more pods and care; the ML code lives in Python elsewhere (I2–I5, I11), so there is no need to put the admission path there. |
| TypeScript/NestJS | Rejected | Best Anthropic SDK ergonomics and matches BFF, but the gateway is a money/admission service. The Go helpers already enforce the tenant-transaction pattern, and Go gives more predictable tail latency under stream fan-out. |
| Off-the-shelf LiteLLM proxy / Portkey / Envoy AI Gateway | Rejected as the owner; LiteLLM may be studied | They don't do hold-then-settle against our Postgres ledger with forced RLS, outbox events to billing, or tenant data-routing policy from our projections. Wrapping them would split the write owner. Documented as the "buy" alternative in the ADR. |

Token counting without a Python runtime: Claude uses `POST /v1/messages/count_tokens`, vLLM uses its `/tokenize` endpoint for the served model, and Ollama uses a conservative estimator (bytes/3) that is marked `estimated=true` on the ledger row.

### A3. Components and data ownership

```
grain-advisor / knowledge-service / ml jobs / eval worker
   (each presents a tenant-bound token, or bare service identity for non-tenant tasks only)
        ──HTTP/2──> model-gateway (Go, stateless pods)
                        │  ├─ Postgres `greenguard_ai_usage` DB (sole write owner)
                        │  ├─ Redis (rate buckets, tenant-keyed embedding cache, stream replay buffer; never money, never answers)
                        │  ├─ Anthropic API / Amazon Bedrock Claude channel
                        │  ├─ CPU model pool (guard, embedding, reranker, output-safety classifier; R21)
                        │  ├─ vLLM GPU (generation, LoRA adapters, evals; local/Compose now; EKS g6 L4 Spot per ADR-0024, certified in I13)
                        │  └─ Ollama (local dev profile only)
                        └─ outbox ──CDC──> Kafka `greenguard.ai.usage.v1` ──> billing-service (inbox)
```

The BFF does not call the gateway with the user's bearer token. Interactive token streams reach the browser through grain-advisor and the BFF SSE endpoint (R18).

**Tables in `greenguard_ai_usage`** (name registry §3). All tenant tables have `tenant_id`, forced RLS, composite tenant FKs, and tenant context from `set_config(..., true)` per transaction. As a new source DB it gets CDC onboarding in I6: Debezium connector, replication slot with WAL/slot-age alerts (H3), audited CDC read exemption on `outbox_events` only (R1/H2), `contracts/events/` schema, transformer routing entry and aggregate-ID check (H5).

| Table | Tenant-scoped | Purpose | Lock choice |
|---|---|---|---|
| `ai_budget_accounts(tenant_id, period, shard, limit_micros, held_micros, spent_micros, version)` | yes | Authoritative USD budget per tenant per billing period, split across N shard rows (default 1, up to 16; each shard holds `limit / N`) to spread row contention. | **Pessimistic, ADR-0002 "money/quotas" row** (documented next to the migration): `SELECT ... FOR UPDATE NOWAIT` on a **random** shard; on lock conflict or insufficient headroom, move to the **next** shard; if no single shard has headroom but the total does, take the hold **across shards in fixed ascending shard order** (A7); deny only when **every** shard is busy or the total is exhausted → 429 `budget_exhausted` + `Retry-After`. |
| `ai_platform_budget(account{product,eval}, period, shard, limit_micros, held_micros, spent_micros, version)` | no (global; on the R27 non-tenant allowlist) | The **global $300/month product row** (its own sharded account, default 8 shards) and the separate **$100/month eval row** (R22). The product row is **held on every product call in addition to the per-tenant rows**, so the sum of all tenants can never exceed $300 even if each tenant's own cap is lower than its use. Eval calls hold only the eval row. | Same money/quotas rule as below; lock order in A7 |
| `ai_user_budgets(tenant_id, user_id, period, limit_micros, held_micros, spent_micros)` | yes | Optional per-user cap inside a tenant | Same transaction, lock order: platform shard(s) → tenant shard(s) → user row (fixed order, no deadlock) |
| `ai_budget_holds(tenant_id, hold_id, request_id, scope{platform,tenant}, shard, amount_micros, state{held,settled,released,expired}, expires_at)` | yes (platform rows carry the requesting tenant for audit; the platform account itself is a non-tenant table) | One hold **per request and per shard used**, so a hold split across shards has one row per shard; `UNIQUE(request_id, scope, shard)` | Rows created once; state transitions guarded by `WHERE state='held'` |
| `ai_usage_ledger(tenant_id, request_id UNIQUE, hold_id, provider, model_id, model_snapshot, prompt_id, prompt_version, adapter, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost_micros, price_table_version, usage_source{provider,estimated,hold_charged}, traceparent)` | yes | Append-only cost of record | Insert-only; `UNIQUE(tenant_id, request_id)` is the idempotency receipt |
| `ai_request_metadata(tenant_id, request_id, route_version, task_type, provider, model_snapshot, ttft_ms, total_ms, stop_reason, prompt_cache_read_tokens, downgraded, content_hmac)` | yes | Metadata only: route decision, latencies, stop reason, prompt-cache usage. **No prompt or response content, ever** (R23); there is no opt-in capture. `content_hmac` is an HMAC with a per-tenant key (R20), so a request can be matched to grain-advisor's content row without the gateway holding text | Insert-only |
| `ai_tenant_policy_projection` / `ai_entitlement_projection` | yes | Local projections of the tenant-control-plane data policy and the billing entitlements (ADR-0018 pattern: strictly higher `source_version`, key must match tenant). Until GG-09 ships, entitlements are seeded from the local budget config file | Projector upsert with version check (optimistic) |
| `ai_prompt_versions(prompt_id, version, sha256, template, variables_schema, output_schema, created_at)` | no (global) | Prompt registry; source of truth is `contracts/prompts/*.yaml` in git, published at deploy | Insert-only, immutable |
| `ai_model_routes(route_version, task_type, rules jsonb, eval_scores jsonb, active)` | no (global) | Routing table + eval-score table, versioned. Validated at load: a route to a 5.5 model that sets `temperature`, `top_p` or `top_k`, **any** forced `tool_choice` on a 5.5 route (it returns 400 in all cases, thinking or not), `thinking: disabled` on Opus 5.5, or an **`effort` setting on `claude-haiku-4-5`** (Haiku 4.5 rejects `output_config.effort` with 400) is rejected and the gateway refuses to start (R19); the same check rejects any route whose `max_output_tokens` cap or worst-case hold does not satisfy A7, and any route whose server-side fallback target is pricier than the hold covers | One active version, switched atomically |
| `ai_price_table(version, provider, model_id, input, output, cache_write_5m, cache_write_1h, cache_read, effective_from)` | no | Prices in micro-USD per token; self-hosted rows use the measured internal rate (A11) | Insert-only |
| `outbox_events` | yes | `greenguard.ai.usage.v1` only (one event per settled ledger row; a `budget_threshold_crossed` field carries 80/95/100% crossings, so there is no separate threshold topic) | Same transaction as ledger insert |

**Where money is authoritative.** For *admission* (may this call go ahead), the gateway's Postgres budget rows in `greenguard_ai_usage` are the authority. For *invoicing*, billing-service is the authority: it consumes `greenguard.ai.usage.v1` through its inbox and meters to Stripe (Stage 09 / ADR-0019; that consumer is built after GG-09, README §4). Redis never holds money. The two are reconciled daily. Billing's sum of settled events must equal the gateway ledger for each period, and the gateway ledger must be within tolerance of the Anthropic Usage & Cost Admin API (raw HTTP; not in the SDKs).

**Contracts.**
- Internal HTTP: `POST /v1/generate` (JSON response) and `POST /v1/generate:stream` (SSE). The body is `GatewayRequest`: `request_id` (UUIDv7, created once by the caller, reused on retry), `task_type`, `prompt_ref {id, version}`, `variables`, `messages`, `tools[]`, `output_schema?`, `max_output_tokens`, `effort?`, `latency_class {interactive, standard, batch}`, `stream`. There are **no sampling fields** (`temperature`, `top_p`, `top_k`); for Claude 5.5 routes they would return 400, and repeatability comes from k runs plus `effort` (R19).
- **Identity (R14, ADR-0026).** Tenant, principal and data policy come **only** from a verified token, never from the body (same rule as ADR-0018 machine auth). `task_type` is split into two fixed sets:

  | Set | Task types | Accepted credential | Budget charged |
  |---|---|---|---|
  | Tenant-scoped | `advisor_chat`, `rag_answer`, `fault_triage`, `summarise`, `eval_judge` (online, R25), `embed` (tenant content), `guard_input`, `guard_output`, `rerank` | A **tenant-bound token** for exactly one tenant, audience `model-gateway`: the ADR-0026 delegated token for interactive turns, or a **job-scoped token** minted by the owning service for one tenant (indexing, online eval, exports) | The tenant's budget, except tenant-content indexing embeddings, which run under the platform budget (R12) |
  | Non-tenant | `embed_public` (public corpus, R11), `eval_offline` (T0–T2 runs on synthetic/public sets), `health_probe` | Bare **service identity** (mTLS/Stage 07) | Platform budget |

  A tenant-scoped `task_type` presented with a bare service identity, or with no tenant claim, is rejected with 401 `tenant_token_required` before any hold. The gateway **never forwards a caller's bearer token** to a provider or to another service, and callers never forward a user's raw bearer to the gateway; a token whose audience is not `model-gateway` is rejected.
- The normalised stream events are the same for every provider: `start{request_id, provider, model_id, model_snapshot, prompt_version, route_version}`, `text_delta`, `tool_call_delta`, `thinking_update` (summary only; the raw chain of thought is never exposed), `usage{...}`, `end{stop_reason ∈ end_turn|max_tokens|tool_use|refusal|content_filter|cancelled|error}`, `error{code, retryable, retry_after_ms}`. Each event carries a monotonically increasing `id` for SSE `Last-Event-ID` resume.
- Kafka: `greenguard.ai.usage.v1`, key = `tenant_id`, Avro/Registry per ADR-0010, `event_id` created once in the outbox row.

### A4. Providers and models

| Channel | Models | Use | Notes verified against current API |
|---|---|---|---|
| Anthropic API | `claude-opus-5-5` ($4/$20 per MTok, cache read $0.20) | Hard reasoning, Advisor planning, eval judge (reference grade) | Thinking cannot be disabled (400); control with `output_config.effort` (default **medium**, set explicitly). **No sampling parameters** (`temperature`/`top_p`/`top_k` → 400); the start-up route check enforces this. Forced `tool_choice any/tool` → 400 on 5.5 models in all cases (thinking or not): use `auto` + `strict: true` tools or `output_config.format`, then validate and retry. No prefill. Include `fallbacks: "default"` + beta `server-side-fallback-2026-07-01` (Claude API only) **only when the hold already covers the fallback target's worst-case cost** (A6/A7); otherwise the gateway falls back client-side after re-checking the hold. Always check `stop_reason == "refusal"` before reading content. |
| Anthropic API | `claude-sonnet-5-5` ($2/$10) | Default interactive Advisor, RAG answers | Same 5.5 rules: no sampling parameters, no forced `tool_choice` (400 in all cases). Thinking-off only via `{type:"between_tools"}` at effort ≤ high; recalibrated effort, start `low` for chat. |
| Anthropic API | `claude-haiku-4-5` ($1/$5) | Cheap classification/routing/summaries | Uses `budget_tokens` style thinking, not adaptive, and **rejects `effort`** (400; the route must not set it, enforced at start-up); **cache minimum 4096 tokens** (vs 512 on Opus/Sonnet 5.5) so short prompts silently don't cache. See conflict note on the model ID string. |
| Amazon Bedrock (optional second provider adapter; own capability table below) | Config per provider (see "Model IDs per provider" below). Sonnet 5.5: `anthropic.claude-sonnet-5-5`, invoked through the inference profile `global.anthropic.claude-sonnet-5-5` | Second channel for outage of the first-party API and for tenants whose policy allows AWS-billed Claude. **Not** a region-pinning channel for Sonnet 5.5 (see table) | Verified 2026-09-29 against the AWS model card for Sonnet 5.5 and the Anthropic Bedrock pages; see the capability table. Everything marked UNVERIFIED must be tested with contract tests before the route is enabled. |
| vLLM on GPU (local/Compose profile now; EKS L4 after ADR-0024) | `Qwen/Qwen2.5-1.5B-Instruct` / `-7B-Instruct` (+ LoRA adapters from I11) | Generation only: `fault_triage`, `self_hosted_only` tenants, T1 evals in scheduled GPU windows | OpenAI-compatible `/v1/chat/completions`, per-tenant `cache_salt`, structured output via guided decoding (JSON schema). |
| CPU model pool (R21) | Prompt Guard 2 86M; a small embedding model; a small reranker; a small quantised output-safety classifier chosen and verified in I10 (Llama Guard 4 12B does not fit an L4) — or hosted equivalents | `guard_input`, `guard_output`, `embed`, `embed_public`, `rerank` — needed on every turn, so never behind a cold GPU | CPU pods, always on, scale on CPU/queue depth. |
| Ollama | same Qwen family (GGUF) | Local dev / CI contract tests only | Never enabled in staging/prod routes. |

**Model ID conflict to resolve:** the brief lists `claude-haiku-4-5-20251001`. The current API guidance says to use the alias `claude-haiku-4-5` and not to append date suffixes. Design: the route table stores the alias, and the ledger stores `response.model` as `model_snapshot`, so every call still records the exact snapshot that served it. Pinning is done by the eval-gated route version, not by the ID string.

**Model IDs per provider (config, not code).** The route table stores a logical model name plus one provider-specific ID per adapter, and the ledger stores the ID the provider actually reports. Adapters never share an ID string.

| Logical model | Anthropic API adapter | Bedrock adapter (`bedrock-runtime`, Messages/InvokeModel) |
|---|---|---|
| Sonnet 5.5 | `claude-sonnet-5-5` | base `anthropic.claude-sonnet-5-5`; call it through the inference profile `global.anthropic.claude-sonnet-5-5` (the only profile listed on the AWS model card; no geo/in-region profile listed) |
| Opus 5.5 | `claude-opus-5-5` | UNVERIFIED: expected `anthropic.claude-opus-5-5` / `global.` prefix; confirm on the AWS model card before enabling |
| Haiku 4.5 | `claude-haiku-4-5` (alias) | `anthropic.claude-haiku-4-5-20251001-v1:0` with `global.`, `us.` or `eu.` prefix (Bedrock uses dated IDs; the alias rule does not apply) |

**Bedrock capability table (verified 2026-09-29 against the AWS Bedrock Sonnet 5.5 model card and Anthropic's Bedrock pages; the gateway loads this as a per-provider capability map and refuses a route that needs a capability marked no or UNVERIFIED).**

| Capability | Bedrock status for Sonnet 5.5 | Gateway handling |
|---|---|---|
| Extended/adaptive thinking, `effort` | Supported (adaptive on by default, effort low to max, Bedrock default high) | Set `effort` explicitly, never rely on the provider default (differs from the API's medium) |
| Prompt caching | Explicit checkpoints only: min 512 tokens, max 4, TTL 5 min or 1 h, in system/messages/tools. No automatic top-level `cache_control` | Renderer emits explicit breakpoints (already the design, A8) |
| Tool use | Supported (Anthropic docs); strict-schema behaviour UNVERIFIED | Validate and retry tool arguments regardless |
| Structured outputs (`output_config.format`) | CONFLICT: AWS model card lists structured outputs as not supported on `bedrock-runtime`; Anthropic's Bedrock page lists it as supported. UNVERIFIED | Do not rely on it: parse, validate against the schema and retry on Bedrock |
| Server-side `fallbacks` | Not supported | Client-side refusal/error fallback middleware only |
| Token counting | Not supported on `bedrock-runtime` (supported on `bedrock-mantle`) | Budget estimator uses a local tokenizer estimate with a safety margin on Bedrock (A7 worst-case hold already assumes no discount) |
| Message Batches | Not supported | T2 weekly evals run on the Anthropic API only |
| Regional / data residency | Global cross-Region profile only listed for Sonnet 5.5, so requests may be served from any region | `region_pinned` cannot use Sonnet 5.5 on Bedrock today; regional profiles carry a 10% premium where they exist |
| Rate limits / quotas | Account-level Bedrock quotas per model and region (tokens/min, requests/min); numbers not verified | Set breaker and per-provider concurrency from measured quotas in I13; request quota increases before launch |
| Billing | AWS Marketplace line item, not under Bedrock | Ledger reconciles against the AWS Cost and Usage Report, not the Anthropic usage API |
| Auth | AWS credentials (EKS Pod Identity) or a Bedrock bearer token | Pod Identity only; no long-lived keys |
| Newer beta headers/features | Lag the first-party API | Adapter never sends beta headers the capability map does not list |

### A5. Routing policy

Routing is a pure function `route(request, tenant_policy, entitlements, budget_state, provider_health, route_table) → ordered candidate list`. It has no I/O, so table-driven unit tests can cover it exhaustively.

Evaluation order (first rule that removes a candidate wins):

1. **Data-routing policy** (hard filter): `any` | `anthropic_zdr_only` | `region_pinned:{eu|us}` (Bedrock geo inference profile only; **not currently available for Sonnet 5.5**, whose card lists only the `global.` profile, so a `region_pinned` tenant has no Sonnet 5.5 route until AWS publishes a geo profile; the route table rejects a pinned route whose profile is `global.`) | `self_hosted_only` (vLLM only) | `ai_disabled`. If the projection is missing or older than 5 minutes, the gateway applies the **most restrictive** policy, `self_hosted_only` for read-only tasks and deny for everything else. This mirrors ADR-0018 falling back to the free plan when its projection is stale.
2. **Entitlement**: plan tier decides allowed model classes (free: Haiku/self-hosted; pro: + Sonnet; enterprise: + Opus). Source: GG-09 entitlements projection; until GG-09 ships, the local budget config file.
3. **Task capability**: from `route_table.eval_scores[task_type][model] ≥ min_quality[task_type]`. Scores come from I9 eval runs and are versioned with the route table. A model with no score for a task is not eligible.
4. **Complexity**: a cheap heuristic (input tokens, tool count, retrieved-doc count, explicit `effort_hint`) chooses tier: `simple → haiku/self-hosted`, `normal → sonnet`, `hard → opus`. Complexity escalation is logged, never silent.
5. **Latency SLO**: `interactive` requires p95 TTFT (rolling 5 min) under the SLO (2 s UNMEASURED target). A candidate that is over the SLO, or whose circuit breaker is open, is demoted.
6. **Cost ceiling**: `estimated_max_cost ≤ min(request_ceiling, remaining tenant budget, remaining user budget)`. If the preferred model is too expensive, the next cheaper eligible model is used and `downgraded=true` is emitted; if none fit, **429 `budget_exhausted` with `Retry-After`** (seconds until the next billing period or the user-cap window resets). The same status and code are used everywhere budget runs out (R22).
7. **Canary weights** (I11 adapters, new prompt versions): deterministic hash of `(tenant_id, request_id)` → bucket, so a request is always routed the same way on retry.

Rejected alternatives: an LLM-based router (adds latency and cost and is non-deterministic, so routing can't be tested); a learned router (bandit) now. A contextual bandit over routes is a possible I5 online-ML extension once measured reward data exists; it would be **offline-evaluated first**.

### A6. Resilience: fallbacks, breakers, retries, timeouts, hedging

- **Fallback chains** are per task, for example `advisor_chat: sonnet-5-5(API) → sonnet-5-5(Bedrock, if policy allows) → haiku-4-5 → error`. Chains are filtered by the data policy **before** use, so a `self_hosted_only` tenant never falls back to Anthropic. A fallback can only reach a model that passed the task's eval threshold.
- **A fallback re-checks the hold.** The hold is sized for the route's *primary* candidate. Before any fallback attempt (gateway-side failover, client-side refusal/error middleware, or Bedrock), the gateway recomputes `max_cost` for the target and, if it exceeds the amount already held, takes a **top-up hold** under the same `request_id` (same lock order and shard rules as A7; the platform, tenant and user rows are all re-checked). If the top-up fails, the gateway tries the next candidate whose worst case fits, and otherwise returns 429 `budget_exhausted`; it never calls a pricier model on an unfunded hold. **Server-side `fallbacks: "default"` (Claude API) runs inside the provider, where the gateway cannot intervene**, so it is enabled for a route only when the initial hold is sized to `max(primary, every server-side fallback target)`; otherwise it is left off and the gateway does the failover itself. Settlement releases the difference either way.
- **Refusal ≠ failure.** `stop_reason: refusal` goes to the server-side `fallbacks` (Claude API). If the whole chain refuses, the gateway returns `end{stop_reason: refusal}` to the caller and does **not** try an unrelated provider to get round a safety decline.
- **Circuit breaker** per `(provider, model, region)`: opens at ≥50% errors (5xx, 529 overloaded, timeouts) over ≥20 requests in 30 s, or when p95 TTFT exceeds 3× the SLO. Half-open lets 1 probe through every 10 s. 429s with `retry-after` do not count as breaker failures but set a provider-level pause.
- **Retries**: only **before the first byte has been sent to the client**. Max 2 retries, exponential backoff with full jitter (base 250 ms, cap 4 s), honouring `retry-after`. The gateway turns off SDK automatic retries (`max_retries=0`) so its own budget and trace see every attempt, and each attempt is its own span. After the first delta has been forwarded there is **no transparent retry**, because replaying would duplicate text or tool calls. The client gets `error{retryable:true}` and may regenerate with a **new** request_id.
- **Timeouts**: connect 2 s; TTFT deadline per latency class (interactive 8 s, standard 30 s, batch 120 s); stream idle 30 s between events; overall deadline = caller context deadline. If the TTFT deadline passes, the gateway cancels and moves to the next candidate (this is failover, not hedging).
- **Hedging decision: rejected for paid providers.** Sending a duplicate request doubles the token bill (both calls are charged even if one is cancelled mid-stream), and two generations can diverge. It is allowed only for `embed` on the CPU pool and `fault_triage` on self-hosted vLLM (marginal cost ≈ 0 at low load) behind a flag, and only when the pod's queue depth < 2.
- **Cancellation**: a client disconnect cancels the context, which aborts the upstream stream. The hold is then settled with the usage received so far (A7).

### A7. Budgets: hold-then-settle (plain language + mechanics)

*Plain language:* before a call, we set aside the most it could possibly cost, like a hotel pre-authorising your card. When the call finishes, we charge what it actually cost and release the rest. Two concurrent calls can therefore never both spend the last dollar.

1. **Estimate.** `max_cost = count_tokens(input) × input_price + max_output_tokens × output_price`. It assumes no cache discount (worst case), because cache hits can't be predicted.
2. **Hold** (one transaction, **global product row plus per-tenant row on every call**): the hold must succeed on the **platform account first** (the global $300 product row; eval calls use the eval row) and then on the tenant account (and the user row when configured); any failure rolls the whole transaction back. Within one account: pick a random shard and lock it `FOR UPDATE NOWAIT`; if the lock is taken or the shard lacks headroom, try the next shard; check `shard_limit − held − spent ≥ max_cost`, then `held += max_cost` and insert the `ai_budget_holds` row (`expires_at = deadline + 5 min`). **Multi-shard hold:** if no single shard has `max_cost` of headroom but the account's total headroom does (money fragmented across shards near exhaustion), the hold is split and taken across shards in **ascending shard number**, locking each `NOWAIT`, one `ai_budget_holds` row per shard; a busy shard rolls back the transaction and the caller retries once from a different start shard. The global lock order for every transaction is fixed: **platform shards ascending → tenant shards ascending → user row**, so no two transactions can deadlock, and `NOWAIT` means none waits at all. Settle and release walk the same rows in the same order. If every shard is busy or the total is exhausted, return 429 `budget_exhausted` + `Retry-After` (a busy-only denial uses a short `Retry-After` of about 1 s).
   **Per-route output caps make a valid call always fit.** Each route in `ai_model_routes` carries `max_output_tokens_cap` and `max_input_tokens_cap` (for example `advisor_chat` 1,500 output / 30k input, `eval_judge` 1,024 output, `fault_triage` 512, guards 64). A request whose `max_output_tokens` exceeds the cap gets 400 `max_output_tokens_exceeds_route_cap`. The start-up check computes each route's worst-case hold (`max_input_tokens_cap × input price + max_output_tokens_cap × output price`, using the priciest fallback target where one exists) and rejects the configuration unless that hold is ≤ half of the **smallest shard limit** of every account it can touch, i.e. the shard count is clamped to `floor(limit / (2 × worst_hold))`. So a fresh account always fits any valid call in one shard, and multi-shard holds arise only from fragmentation. *Why this lock:* money needs exact admission, so ADR-0002's money/quotas row applies (pessimistic, `NOWAIT`); spreading the tenant over shards and moving on at once, instead of waiting, keeps a hot tenant from queueing on one row. The choice is written next to the migration. The receipt for `(tenant_id, request_id)` is written here. A retry with the same request_id returns the existing hold or result and never creates a second hold.
3. **Call** the provider.
4. **Settle** (one transaction): compute actual cost from provider `usage` (input, cache_creation split by TTL, cache_read, output) × `price_table_version`, then `held -= max_cost; spent += actual`, insert the `ai_usage_ledger` row, insert outbox `greenguard.ai.usage.v1`, and set the hold to `settled`.
5. **Reaper** (every 60 s, `FOR UPDATE SKIP LOCKED`): expired holds with no settlement are settled at **the full hold amount** (`usage_source=hold_charged`), because the provider may have billed us. They are flagged for reconciliation against the Admin usage report, and over-charges are credited back by a compensating ledger entry. The original row is never edited.

Per-user rate limits are Redis token buckets (requests/min, input-tokens/min, concurrent streams) keyed `rl:{tenant}:{user}`. They are protection, not money. If Redis is down the gateway falls back to a per-pod limiter at `limit / expected_pods` (ADR-0007 pattern) and the budget check in Postgres still applies. 80%, 95% and 100% crossings are flagged on the `greenguard.ai.usage.v1` event and feed notifications (Stage 06).

**Budget sizes (R22, UNMEASURED until the ledger reports).** Product LLM traffic has a **hard cap of $300/month** across all tenants (the global `product` row, held on every call; it covers customer traffic, the ≤ $60/month local/dev real-Claude allowance on the developer's own key, and the I6 E2E test). Evals have their own key and the separate `eval` row ($100/month): T0 replays recorded responses on every PR ($0); T1 runs self-hosted models during scheduled GPU windows; T2 runs Claude **weekly, ≤ $12 per run (≈ $52/month)**, plus a **$30 release-candidate reserve** and an **$18 line for online-eval judge calls, canary evals and judge recalibration** (52 + 30 + 18 = $100). **The Message Batches API is used only for judge calls and single-shot items**; multi-turn agent items use the standard API on recorded tool results or run in T1 (I09 A7 has the sizing). Until GG-09 provides per-plan limits, per-tenant caps come from the local budget config file.

### A8. Prompt caching (Anthropic rules as actually documented)

Verified rules: the cache is an **exact-byte prefix match**; render order is **`tools → system → messages`**; **max 4 `cache_control` breakpoints** per request; TTL `5m` (default, write 1.25×) or `1h` (write 2×); reads 0.1× base price (0.05× on Opus 5.5 = $0.20/MTok); **entries with longer TTL must come before shorter ones**; minimum cacheable prefix is 512 tokens on Opus 5.5/Sonnet 5.5 and 4096 on Haiku 4.5, and a shorter prefix silently doesn't cache; each breakpoint looks back at most 20 positions; caches are isolated **per workspace** on the Claude API (on Bedrock the isolation boundary is UNVERIFIED for Sonnet 5.5; the gateway relies on the per-tenant nonce, not on provider isolation) and never shared across organisations. Bedrock differs: no automatic top-level `cache_control` (explicit breakpoints only), and Haiku 4.5's minimum is not verified for Bedrock.

GreenGuard layout (breakpoints numbered):

| Position | Content | Stability | Breakpoint |
|---|---|---|---|
| tools | Tool definitions sorted by name, JSON serialised with sorted keys, no descriptions containing dates | per deploy | – |
| system[0] | Global GreenGuard instructions + safety policy for `prompt_id@version` | per deploy | **BP1, `ttl: 1h`** |
| system[1] | **Per-tenant secret nonce first**, then tenant context: tenant glossary, crop/bin catalogue summary, units (**no timestamps**) | per tenant per day | **BP2, `5m`** |
| messages[..n-1] | Conversation history (**append-only**; never edited, as preserved thinking requires on Opus/Sonnet 5.5). Long threads use server-side compaction or the documented strip-thinking policy of **ADR-0028**, never ad-hoc edits | per turn | **BP3** top-level automatic (`5m`) |
| messages[n] | Retrieved RAG chunks + current question + current time | per request | none (after last breakpoint) |

Rules enforced in code: a deterministic prompt renderer (golden-byte tests); a CI check that fails if a timestamp, UUID or unsorted map appears before the last breakpoint; mid-conversation operator changes use `role: "system"` messages rather than editing top-level `system`; one Anthropic **workspace per environment** (per cell at scale) so hit rates are predictable. Cache hit ratio `cache_read / (cache_read + cache_write + input)` is exported per route. The gate is ≥60% on multi-turn Advisor traffic (UNMEASURED target).

Cross-tenant safety (R20): **any tenant segment starts with a per-tenant secret nonce**, `tenant_cache_nonce = HMAC-SHA256(nonce_key, tenant_id ‖ key_epoch)`, with `nonce_key` in AWS Secrets Manager and rotated quarterly. The renderer places it before the first tenant byte of every request that carries tenant content (system[1] when present, otherwise the first tenant message). Plain language: a prompt-cache hit needs an exact byte match, and no other tenant can know this secret, so tenant A cannot even probe whether tenant B's prefix is cached. The static prefix before the nonce (tools, BP1) is shared and contains no tenant data. This replaces the earlier "accepted timing side channel".

### A9. Caches: tenant-keyed only, no answer cache, no semantic cache

- **No final-answer cache and no semantic answer cache** (R20; charter §5.2 #4 withdrawn). No generation output is ever served from a cache. The only caches are Anthropic prompt caching (A8), vLLM prefix caching under a per-tenant `cache_salt` (A11), and an **embedding cache**.
- **Embedding cache** in Redis, keyed by tenant: key = `HMAC(tenant_key, embedding_model@version ‖ normalised_text)` under `aiemb:{tenant_id}:` (public corpus under `aiemb:public:`). TTL 24 h, invalidated by a model-version bump in the key. Identical text from two tenants gives two different keys. A cache hit writes no ledger cost.
- Content hashes that appear on spans or metadata rows are HMACs with a **per-tenant key**, never a bare `sha256` of content (R20, R28).
- **Why no exact-match answer cache.** Even an exact repeat of a question can need a different answer, because live readings and alerts change between calls; a cached answer would also bypass grain-advisor's per-turn validation and groundedness checks (R18). Prompt caching already recovers most input cost.
- **Semantic cache rejected.** Semantic caching returns a stored answer for a *similar* question. In an agronomy platform, "Is bin 12 at risk?" and "Is bin 21 at risk?" embed almost identically but need different answers from different live data. A wrong hit gives a confident, wrong answer, and for anything that leads to an action (ventilate, acknowledge alert) it is unsafe. The cost saving does not justify that correctness risk, and prompt caching already recovers most input cost.

### A10. Streaming to the caller and on to the BFF

- The gateway emits SSE over HTTP/2 **to its calling service** (grain-advisor for Advisor turns). The browser never talks to the gateway. Per R18, grain-advisor streams only progress and tool events until its structured-output, groundedness and output-safety checks pass, then releases validated answer text through the **BFF SSE endpoint** (`Last-Event-ID` resume); run and approval state use the GraphQL subscription `AdvisorRun`.
- Identity follows R14: the BFF verifies the user JWT and issues the short-lived delegated token (ADR-0026, built in I8b); the caller presents a tenant-bound token with audience `model-gateway`. **No raw bearer is forwarded** at any hop, and a client-supplied tenant is never trusted.
- The gateway buffers the last 60 s of events per stream in Redis (`aistream:{tenant}:{request_id}`), so a caller whose connection drops can resume with `Last-Event-ID` (the reconnect-restores-state gate from Stage 08). Resume checks that the resuming token's tenant equals the stream's tenant, otherwise 404.
- Backpressure: if the client reads slower than the upstream produces, the gateway buffers up to 1 MB per stream, then cancels with `error{code: slow_consumer}`.
- Rejected: GraphQL subscriptions over WS for token streams (heavier per-message framing, harder resume semantics, and subscription tenant scoping is a known CarePulse defect class). WS stays for alert/reading subscriptions.

### A11. vLLM (local/Compose profile now, EKS in I13)

**Where it runs (R29).** Until I13 certifies the EKS profile, I6 runs vLLM from a **local/Compose profile** (`make ai-local`: a vLLM container on a developer or lab GPU, same flags, same `cache_salt` and adapter layout; Ollama as the no-GPU fallback for contract tests). Everything in the deployment table that names EKS, Spot NodePools, KEDA, S3-backed weights or Karpenter is designed here and certified in I13 (ADR-0024 is accepted; no further decision is pending).

**What the GPU is for (R21).** The GPU serves **generation, fine-tuned adapters and evals only**. Guard, embedding and reranking models run on the always-on CPU pool (A4), because every turn needs them. "No turn waits on a cold GPU" therefore applies to generation: tenants whose policy allows Claude fall back to it while the GPU warms; `self_hosted_only` tenants get a **bounded wait of at most 15 minutes, shown in the UI** (see "While cold").

**Plain-language primer.**
- *KV cache*: while generating, the model stores, for every token so far and every layer, two vectors (the "keys" and "values" of attention), so it doesn't recompute the past for each new token. This lives in **GPU memory**, is measured in gigabytes, is specific to one model, and is gone when the request ends (unless prefix-cached). It is nothing like Redis. Redis stores finished text we chose to keep, in CPU RAM, across services. The KV cache is the model's short-term working memory.
- *PagedAttention*: instead of reserving one big contiguous block of GPU memory per request (wasteful, because you don't know the output length), vLLM splits the KV cache into small fixed-size pages, like OS virtual memory. That lets far more concurrent requests fit on one GPU.
- *Continuous batching*: the GPU processes all active requests together. As soon as one finishes, a waiting one joins the batch on the next step, rather than the whole batch waiting for its slowest member. That is why throughput rises with concurrency until memory or compute saturates.
- *Prefix caching*: KV pages for an identical prompt prefix are reused across requests. vLLM's `cache_salt` mixes a secret into the first block's hash, so only requests with the same salt share cached prefixes.

**Deployment decisions.**

| Decision | Choice | Rejected |
|---|---|---|
| GPU (EKS, ADR-0024) | `g6.xlarge` (1× NVIDIA **L4** 24 GB, 4 vCPU, 16 GiB) on **EC2 Spot** via **Karpenter** (`NodePool` with `karpenter.sh/capacity-type: [spot, on-demand]`, Spot preferred, GPU taint, `limits: nvidia.com/gpu`), scale to zero, **NVIDIA device plugin** DaemonSet (or GPU Operator) exposing `nvidia.com/gpu`, EKS GPU AMI. **On-Demand fallback:** a second NodePool of the same family at lower weight, used when Spot is unavailable or interrupted (cost impact in I13). `g6.2xlarge` if 16 GiB host RAM is too tight for 7B AWQ (measure); `g6e.xlarge` (L40S 48 GB) only for 7B FP8 benchmarks. Caveats: Spot capacity for g6 is not guaranteed and varies by AZ (UNMEASURED; allow several AZs and instance sizes in the NodePool); GPU vCPU service quotas ("All G and VT Spot/On-Demand instance") must be raised before I13; the device plugin and driver versions are pinned with the AMI | A100/H100 (`p4d`/`p5`): over budget. CPU inference for generation: too slow for interactive use (CPU is used for the small guard/embedding/reranker models only). |
| Model/quant | Qwen2.5-1.5B-Instruct BF16 (fits trivially); Qwen2.5-7B-Instruct **AWQ INT4** on L4; **FP8** (weights+KV) on L40S/L4 (Ada supports FP8) as a measured comparison; GPTQ only if AWQ quality fails | Unquantised 7B BF16 on L4 (~15 GB weights leaves little KV cache room) |
| Multi-LoRA | `vllm serve <base> --enable-lora --max-loras 4 --max-lora-rank 16 --lora-modules fault-triage-v3=<mounted-path> fault-triage-v4=...` (static at start-up). `--max-loras` ≥ resident adapters, so champion and canary are both hot. | Runtime `/v1/load_lora_adapter` with `VLLM_ALLOW_RUNTIME_LORA_UPDATING`: vLLM docs warn it is not for production outside fully trusted, isolated environments. A new adapter set means a new rollout. |
| Prefix-cache isolation | `cache_salt = base64(HMAC-SHA256(salt_key, tenant_id ‖ key_epoch))` added by the gateway to every request. The salt key comes from AWS Secrets Manager (read through EKS Pod Identity, KMS-encrypted) and is rotated quarterly. | No salt (cross-tenant timing side channel); per-user salt (kills reuse of tenant system prompts) |
| Structured output | Guided decoding with JSON schema for `fault_triage` | Parse-and-retry only |
| Scale from zero | The gateway exports `gg_ai_selfhosted_demand{pool}` (queued + in-flight + 1-minute arrivals) to Prometheus (Amazon Managed Service for Prometheus or in-cluster) → **KEDA** `ScaledObject` scales the vLLM Deployment 0→1→N. **Karpenter** provisions the g6 node when the pod is pending and removes it when empty (`consolidationPolicy: WhenEmpty`). Scale to zero after 15 min idle. | HPA on GPU utilisation (can't scale from zero; utilisation lags demand). Always-on GPU (~$400–600/month for one L4, UNMEASURED, eats the whole budget). |
| While cold | For tenants whose policy allows Claude, the gateway routes generation to the next candidate (Haiku) and still emits demand, so no turn waits on a cold GPU. For `self_hosted_only` tenants it returns `503 ai_warming` + `Retry-After` + `ready_estimate`; grain-advisor shows "warming, about N min" in the UI and retries; if the GPU is not ready within **15 min**, the turn ends with `ai_unavailable`. Batch-class work is queued. Guard/embedding/reranker calls never wait, because they run on CPU. | Blocking interactive requests silently for minutes; an unbounded wait |
| Weights | Mirrored from Hugging Face to a S3 bucket at a pinned revision with a SHA-256 manifest, copied at node start to local NVMe/instance store or an EBS volume (pre-populated from an EBS snapshot), or mounted read-only through the Mountpoint for Amazon S3 CSI driver with local cache. The vLLM image is pulled from ECR (image pre-pull baked into the GPU AMI or a Karpenter `userData` warm step). Which of these meets the cold-start budget is a measured I13 choice. | Download from HF at pod start (rate limits, supply chain, slow cold start) |
| Cold-start budget | Target p95 ≤ 6 min from demand to first token = Karpenter node provision + image + weights + CUDA graph capture (**UNMEASURED**; each phase timed separately in evidence) | – |
| Probes | Readiness = `/health` + one warm-up generation; liveness only on process health (a long generation must not fail liveness) | – |

**Benchmark methodology** (evidence file `evidence/STAGE_I6_VLLM_BENCH.md`):
1. Dataset: 2,000 real prompt shapes from the simulator (fault_triage inputs, Advisor turns), recorded as a JSONL custom dataset. Also `--dataset-name random --random-input-len {512,2048} --random-output-len {128,512}` to show sensitivity to request shape.
2. `vllm bench serve --backend vllm --model <served> --percentile-metrics ttft,tpot,itl,e2el --save-result` swept over `--max-concurrency {1,2,4,8,16,32,64}`. Then `vllm bench sweep serve_workload --workload-var max_concurrency` for the latency/throughput curve. For multi-LoRA: `--lora-modules` with round-robin assignment, measuring the cost of adapter swapping with `--max-loras` both below and above the number of adapters.
3. **Goodput** = requests/s meeting the SLO (TTFT p95 ≤ 1 s, TPOT p95 ≤ 50 ms; UNMEASURED targets). The operating point is the highest concurrency at which goodput holds.
4. Each configuration runs 3 times, and the report gives the median with min/max. GPU model, driver, vLLM version, flags, quantisation and image digest are recorded.
5. **$/1M tokens** = `node_$per_hour / (measured_tokens_per_hour_at_operating_point × expected_utilisation)`. Utilisation comes from the gateway's measured demand over a week (idle GPU time is charged too, which is why scale-to-zero matters). The result is written to `ai_price_table` as the internal self-hosted rate, so ledger costs for vLLM are real rather than zero.

### A12. Prompt and model registry per call

Every ledger row records `prompt_id@version` + template `sha256` (a hash of the versioned template, which contains no tenant data), `route_version`, `provider`, `model_id`, `model_snapshot` (from the response), `adapter@version`, `effort`, `price_table_version` and `traceparent` (ADR-0004: the live span's traceparent, never invented). Given a request_id, you can therefore reproduce exactly which prompt template and model produced an answer; the filled-in prompt and the answer text are read, when needed, from grain-advisor's content store with a tenant-bound token (R23), never from the gateway. Prompts change only through a PR to `contracts/prompts/`, and CI runs the I9 eval suite on the changed prompt before its version can be activated.

### A13. Zero data retention and data handling

- **ZDR:** Opus 5.5, Sonnet 5.5 and Haiku 4.5 are available under ZDR. Fable 5/5.1 are **not** (400), so `anthropic_zdr_only` tenants must never be routed to Fable, and route validation enforces this. Whether GreenGuard's Anthropic org actually has ZDR is a commercial arrangement and an **open question**. Until it is confirmed, the policy value `anthropic_zdr_only` routes to vLLM.
- The gateway stores **no prompt or response content** (R23): `ai_request_metadata` and `ai_usage_ledger` hold metadata and HMACs only, and Redis stream buffers expire after 60 s. The one content store is grain-advisor's `ai_interaction_content` (per-tenant DEK, 30-day default retention), which is also what eval replay reads. Gateway metadata rows are covered by the tenant-deletion inventory (R26).
- No provider receives GreenGuard tenant IDs or user emails. The `metadata.user_id` sent to Anthropic is an HMAC pseudonym.

### A14. Capacity model (all UNMEASURED)

Design target: 10M registered users. Assume 10% weekly AI users, 2% concurrently active at peak, and one LLM request per 30 s of active use: 10M × 0.02 / 30 ≈ **6,700 req/s peak fleet-wide**, split across cells (for example 150 cells ≈ 45 req/s/cell). Each request = 2 small Postgres transactions (hold, settle) + 1 outbox row, so about 90 tx/s/cell for the gateway DB, which is well within one cell's Postgres. The gateway is stateless, and a pod's concurrent streams are limited by memory (~50 KB/stream, UNMEASURED). The real limits are **provider rate limits and dollars**, not the gateway: at 6,700 req/s × ~3k tokens, fleet spend would be far beyond demo budgets. Stage I13 certifies a **Tier-1 cell** (for example 50 req/s sustained, 500 concurrent streams) with k6 against a fake provider, plus a short, budget-capped run against real providers. Extrapolating to 10M users is not claimed.

### A15. Edge cases and failure modes (I6)

| # | Scenario | Expected behaviour | Test ID |
|---|---|---|---|
| G01 | Same `request_id` retried after gateway crash between hold and provider call | Existing hold found; call proceeds once; one ledger row | GW-IDEM-01 |
| G02 | Same `request_id` retried after settle | Stored result or ledger reference returned, no new provider call, no new charge | GW-IDEM-02 |
| G03 | Same `request_id` with a different body | 409 `idempotency_conflict` (body hash stored on hold) | GW-IDEM-03 |
| G04 | Crash after provider finished, before settle | Reaper charges full hold (`hold_charged`) and flags for reconciliation; later credit via compensating entry | GW-CRASH-01 |
| G05 | Crash mid-settle transaction | Transaction rolls back atomically; reaper handles it; no partial ledger/outbox | GW-CRASH-02 |
| G06 | Two concurrent requests contend for the last $0.10, run with **N = 1 and N > 1 shards** (N = 4 and 16) and with the last $0.10 split across shards (for example $0.04 + $0.03 + $0.03) | Exactly one hold succeeds (across shards in ascending order when fragmented); the other gets 429 `budget_exhausted` + `Retry-After`; `held + spent ≤ limit` on every shard and in total | GW-BUD-01 |
| G07 | Hot tenant: 500 concurrent holds on a sharded budget, with **N > 1** (8 and 16), and simultaneously on the **global product row** | `NOWAIT` on a random shard, move to the next shard on conflict; multi-shard holds taken in ascending shard order; p99 hold latency within SLO; no deadlock (fixed lock order: platform shards → tenant shards → user row); global product total never exceeds $300 | GW-BUD-02 |
| G08 | Actual cost > hold (provider over-generates or price changed) | Settle succeeds; `spent` may exceed limit by at most one request's delta; the next hold is blocked; alert | GW-BUD-03 |
| G09 | Price table changes mid-request | Uses the `price_table_version` captured at hold time | GW-BUD-04 |
| G10 | Billing period rolls over during a stream | Hold and settle both use the hold's period | GW-BUD-05 |
| G11 | Budget projection or entitlement projection stale >5 min | Free-plan models only / most restrictive data policy; alert | GW-POL-01 |
| G12 | Tenant switches to `self_hosted_only` mid-conversation | Next request is routed only to vLLM; the conversation is not replayed to Anthropic | GW-POL-02 |
| G13 | `self_hosted_only` tenant, vLLM scaled to zero | 503 `ai_warming` + `Retry-After` + `ready_estimate`; wait shown in UI and bounded at 15 min, then `ai_unavailable`; demand metric emitted; never falls back to Claude; guard/embedding calls unaffected (CPU) | GW-POL-03 |
| G14 | `ai_disabled` tenant | 403 `ai_disabled`, no hold created | GW-POL-04 |
| G15 | Client-supplied `tenant_id` in body differs from token | Ignored; token tenant used; audit event | GW-SEC-01 |
| G16 | Anthropic 429 with `retry-after` | Retry before first byte if within deadline; else next candidate; breaker not counted | GW-RES-01 |
| G17 | Anthropic 529 overloaded / 5xx | Retry with jitter, then fallback chain; breaker counts | GW-RES-02 |
| G18 | Upstream stream drops after 40% of output | `error{retryable:true}`; settle with partial usage if the `message_delta` usage was received, else hold charged; no silent retry | GW-RES-03 |
| G19 | TTFT deadline exceeded | Cancel upstream, next candidate; the first attempt's tokens (if billed) are recorded as a separate attempt row | GW-RES-04 |
| G20 | `stop_reason: refusal` | Server-side fallback (API) or client middleware (Bedrock); if the chain refuses, `end{refusal}`; not treated as an error for the breaker | GW-RES-05 |
| G21 | `stop_reason: max_tokens` during a tool-call JSON | Tool input discarded (not executed); `end{max_tokens}`; caller may raise the limit | GW-RES-06 |
| G22 | Streamed tool input is truncated or invalid JSON | Validated against the schema before being returned as a tool call; invalid → `tool_call_invalid` | GW-RES-07 |
| G23 | Client disconnects mid-stream | Context cancelled → upstream aborted within 1 s; settle with usage so far | GW-RES-08 |
| G24 | Slow consumer | Buffer cap → `slow_consumer` error; upstream cancelled | GW-RES-09 |
| G25 | SSE resume with `Last-Event-ID` after 30 s | Events replayed from Redis buffer; no duplicate billing | GW-STR-01 |
| G26 | Resume after 90 s (buffer expired) | 410 `stream_expired`; the client re-requests with a new id | GW-STR-02 |
| G27 | Tenant B tries to resume tenant A's stream id | 404 | GW-ISO-05 |
| G28 | Redis down | Rate limit falls back to per-pod; embedding cache bypassed; stream resume unavailable (410); budgets unaffected | GW-DEP-01 |
| G29 | Postgres down | 503 for all paid routes (fail closed); no provider call without a hold | GW-DEP-02 |
| G30 | Kafka/CDC outage | Outbox accumulates; billing lags; gateway unaffected; lag alert | GW-DEP-03 |
| G31 | Prompt version referenced but not published | 400 `unknown_prompt_version` | GW-REG-01 |
| G32 | Prompt renders a timestamp before a breakpoint | CI golden-byte test fails | GW-CACHE-01 |
| G33 | Prefix below the model minimum (e.g. a 3k-token prompt on Haiku 4.5) | No cache; metric shows `cache_write=0`; a route lint warns | GW-CACHE-02 |
| G34 | More than 4 breakpoints requested by a caller template | Renderer rejects at build time | GW-CACHE-03 |
| G35 | 1h breakpoint placed after a 5m one | Renderer rejects (the API would 400) | GW-CACHE-04 |
| G36 | Embedding-cache key collision across tenants | Impossible by construction (per-tenant HMAC key and namespace); test with identical text from two tenants; no generation response is ever cached | GW-ISO-03 |
| G37 | Forced `tool_choice` on any 5.5 route (it returns 400 in all cases, with or without thinking) | Route config rejected at start-up; adapter never emits it; contract test asserts `auto` + `strict` + validate-and-retry | GW-API-01 |
| G38 | `thinking:{type:"disabled"}` configured for Opus 5.5 | Config validation rejects at start-up | GW-API-02 |
| G39 | Token count endpoint unavailable | Estimate from bytes × safety factor 1.3, `estimated=true` | GW-TOK-01 |
| G40 | vLLM pod OOM / CUDA error | Pod restarts; breaker opens; fallback per policy | GW-VLLM-01 |
| G41 | Spot GPU node reclaimed mid-generation (EC2 2-minute interruption notice, delivered by SQS/EventBridge to Karpenter, which cordons and drains) | Readiness fails at the notice so no new requests arrive; in-flight streams get a `retryable` error (generations longer than the 2-minute window cannot finish); Karpenter provisions On-Demand if Spot is unavailable; fallback per policy | GW-VLLM-02 |
| G42 | Requested adapter not resident (`--max-loras` too small or name typo) | vLLM 404 → gateway routes to champion adapter; alert | GW-VLLM-03 |
| G43 | Missing `cache_salt` on a vLLM request | Gateway adapter unit test fails; runtime assertion rejects | GW-ISO-04 |
| G44 | Weights checksum mismatch on mount | Init container fails; pod not ready | GW-VLLM-04 |
| G45 | Clock skew between pods affects hold expiry | Expiry computed from DB `now()`, not the pod clock | GW-BUD-06 |
| G46 | Provider returns a model snapshot different from expected | Recorded; if it isn't on the route's allow-list, an alert fires (silent model drift) | GW-REG-02 |
| G47 | Prompt injection in retrieved docs asks to "use Opus" | Routing ignores content; route decided only from metadata | GW-SEC-02 |
| G48 | Anthropic API key leaked / revoked | All calls 401 → breaker open → Bedrock/self-hosted per policy; secret rotated through AWS Secrets Manager without redeploy | GW-SEC-03 |
| G49 | Usage report disagrees with ledger >2% for a day | Reconciliation job opens an incident; billing overage stays disabled until resolved | GW-REC-01 |
| G50 | Duplicate `greenguard.ai.usage.v1` delivery to billing | Billing inbox dedups on `event_id` | GW-REC-02 |
| G51 | Route config sets `temperature`/`top_p`/`top_k` on a 5.5 route | Start-up config check fails; the gateway does not start; request bodies cannot carry sampling fields | GW-API-03 |
| G52 | Tenant-scoped `task_type` (e.g. `advisor_chat`) with bare service identity or no tenant claim | 401 `tenant_token_required`; no hold, no provider call | GW-SEC-04 |
| G53 | Caller forwards a user's raw bearer (audience not `model-gateway`) | 401 `invalid_audience`; gateway never forwards any caller token upstream | GW-SEC-05 |
| G54 | Non-tenant `task_type` (`embed_public`, `eval_offline`) with service identity | Accepted; charged to the platform budget; carries no tenant data | GW-SEC-06 |
| G55 | Every budget shard (platform or tenant) is locked or exhausted | 429 `budget_exhausted` + `Retry-After` (short when only busy); no wait on locks | GW-BUD-07 |
| G56 | Tenant segment rendered without the per-tenant nonce | Renderer rejects; property test | GW-CACHE-05 |
| G57 | Thread exceeds the context limit | Server-side compaction or the ADR-0028 strip-thinking policy; history is never edited in place | GW-HIST-01 |
| G58 | Tenant budget has headroom but the **global $300 product row** is exhausted (or its shards are fragmented) | 429 `budget_exhausted` from the platform row; tenant hold not taken (rolled back); eval calls unaffected (own row) | GW-BUD-08 |
| G59 | Fallback (gateway-side, client-side or server-side `fallbacks`) targets a pricier model than the hold covers | Top-up hold taken before the call; failure → next affordable candidate or 429; server-side fallback is off unless the initial hold covers its worst case; no provider call on an unfunded hold | GW-BUD-09 |
| G60 | Route sets `effort` on `claude-haiku-4-5`, or a request's `max_output_tokens` exceeds the route cap | Start-up check refuses the config (Haiku); per-request 400 `max_output_tokens_exceeds_route_cap` | GW-API-04 |
| G61 | Route's worst-case hold is larger than half the smallest shard limit | Start-up check clamps the shard count or refuses the config | GW-BUD-10 |

### A16. Tenant-isolation tests (I6)

| ID | Proves |
|---|---|
| GW-ISO-01 | Runtime role under tenant A cannot SELECT/UPDATE tenant B rows in `ai_budget_accounts`, `ai_budget_holds`, `ai_usage_ledger`, `ai_request_metadata` (forced RLS, including table owner bypass disabled); catalog-driven check that every `greenguard_ai_usage` table has `tenant_id` + FORCE RLS unless on the non-tenant allowlist (R27) |
| GW-ISO-02 | Settle for a hold whose `tenant_id` differs from the transaction's tenant context fails (composite FK + RLS) |
| GW-ISO-03 | Identical text from A and B produces different embedding-cache keys; no generation output is cached for anyone |
| GW-ISO-04 | Every vLLM request carries a tenant-specific `cache_salt`; two tenants with identical prompts show no cross-tenant prefix-cache hits (vLLM prefix-cache hit metric under a controlled experiment) |
| GW-ISO-05 | Stream resume and status endpoints return 404 across tenants |
| GW-ISO-06 | Anthropic prompt layout: tenant data never appears before BP2, and every tenant segment starts with that tenant's secret nonce (renderer property test) |
| GW-ISO-07 | Usage Kafka events are keyed by the owning tenant; billing projector rejects key/body tenant mismatch |
| GW-ISO-08 | A `self_hosted_only` tenant's content never reaches the Anthropic or Bedrock adapter, including under every fallback path (fake provider records calls; exhaustive route-table test) |
| GW-ISO-09 | Rate-limit buckets of tenant A exhausted do not affect tenant B (noisy neighbour, R5) |
| GW-ISO-10 | A job-scoped token for tenant A cannot hold, settle or read metadata for tenant B; a tenant-scoped task with service identity is rejected (G52) |
| GW-ISO-11 | No table, log line or span in the gateway contains prompt or response text (seeded canary strings absent everywhere) |

### A17. Acceptance gates (I6)

1. All G01–G61 tests pass in CI (G06/G07 run with N = 1 and N > 1); `make verify`, coverage ≥ 80% (≥ 95% target on `budget/`, `routing/`, `policy/` packages), Sonar gate green.
2. Live E2E (`make ai-gateway-e2e`) with real Anthropic keys, charged to the **product Claude row** (not the eval row) and capped at **$10 per run, at most 2 runs/month ($20 of the $300)**: stream through grain-advisor and the BFF SSE endpoint to the browser, resume after forced disconnect, refusal handling, budget exhaustion → 429 `budget_exhausted` + `Retry-After`, ledger = usage report ± 1 token per call.
3. Crash matrix: SIGKILL at each of hold, call, first byte, last byte, settle. Zero double charges and zero lost ledger rows across 200 injected crashes.
4. Prompt cache: measured hit ratio ≥ 60% on a scripted 10-turn Advisor conversation, with the $ saving reported.
5. vLLM (local/Compose profile): benchmark report with goodput curve, 3 runs; $/1M tokens computed and written to the price table. EKS scale-from-zero with per-phase timings (including Spot vs On-Demand provisioning time) is certified in I13. CPU guard/embedding/reranker models serve a turn while the GPU is at zero.
6. Fallback: kill a provider (fault proxy) and show that p95 TTFT for `advisor_chat` stays within 2× SLO via fallback, with breaker open/close visible in metrics.
7. Isolation: GW-ISO-01..11 pass; start-up config check rejects sampling parameters on 5.5 routes (G51).
8. One trace crosses BFF → gateway → provider span → outbox → Kafka → billing inbox (ADR-0004).

---

## Part B: I11 Fine-tuning (QLoRA) and model lifecycle

### B1. Plain-language foundations (for the owner and for interviews)

- **Parameters / weights**: a model is a very large set of numbers (1.5 billion for Qwen2.5-1.5B). Each number scales how much one internal signal influences another. "Training" means nudging those numbers so that the model's outputs match examples better.
- **Loss**: one number that says how wrong the model was on a batch. For text it is cross-entropy: how surprised the model was by the correct next token. If the model gave the right token 90% probability the loss is small (−ln 0.9 ≈ 0.105); if it gave it 1%, the loss is large (−ln 0.01 ≈ 4.6). We train only on the answer tokens (completion-only loss), not on the prompt.
- **Gradient / autograd**: for every weight, the gradient says "if you increase this weight a tiny bit, the loss goes up or down by this much". PyTorch records every operation in the forward pass and replays it backwards (the chain rule) to get all the gradients at once. That is autograd, triggered by `loss.backward()`.
- **Optimizer**: the rule that turns gradients into weight changes. AdamW keeps a running average of each gradient (momentum) and of its size (to scale steps per weight), plus weight decay. The learning rate is the step size.
- **Training loop**: repeat {take a batch → forward pass → loss → backward (gradients) → optimizer step → zero gradients}; every N steps, measure loss on held-out validation data and stop when it stops improving (otherwise the model memorises: overfitting).
- **LoRA**: instead of changing all 1.5B numbers, freeze them and learn a small "correction" for chosen weight matrices. The correction is the product of two thin matrices (rank r, e.g. 16), so it is typically well under 1% of the parameters. The adapter file is megabytes, not gigabytes, and one base model can serve many adapters.
- **QLoRA**: additionally store the frozen base model in 4-bit (NF4) to cut memory ~4×, while computing in bfloat16 and training the LoRA matrices in higher precision. That is how a 7B model can be fine-tuned on one 24 GB L4.
- **RAG vs fine-tuning**: RAG gives the model *facts at question time* (documents change daily, need citations, and are tenant-specific, so they belong in RAG, I7). Fine-tuning changes *behaviour and format* (always answer in this JSON, recognise these eight fault signatures, be terse). Rule: use RAG when the knowledge changes or must be cited; fine-tune when a narrow task happens at high volume and prompting is too expensive, too slow or too inconsistent. Never fine-tune tenant-specific facts into a shared model.

### B2. What to fine-tune and why

**Task: sensor-fault triage.** Given a window of readings and features for one device (from the I1 simulator/feature store: temperature and moisture series summary, rate of change, variance, gaps, neighbouring-sensor correlation; numeric features and enums only, never free text), output strict JSON:

```json
{"fault_class": "stuck|drift|noisy|dropout|real_event|none",
 "confidence": 0.0-1.0,
 "evidence": [{"feature": "<name from input>", "value": <number>, "why": "<≤20 words>"}],
 "recommended_action": "ignore|recalibrate|inspect_sensor|replace_sensor|escalate",
 "explanation": "<≤60 words, farmer-readable>"}
```

**Class list (R31).** The fault classes are exactly those the I1 injector labels at node level: `stuck`, `drift`, `noisy`, `dropout`, plus the non-fault classes `real_event` and `none`. `calibration_offset` is added only if I1 adds an offset/calibration fault. `battery_brownout`, `cross_wired` and `clock_skew` are **not** classes unless I1 and the telemetry contract add them (the telemetry contract carries no battery or wiring signal today). The list is read from I1's `label_spec_version` at dataset build time, so the adapter can never be trained on a class the simulator does not produce.

Why this task: it is high volume (every anomaly flagged by I2/I5 needs triage), narrow, easy to label (the simulator injects faults, so ground truth is exact), tolerant of latency (seconds are fine), and needed by `self_hosted_only` tenants who cannot send data to Claude. A prompted frontier model works but costs too much at fleet volume. A small tuned model can match it on this one task.

Honest baseline: the I2 gradient-boosted classifier may beat any LLM on `fault_class` alone. The LLM's value is the grounded **explanation + action**. Gate B6 therefore compares against the classical model too, and the design allows the outcome "classifier decides class, LLM explains".

**Base model pin.** `Qwen/Qwen2.5-1.5B-Instruct` (primary; Apache-2.0) and `Qwen/Qwen2.5-7B-Instruct` (stretch; Apache-2.0), each pinned to a Hugging Face **commit revision SHA** with the licence file saved in the dataset/model card. **Avoid Qwen2.5-3B**, which uses a separate Qwen research licence (non-commercial). Verify every licence at pin time. Rejected: Llama 3.x (community licence with acceptable-use and attribution terms; fine but more obligations), Phi/Gemma (viable alternates, kept as a comparison row if time allows).

### B3. Data: sources, consent, PII, decontamination, versioning

| Source | Volume target (UNMEASURED) | Label | Notes |
|---|---|---|---|
| I1 simulator fault injection | 40k examples, balanced across the R31 classes (6 today), many seeds/sites | Exact class from the injector; evidence fields computed programmatically from features | Primary |
| Explanations | same | Template-generated from injected fault parameters, then **paraphrased** by Claude (Sonnet 5.5) for 20% of rows, human spot-checked | Open question on provider terms for training on model outputs (B10) |
| Tenant structured features (per-node feature windows + injected/confirmed class enums) | later; only once ≥ 50 tenants consent to `pooled` | Class enum from an alert verdict (§8 Q10) | **Only tenants whose `greenguard.tenant.ai_consent.v1` has `training = pooled`** (R24; default `none`, set by an org admin). **Structured features and enums only: no free text, no notes, no agent trajectories, no model outputs.** Consent is re-checked at export time, not collection time. Until the 50-tenant floor is met, training uses simulator data only |
| Hard negatives: simulated harvest/aeration events that look like faults | 5k | `real_event` | Prevents "everything is a fault" |

*Not used:* I8 agent trajectories, user feedback text and corrections, and any free-text field. R24 forbids them for pooled training, and this adapter is shared across tenants. `own_tenant` consent does not apply to a shared adapter; a per-tenant adapter would need its own ADR.

Pipeline (`ml/fault-triage/`, Python, uv-locked):
1. **Export** runs **one RLS transaction per consenting tenant** (R24): the job holds a job-scoped token for that tenant, sets tenant context with `set_config(..., true)`, and reads through the normal runtime role, so forced RLS applies. There is no cross-tenant exporter role, no BYPASSRLS and no SECURITY DEFINER function. The consenting-tenant list comes from the consent projection and is re-verified inside each tenant's transaction. Tenant keys are pseudonymised with a per-dataset `HMAC(dataset_key, tenant_id)` (R6), never dropped.
2. **No free text**: the export selects an explicit allowlist of numeric feature columns and enum columns; every free-text column (notes, site/device names, messages) is excluded by schema, not scrubbed. A test inserts canary PII into free-text columns and asserts it is absent, and a schema test fails if any exported column is a text type outside the enum allowlist.
3. **Pooled-training guards (R24 tests)**: 50-tenant floor; ≤ 10% of rows per tenant (cap); an adversarial tenant at the cap does not move another tenant's metrics beyond tolerance.
4. **Decontamination against I9 eval sets and the I11 test split**: exact hash match, 13-gram overlap on text fields, MinHash (Jaccard ≥ 0.8) on feature-serialised inputs. **Group split by simulation seed, site and device**, so the same device never appears in both train and test. Every removal is logged.
5. **Versioning**: immutable S3 path `s3://gg-ml-datasets/fault-triage/v{N}/` with shards + `manifest.json` (sha256 per shard, row counts per class, source commit, exporter version, consent snapshot version) + datasheet. The manifest hash is logged as an MLflow dataset input. Rejected: DVC (extra tool; S3 + manifest + MLflow lineage is enough here).
6. **Prompt–completion rows** (R31): each row is `{"prompt": [system, user], "completion": [assistant]}` in TRL's conversational prompt–completion format, rendered with the model's chat template, and trained with `completion_only_loss=True`, so loss is computed only on the JSON answer. The system prompt is the same bytes used at serving time.

### B4. Training recipe

Libraries (pin exact versions in `uv.lock`): PyTorch, Transformers, PEFT, TRL (v1.x `SFTTrainer`/`SFTConfig`), bitsandbytes, MLflow.

```python
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                         bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16)
peft_config = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                         target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"])
args = SFTConfig(output_dir=..., learning_rate=2e-4, lr_scheduler_type="cosine", warmup_ratio=0.03,
                 num_train_epochs=2, per_device_train_batch_size=8, gradient_accumulation_steps=4,  # effective 32
                 max_length=1024, packing=False, completion_only_loss=True,  # loss only on the answer
                 gradient_checkpointing=True, optim="paged_adamw_8bit", bf16=True, weight_decay=0.0,
                 max_grad_norm=0.3, eval_strategy="steps", eval_steps=200, save_steps=200,
                 load_best_model_at_end=True, metric_for_best_model="eval_loss", seed=42, report_to=["mlflow"])
trainer = SFTTrainer(model=model, args=args, train_dataset=train, eval_dataset=val, peft_config=peft_config)
```

Why these values: r=16 with alpha=32 is a standard starting capacity for a narrow task. All linear projections are targeted because QLoRA results favour adapting MLP layers too. lr 2e-4 is the usual LoRA rate (≈10× full fine-tuning). Packing is off so each example's loss mask is exact. `paged_adamw_8bit` avoids optimizer-state OOM spikes. A small **sweep** (r ∈ {8,16,32}, lr ∈ {1e-4, 2e-4}) is run on 1.5B only, and every run is logged.

Optional **DPO** stage (TRL `DPOTrainer`, β=0.1): preference pairs where "chosen" cites the correct evidence features and "rejected" is fluent but ungrounded. It runs only if B6 shows explanation-faithfulness below target after SFT.

Hardware and time: 1× L4 24 GB or an equivalent 24 GB GPU (both 1.5B and 7B QLoRA are expected to fit; peak memory is recorded). Wall time is UNMEASURED; estimate 1–3 h for 1.5B and 6–12 h for 7B on 40k examples.

### B5. Training job on EKS

**EKS profile is certified in I13 (ADR-0024 accepted; R29).** Until then, training runs on **simulator data only** on a local 24 GB GPU or a rented GPU (allowed only for synthetic-only datasets); the checkpointing and resume logic below is the same. The EKS design:

- `Job` in namespace `ml-training` admitted by **Kueue** (`ClusterQueue` with `nvidia.com/gpu: 1` quota, lower priority than serving), so training can never take the GPU that serving needs. It runs on the Spot g6 (L4) NodePool via Karpenter, with the On-Demand pool as fallback (a run that has been interrupted more than N times, default 3, is re-queued on On-Demand; UNMEASURED).
- Checkpoints (adapter, optimizer, scheduler, RNG and data-loader state) go to S3 every 200 steps, written to a temporary key and then renamed/committed via a manifest object so a half-written checkpoint is never resumed. A 2-minute Spot interruption notice is also handled: the pod receives SIGTERM when Karpenter drains the node; the trainer traps it, writes an immediate checkpoint if it can finish within the grace period (`terminationGracePeriodSeconds` ≤ 120 s; a 1.5B-7B QLoRA adapter plus optimizer state must be measured to fit), and exits non-zero so the Job restarts (backoffLimit 6) and resumes with `resume_from_checkpoint`. If the immediate write does not finish, the last periodic checkpoint is used.
- EKS Pod Identity: an IAM role read-only on the dataset bucket (SSE-KMS, per-tenant DEK envelope for tenant-derived data), write on `s3://gg-ml-artifacts/`, no access to production databases.
- The image is pinned by digest and signed (Stage 12 Cosign). The run records the git SHA, image digest, dataset manifest hash and seed in MLflow.
- Rejected: SageMaker training jobs (valid and simpler, but hides the scheduling/preemption work the owner wants to learn; kept as an ADR alternative). Rented GPU clouds (RunPod/Lambda) are allowed only for **synthetic-only** datasets, since tenant-derived data must not leave the AWS account.

### B6. Evaluation and gates

Test set: group-held-out simulator seeds (≥ 4,000 examples, ≥ 300 per class) + the I9 triage eval set + 200 human-labelled real-looking hard cases.

Eval spend follows R22: prompted-Qwen and adapter runs are T1 (self-hosted, scheduled GPU windows); single-shot prompted Claude baselines and the Opus judge run as T2 through the **Message Batches API** (≤ $12 per weekly run ≈ $52/month, $30 release-candidate reserve, $18 online/canary/recalibration line; $100/month eval cap; only single-shot triage items and judge calls are batched, multi-turn items never), using T0 recorded responses on PRs.

Systems compared, all on **identical inputs**: (a) prompted Qwen base (same system prompt, 5-shot), (b) prompted `claude-haiku-4-5`, (c) prompted `claude-sonnet-5-5`, (d) I2 classical classifier (class only), (e) **adapter on the exact serving configuration** (same quantisation and vLLM version as production, because an adapter trained on an NF4 base but served on an AWQ/FP8 base can behave differently).

Metrics: macro-F1 and per-class recall (critical classes `stuck` and `drift`, which silently corrupt readings, need recall ≥ 0.9), JSON schema validity, calibration (ECE, 10 bins), **evidence faithfulness** (every `evidence.feature` exists in the input and its `value` matches within tolerance, checked programmatically), explanation quality from an LLM judge (Opus 5.5 with rubric, calibrated against 200 human labels, agreement κ reported), p95 latency and $/1k triages.

Statistics: **paired bootstrap** (10,000 resamples of per-example score differences, e.g. F1 contribution or correctness) gives a 95% CI for adapter − baseline. McNemar's test is also reported for class accuracy.

Promotion gate (all must hold):
1. Macro-F1 CI lower bound > 0 vs prompted base, and not worse than prompted Sonnet 5.5 by more than 0.02 (point estimate).
2. JSON validity ≥ 99.5%; evidence faithfulness ≥ 98%.
3. Critical-class recall ≥ 0.9; ECE ≤ 0.05.
4. No regression > 1 point on a general-capability smoke set (catastrophic-forgetting check, e.g. 200 generic instruction prompts).
5. Cost per 1k triages ≤ 20% of prompted Haiku at the measured self-hosted rate.
6. Contamination audit report attached (zero overlap after dedup).

If the adapter doesn't beat the classical classifier on class, ship "classifier class + adapter explanation" and record that result in the evidence. This counts as a valid outcome, not a failure.

### B7. Registry, serving, canary, rollback

- **MLflow** model `fault-triage-lora`, version N, with artifacts: adapter safetensors + `adapter_config.json`, tokenizer config, eval report, dataset manifest, model card (intended use, limits, licence of base). Tags: `base_model`, `base_revision`, `serving_quant`, `git_sha`, `dataset_hash`. Aliases: `candidate`, `champion`, `previous`. Rejected: HF Hub private repo as the registry (no alias workflow tied to our evals; external dependency).
- **Export**: the adapter is served un-merged through vLLM multi-LoRA (default). Merging + AWQ quantisation of a merged model (`wshobson-quantized-export`) is only for a single-tenant dedicated deployment, with the eval re-run on the merged artefact.
- **Rollout**: (1) *shadow*: the gateway sends 100% of `fault_triage` to champion and also to candidate asynchronously, results are compared, candidate output is never shown, and the shadow cost is capped. (2) *canary*: 5% → 25% → 100% by deterministic hash, each step held ≥ 24 h or ≥ 2,000 requests. (3) **Automatic rollback** when any trigger holds over a 15-min window: JSON validity < 99%, disagreement with the classical detector > baseline + 10 pp, error rate > 1%, p95 latency > 2× champion, or user 👎 rate > 2× champion. Rollback = flip the route weight to champion in `ai_model_routes`, which the gateway hot-reloads in < 30 s. No redeploy is needed because both adapters are resident (`--max-loras ≥ 2`).
- Every triage output stores `adapter@version`, so outputs can be traced back to the model and dataset that produced them.

### B8. Edge cases and failure modes (I11)

| # | Scenario | Expected behaviour | Test ID |
|---|---|---|---|
| F01 | Tenant changes `training` from `pooled` to `none` after export | Next export excludes them; datasets containing their rows are marked `retired`; any model trained on them is retrained at the next cycle (the retention period for consent withdrawal is documented) | FT-CON-01 |
| F02 | Consent projection stale at export time | Export aborts (fail closed) | FT-CON-02 |
| F03 | PII canary in a notes/free-text field | Never selected (column not on the allowlist); export fails if any exported column is free text | FT-PII-01 |
| F04 | Eval example near-duplicated in train | Removed by MinHash; audit report lists it | FT-DEC-01 |
| F05 | Same device in train and test | Group split prevents it; assertion in the split script | FT-DEC-02 |
| F06 | Class imbalance (dropout 40%, stuck 1%) | Stratified sampling / oversampling to the target mix; per-class metrics gate | FT-DATA-01 |
| F07 | Label noise from paraphrased explanations contradicting the class | Programmatic consistency check (explanation mentions the class's signature features) rejects the row | FT-DATA-02 |
| F08 | Spot preemption at step 1,730 | Resume from step 1,600 checkpoint; final metrics within noise of an uninterrupted run | FT-JOB-01 |
| F09 | OOM at 7B | Job fails fast; recipe fallback: max_length 768, batch 4 × accum 8 | FT-JOB-02 |
| F10 | Loss becomes NaN | Callback stops the run; logs the batch; lr halved on rerun | FT-JOB-03 |
| F11 | Validation loss rises while train falls (overfit) | Early stopping keeps the best checkpoint | FT-JOB-04 |
| F12 | Non-deterministic results across reruns | Seeds fixed; report variance across 3 seeds for the chosen config | FT-JOB-05 |
| F13 | Chat template mismatch between training and vLLM serving | Golden test renders the same example through both and compares token IDs | FT-SRV-01 |
| F14 | Adapter rank > `--max-lora-rank` | vLLM fails to load → CI serving smoke test fails before promotion | FT-SRV-02 |
| F15 | Adapter trained on NF4 base degrades on AWQ/FP8 served base | Gate B6 evaluates on the serving config; failing combination blocked | FT-SRV-03 |
| F16 | Output invalid JSON | Guided decoding prevents it; if it occurs anyway, gateway returns `triage_unavailable` and falls back to classifier-only | FT-SRV-04 |
| F17 | Evidence cites a feature not in the input (hallucination) | Faithfulness validator strips the output → classifier-only + metric | FT-SRV-05 |
| F18 | Canary adapter worse on one tenant segment only | Segment metrics (crop type, sensor model; not tenant labels) in the canary dashboard; rollback trigger per segment | FT-CAN-01 |
| F19 | Rollback while requests are in flight | In-flight requests finish on the adapter they started with; new requests go to champion | FT-CAN-02 |
| F20 | MLflow unavailable | Gateway keeps its last route table (it doesn't read MLflow at runtime); promotions are blocked | FT-REG-01 |
| F21 | Base model revision on HF deleted or changed | Weights served from our S3 mirror by SHA; new training runs fail closed on a hash mismatch | FT-REG-02 |
| F22 | Dataset manifest hash mismatch | Training refuses to start | FT-REG-03 |
| F23 | Distribution shift (new sensor hardware) | I5 drift monitor on input features → triage fallback to classifier + retrain ticket | FT-DRIFT-01 |
| F24 | Adversarial text inside a device name field (prompt injection) | Free-text fields excluded from model input; only numeric features + enums | FT-SEC-01 |
| F25 | Export attempts to read a second tenant inside one tenant's transaction | Zero rows (forced RLS); no role can read across tenants | FT-ISO-02 |
| F26 | Fewer than 50 tenants consent to `pooled` | Export of tenant data refuses; training uses simulator data only | FT-CON-03 |
| F27 | One tenant exceeds 10% of pooled rows | Down-sampled to the cap; adversarial-tenant metric test passes | FT-CON-04 |
| F28 | Dataset requests a class I1 does not produce (e.g. `battery_brownout`) | Dataset build fails against I1's `label_spec_version` | FT-DATA-03 |

### B9. Tenant-isolation tests (I11)

| ID | Proves |
|---|---|
| FT-ISO-01 | Export includes zero rows from tenants whose consent is not `pooled` (seeded two-tenant test) |
| FT-ISO-02 | Export runs one RLS transaction per tenant with a job-scoped token; inside tenant A's transaction, tenant B's rows are invisible; no exporter role, BYPASSRLS or SECURITY DEFINER exists (catalog check) |
| FT-ISO-03 | Exported rows contain no raw `tenant_id`, user IDs, emails, site names or any free-text column (keys are HMAC pseudonyms) |
| FT-ISO-04 | A shared adapter cannot be prompted to reproduce another tenant's specific readings (membership-inference smoke test: canary sequences inserted for tenant A are not reproduced when prompted from tenant B) |
| FT-ISO-05 | Serving: `fault_triage` requests still carry the tenant `cache_salt` (GW-ISO-04) |

### B10. Open issues I11 must resolve

- Whether using Claude outputs (paraphrased explanations, judge labels) as fine-tuning data is permitted under GreenGuard's Anthropic commercial terms. This needs the owner or legal to decide. The fallback is template-only explanations plus human edits.
- Consent semantics are settled by R24 (`training ∈ {none, own_tenant, pooled}`, default `none`, set by an org admin); owner approval is README §8 Q2.

---

## Part C: Shared sections

### C1. Senior topics covered

LLM gateway / provider abstraction; policy-driven routing with eval-score tables; cost-aware routing and downgrade; hold-then-settle budgets with explicit pessimistic locking and shard spill; money reconciliation against the provider usage API; idempotent LLM calls; circuit breakers, jittered retries, deadline propagation, and why hedging is rejected; SSE streaming with resume and backpressure; Anthropic prompt caching engineered from the real prefix rules; why no answer or semantic cache, tenant-keyed caches and per-tenant cache nonces/salts; delegated and job-scoped tenant tokens; structured outputs and strict tool use; refusal handling and server-side fallbacks; token accounting; prompt and model registry with per-call lineage; per-tenant data-routing and ZDR policy; vLLM internals (PagedAttention, continuous batching, KV vs prefix cache, `cache_salt`); quantisation trade-offs (AWQ/GPTQ/FP8/NF4); multi-LoRA serving; GPU scale-from-zero with KEDA and cold-start engineering; benchmark methodology and goodput; unit economics ($/1M tokens from measured utilisation); QLoRA mechanics; dataset curation, consent, PII, decontamination and lineage; completion-only SFT and optional DPO; paired-bootstrap significance; calibration; faithfulness validation; MLflow lifecycle; shadow → canary → auto-rollback; Kueue GPU scheduling with preemption-safe checkpointing.

### C2. ADRs to write

1. **ADR-00xx Model gateway as sole LLM egress (Go)**: language, build-vs-buy (LiteLLM), normalised contract.
2. **ADR-00xx AI budget hold-then-settle**: authority split gateway/billing, lock choice (`FOR UPDATE NOWAIT` + shards), reaper charging policy, reconciliation tolerance.
3. **ADR-00xx Tenant data-routing policy and ZDR**: policy values, stale-projection behaviour, fallback filtering.
4. **ADR-00xx Prompt caching layout and cache-safety**: breakpoint map, workspace-per-environment, per-tenant secret nonce at the start of every tenant segment.
5. **ADR-00xx No answer or semantic cache**: only prompt caching (per-tenant nonce), vLLM `cache_salt` and a tenant-keyed embedding cache (R20).
6. **ADR-00xx Self-hosted inference on EKS**: g6 L4 Spot via Karpenter with On-Demand fallback, KEDA scale-from-zero, weights mirroring, static multi-LoRA (no runtime loading), `cache_salt` derivation.
7. **ADR-00xx Retry and hedging policy for LLM calls.**
8. **ADR-00xx Fine-tuning data consent, PII and decontamination** (implements R24; per-tenant RLS export).
11. Referenced, owned elsewhere: **ADR-0026** delegated identity (R14), **ADR-0028** history and compaction (R19), **ADR-0024** cloud (R29), **ADR-0002** lock choice for budget shards.
9. **ADR-00xx Model lifecycle**: MLflow aliases, shadow/canary/rollback triggers, evaluate on the serving configuration.
10. **ADR-00xx Base model and licence pinning** (Qwen2.5 1.5B/7B Apache-2.0; exclusion of 3B).

### C3. Installed Claude skills to load when implementing

`claude-api` (caching, streaming, refusals, token counting; its `cost-optimize` flow for A7/A8), `ecc-cost-aware-llm-pipeline`, `ecc-cost-tracking`, `wshobson-python-resilience` and `ecc-golang-patterns` / `wshobson-go-concurrency-patterns` (gateway), `ecc-redis-patterns`, `ecc-postgres-patterns`, `wshobson-architecture-decision-records`, `ecc-kubernetes-patterns`, `ecc-benchmark-methodology`, `wshobson-slo-implementation`, `wshobson-lora-qlora-recipes`, `wshobson-finetuning-method-selection`, `wshobson-dataset-curation`, `wshobson-quantized-export`, `wshobson-preference-optimization` (DPO), `ecc-pytorch-patterns`, `wshobson-ml-pipeline-workflow`, `wshobson-evaluation-methodology`, `wshobson-llm-evaluation`, `ecc-canary-watch`, `wshobson-gdpr-data-handling`, `context7` (pin-time API checks).

### C4. Monthly demo cost envelope (UNMEASURED estimates)

Gateway + Redis + Postgres share existing cluster resources (~$0 incremental). Claude API: product LLM hard cap **$300** plus evals **$100** (T2 ≤ $12/week ≈ $52, a $30 release-candidate reserve and an $18 online/canary/recalibration line) (R22); Claude at both caps is $400 of the $1,000 total. CPU guard/embedding/reranker pods: shared cluster CPU, UNMEASURED. g6 L4 Spot serving at ~4 h/day scale-from-zero: ~$40–90 (UNMEASURED; recompute with current AWS Spot prices in I0). Training: 2–4 runs × 3–10 h Spot L4: ~$10–40. S3/EBS weights: ~$10–30. Total AI increment ≈ **$180–310/month**, which sits inside the infrastructure cap of $600 (R22) together with the base platform; the Claude caps are separate ($400). Actual spend is taken from the gateway ledger and the AWS Cost and Usage Report (Bedrock-served Claude appears under the AWS Marketplace/provider line, not under Bedrock), not from this table.
