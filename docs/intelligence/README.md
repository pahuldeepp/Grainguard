# GreenGuard Intelligence — design spec index

Date: 2026-09-29 · Status: rev 3 — owner decisions of 2026-09-29 applied (ADR-0023 accepted; AWS; budgets) · Track ADR: [0023](../adr/0023-intelligence-track.md) (Accepted) · Cloud ADR: [0024](../adr/0024-aws-platform.md) (Accepted)

GreenGuard Intelligence adds a predictive-ML layer and an AI copilot ("Grain Advisor") to GreenGuard. It is a parallel, dependency-gated track (I0–I13) in which every senior AI-engineering topic is implemented, measured and explainable: classical ML, PyTorch, transformers, MLOps, RAG, LangGraph agents, MCP, guardrails and AI security, evals, QLoRA fine-tuning, vLLM, LLM observability and production scale.

**This README is binding.** Where a section file disagrees with §2–§6 below, this README wins; section files are renamed/edited to match as each stage starts (the stage's first task). Rev 2 folds in three independent reviews (architecture-guard 20 findings, tenant-isolation 14, critic 20 — verdict REJECT on rev 1); every finding is resolved in §2 or listed as an owner question in §8.

## 1. Section files

| File | Stages |
|---|---|
| [I00_CHARTER.md](I00_CHARTER.md) | I0 — architecture, service map, data ownership, workload and cost model, cross-cutting edge cases |
| [I01_I02_DATA_AND_CLASSICAL_ML.md](I01_I02_DATA_AND_CLASSICAL_ML.md) | I1 simulator, feature kernel, datasets; I2 classical ML ladder, backtesting, MLflow |
| [I03_I05_DEEP_LEARNING_AND_ONLINE_ML.md](I03_I05_DEEP_LEARNING_AND_ONLINE_ML.md) | I3 PyTorch; I4 transformer from scratch; I5 online scoring, shadow/canary, drift, retraining |
| [I06_I11_MODEL_GATEWAY_AND_FINETUNING.md](I06_I11_MODEL_GATEWAY_AND_FINETUNING.md) | I6 model gateway and vLLM; I11 QLoRA and model lifecycle |
| [I07_I08_RAG_AND_GRAIN_ADVISOR.md](I07_I08_RAG_AND_GRAIN_ADVISOR.md) | I7 knowledge and RAG; I8 Grain Advisor agent, MCP, human approval |
| [I09_I10_EVALS_AND_AI_SECURITY.md](I09_I10_EVALS_AND_AI_SECURITY.md) | I9 AI evals; I10 guardrails and AI security (mandatory gates S1–S16) |
| [I12_I13_OBSERVABILITY_AND_PRODUCTION.md](I12_I13_OBSERVABILITY_AND_PRODUCTION.md) | I12 agent/LLM and ML observability (mandatory); I13 deployment, load, chaos, DR |

## 2. Binding decisions

### 2.1 Services, ownership and data

| # | Decision |
|---|---|
| R1 | **Five new services**: `ml-scoring` (Python), `model-gateway` (Go), `knowledge-service` (Python; three deployables from one codebase and DB: API with the retrieval module, indexer worker, sandboxed parser worker), `grain-advisor` (Python, LangGraph), `mcp-gateway` (TypeScript, official MCP TS SDK, reuses `packages/tenant-auth`). No `feature-service`, `retrieval-api`, `advisor` or `mcp-server` — read those names in section files as the above. |
| R2 | **Feature state has one owner**: `ml-scoring` owns `greenguard_ml` (incl. online window state, formerly `greenguard_features`). I1 delivers `packages/ml-features` (one feature kernel used online and offline) and the **offline** corpus; the online streaming consumer is built in I5. |
| R3 | **ml-scoring inputs (real topic names)**: `greenguard.telemetry.recorded.v1`, `greenguard.inventory.device.v1`, `greenguard.inventory.lot.v1`, `greenguard.inventory.facility.v1`, `greenguard.risk.assessment.v1`, `greenguard.risk.assessment_invalidated.v1`. Sensor values come from telemetry; risk events supply only the risk-engine's lot join and verdict for comparison. `risk.assessed.v1` and `telemetry.canonical.v1` do not exist. |
| R4 | **Training corpus**: the simulator runs the shared feature kernel directly into Parquet (bulk). A **real-ingest parity sample** (~20 bin-seasons through telemetry-ingest → CDC → ml-scoring online path) must produce identical features and is an I1/I5 gate. Bulk data never goes through ingest (CAPACITY_MODEL: ~200 events/s per transformer worker). |
| R5 | **Sensor model (one decision)**: one cable node = one device; 4 cables × 4 depths = 16 devices per reference bin; reading cadence 15 min per device; feature/forecast grid 15 min per bin; I4 patch = 8 steps (2 h). I0 recomputes A1/A9 and all capacity/cost rows from this. |
| R6 | **Datasets**: I1 exports both per-bin feature rows and a `sequence_windows` export (per-node series at native cadence) for I3–I5, in one documented Parquet layout. Keys are **pseudonymised with a per-dataset HMAC**, never dropped; files are partitioned by tenant pseudonym. Parquet is never served to tenants (prediction logs are served from the RLS database). Retention lock is not applied to tenant data. |
| R7 | **ML is advisory only.** `risk-engine` stays the alert authority; ML never suppresses or alters a threshold alert. Promotion to authority needs a new ADR (out of scope). |
| R8 | **Shadow predictions are table-only** (`greenguard_ml.ml_shadow_predictions`), never written to the outbox, so no shadow row can reach Kafka. Only champion/canary predictions enter the outbox. `workflow-alerts` does not consume `ml.prediction.v1` (charter row removed). |
| R9 | **Scoring cadence**: tier A lightweight fault/anomaly model per device reading window (inline micro-batch, CPU); tier B forecasts per bin every 15 min (scheduled micro-batch). All predictions commit to `ml_predictions`; `ml.prediction.v1` is published only on material change; a **scored-through watermark** event `ml.scored_through.v1` per partition (ADR-0009 checkpoint pattern) is published every cycle, and every read-side freshness check (advisor staleness, SLO, missing-prediction guardrail) uses the watermark. Batched transactions per poll; offsets commit after the batch's effects. I5 measures publish ratio and write amplification (review R3). |
| R10 | **Model deployment authority is Git**: a per-cell deployment manifest in `infra/gitops` (Argo) is the only source of which model version is champion/canary per cohort. MLflow aliases are a reconciled projection. `ml.model_deployment.v1` and `model_deployments` are removed. **Canary** = cohort selection inside ml-scoring via Stage-10 feature flags. **Rollback fast path** = flag cohort to 0% (seconds) + automatic Git revert PR; nothing writes MLflow aliases directly. |
| R11 | **Public knowledge corpus** lives in separate non-tenant tables (`public_documents`, `public_chunks`, curator role, no RLS exception, no sentinel tenant) and a separate **single-shard** OpenSearch index written with a curator credential. Tenant content lives in one shared index per cell and embedding version, `_routing = tenant_id`, mandatory server-side tenant filter inside the k-NN query. Public hits are accepted only from the public index. |
| R12 | **Knowledge indexer** validates Kafka key = envelope tenant = payload tenant, recomputes `chunk_id` from tenant, rejects the public tenant on the tenant path. `knowledge.chunks.v1` carries **IDs, not chunk text**. Indexing embeddings run under a platform budget (not the tenant's), and a failing tenant is quarantined without holding the partition. |
| R13 | **Parser sandbox**: one fresh gVisor pod per document, bytes pushed in by knowledge-service, **zero network**; knowledge-service binds results to `(tenant, document_id, version, sha256)` and ignores parser-claimed identifiers. |

### 2.2 Identity, approvals and actions

| # | Decision |
|---|---|
| R14 | **Delegated identity (one mechanism)**: for interactive turns, the BFF issues a short-lived (≤5 min) delegated token (new issuer, `sub`=user, `tenant` from membership, `act`=`grain-advisor`, audience `greenguard-mcp` or `model-gateway`), verified by `packages/tenant-auth` — built in **I8a** (read-only turns already need it). `mcp-gateway` obtains downstream tokens (`read-api`, `workflow-alerts`, `knowledge-service`) from the same issuer's **internal delegation endpoint**: it presents the `greenguard-mcp` token plus its own service identity and receives a token with the same `sub`/`tenant`, `act` chain `grain-advisor → mcp-gateway`, one downstream audience, ≤ remaining lifetime. Only `mcp-gateway`'s service identity may call that endpoint. Background tenant work (indexing, eval, scoring exports) uses **job-scoped tokens** minted by the owning service for one tenant. Bare service identity is allowed only for non-tenant tasks; the gateway rejects tenant-scoped `task_type` without a tenant-bound token. No raw bearer forwarding. RFC 8693 token exchange is used only for external MCP clients (**I8c**, depends on GG-09). ADR-0026. |
| R15 | **Approval contract (one ADR)**: endpoint `POST /v1/advisor/proposals/{id}/decision`; row fields `action_hash`, `proposed_by`, `approver_id`, `approver_role`, `version`, `expires_at` (15 min), `status`; **optimistic concurrency** (`If-Match: version`, 409 on mismatch; ADR-0002), expired → 409 `proposal_expired`. `proposal_id = uuidv5(run_id ‖ action_hash)`; the proposing node runs with `durability="sync"`. Execution happens only inside the resumed graph with the approver's live delegated token; if unavailable the proposal is `approved_pending_reauth` — no outbox retry of execution. `create_work_order` is deferred. ADR-0027. |
| R16 | **One agent graph and tool policy**: `ai/policy/tools.yaml` is the single source for nodes, per-node tool allowlists (includes `resolve_bin`, `get_site_summary`), role rules and limits (**8 tool calls, 60 s per turn**). **Viewers get read tools only and cannot propose**; operators and admins propose; approval requires operator+ and follows §8 Q9 for self-approval. Enforced at both grain-advisor and mcp-gateway. |
| R17 | **Per-user ownership inside a tenant**: threads, run events and streams are owned by their author (tenant admins may read). **Proposals** are readable by their author and by every operator/admin of the tenant (the approver set), and show only the action, its hash and cited evidence — not the originating thread; enforced by RLS policy on `user_id` plus repository filter, with tests for `run_events`, stream resume, `askAdvisor(threadId)` and subscriptions. |

### 2.3 LLM behaviour and safety

| # | Decision |
|---|---|
| R18 | **Streaming**: before validation only progress and tool events stream. Answer text is released only after structured-output ⑫, groundedness ⑬ and output-safety ⑭ checks pass (buffered, released per validated sentence). TTFT is defined as **time to first validated token**; the SLO is set from I12 measurement (provisional p95 ≤ 5 s). Token stream uses a BFF SSE endpoint with `Last-Event-ID`; run/approval state uses the GraphQL subscription `AdvisorRun`. |
| R19 | **Claude 5.5 rules**: first-party aliases `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5` (Bedrock IDs mapped per provider; served snapshot logged). **No sampling parameters on 5.5 routes** (they return 400); repeatability via k runs and `effort`; a gateway startup check rejects any route config with sampling params for 5.5. No forced `tool_choice` with thinking; use strict tools/structured outputs + validate-and-retry. **History is append-only**; long threads use server-side compaction or a documented strip-thinking policy (ADR-0028). |
| R20 | **Caching**: no final-answer or semantic answer cache (charter §5.2 #4 withdrawn). Anthropic prompt caching keeps a static prefix; any tenant segment starts with a **per-tenant secret nonce**; vLLM uses per-tenant `cache_salt`. Embedding and response caches are keyed by tenant. Content hashes on spans are HMAC with a per-tenant key. |
| R21 | **GPU availability**: guard and retrieval models needed on every turn run on CPU — Prompt Guard 2 86M, a small embedding model and a small reranker — or a hosted equivalent; the output-safety classifier is a small quantised model sized to fit (Llama Guard 4 12B does not fit an L4; I10 picks and verifies the model). GPU (L4, scale to zero) serves generation, fine-tune adapters and evals only. "No turn waits on a cold GPU" applies to generation; `self_hosted_only` tenants see a bounded wait (≤ 15 min, shown in UI). |
| R22 | **Budgets (owner, 2026-09-29): $1,000/month total = infrastructure ≤ $600 (incl. GPU) + product Claude ≤ $300 + eval Claude ≤ $100.** Reconciled split — infrastructure: Lean plan of record (I00 §5.1: infrastructure subtotal ≈ $582 + $400 Claude at both caps ≈ $982 total, about $18 of headroom — tight; prices for some lines are UNVERIFIED, so the AWS Budgets alerts at 50/90/100% and the GPU/Claude hard caps are the real control); product Claude $300 = customer traffic + local/dev real-Claude (own key, ≤ $60/month) + the I6 E2E test; eval Claude $100 = T2 weekly ≤ $12/run (≈ $52/month) + release-candidate reserve $30 + $18 for online-eval judge calls, canary evals and judge recalibration. Product cap is a **global budget row** (its own sharded account, held on every call in addition to per-tenant budgets); eval cap is a separate key and budget row. Evals: T0 recorded responses per PR ($0), T1 self-hosted in scheduled GPU windows, T2 Claude weekly. **The Message Batches API is used only for judge calls and single-shot items**; multi-turn agent items use the standard API on recorded tool results (one self-contained request per turn) or run T1. Claude-judged gates whose sample is below the declared minimum-detectable-effect sample are **warn-only** until enough items exist. Bedrock has no Batches API. Budget exhaustion is always **429 `budget_exhausted` with `Retry-After`**. Money is authoritative in Postgres (`greenguard_ai_usage`) on sharded rows; a hold larger than one shard's remainder is taken across shards in fixed shard order (no deadlock), and per-route `max_output_tokens` is capped so a valid call always fits (documented per ADR-0002 money/quotas row). GPU spend is capped in code: Karpenter NodePool `limits` (`nvidia.com/gpu: 1` in the demo), KEDA `fallback.replicas: 0` for GPU scalers, and an AWS Budgets action that scales GPU pools to zero. |

### 2.4 Content, consent and deletion

| # | Decision |
|---|---|
| R23 | **One content store** `grain-advisor.ai_interaction_content`, per-tenant DEK envelope encryption, 30-day default retention. The LangGraph checkpointer is custom and tenant-scoped (tenant_id, forced RLS) and its serializer wraps blobs with the **per-tenant DEK**. The gateway stores **no** prompt/response content. Eval replay reads content through grain-advisor's API with a tenant-bound token. Minimum key hierarchy (AWS KMS KEK per env, per-tenant DEK) is built in **I8a** (closes review O1 for AI data). |
| R24 | **Consent (one model)**: tenant-control-plane owns `greenguard.tenant.ai_consent.v1` with `training ∈ {none, own_tenant, pooled}` (default `none`) and `eval_review: bool` (default false), set by an org admin, projected to consumers; built as an I2 prerequisite. Until ≥ 50 tenants consent to `pooled`, training uses simulator data only. Pooled training uses **structured features and enums only — no free text, no agent trajectories**. Export runs one RLS transaction per tenant (no BYPASSRLS/SECURITY DEFINER). Tests: floor, ≤ 10% per-tenant cap, no free-text columns, adversarial tenant at cap does not move another tenant's metrics beyond tolerance. |
| R25 | **Online evals**: `greenguard.ai.interaction.completed.v1` via grain-advisor outbox, key `tenant_id:turn_id`, IDs only. The eval worker processes one tenant per transaction and calls the judge **with that tenant's token**, so its data-routing policy applies (`self_hosted_only` → vLLM judge or skip). Human review and dataset reuse require `eval_review = true`. |
| R26 | **Deletion inventory**: every store holding tenant data (Postgres DBs incl. checkpoints and PITR, OpenSearch + snapshots, S3 Parquet + soft delete, Kafka topics + retention, Redis, MLflow artifacts, content store) is listed with its deletion mechanism in I00 §3 (edited at I0). Tenant deletion = crypto-shred DEK + hard delete + **deletion-ledger replay after any restore**. Test IT-05 becomes delete → restore → assert zero rows/hits in every store. Platform tenant-deletion event (review O2) is a tenant-control-plane prerequisite of I10. |
| R27 | **Catalog-driven isolation test**: every table and partition in every AI database must have `tenant_id` + FORCE RLS unless on a reviewed non-tenant allowlist (e.g. `public_*`). Every new consumer has a key/envelope/payload tenant-mismatch test. |

### 2.5 Observability, cloud and numbering

| # | Decision |
|---|---|
| R28 | No prompt/response text or tenant IDs in metric labels or span attributes; OTel GenAI semantic conventions pinned to a commit; `gen_ai.evaluation.result` links traces to evals. `model-gateway` is the sole emitter of LLM spans/metrics and `ai.usage.v1` (`ai_usage_ledger`). A **Python OTel helper** (`packages/otel-py`, ADR-0004 rules, `traceparent` on outbox rows) is built in I1 before any Python AI service emits events. |
| R29 | **Cloud: AWS, platform-wide** ([ADR-0024](../adr/0024-aws-platform.md), Accepted 2026-09-29; it supersedes an earlier same-day GCP draft). EKS, RDS PostgreSQL, MSK (or in-cluster Kafka for the demo), S3 + KMS per-tenant DEKs, ElastiCache, OpenSearch Service, ECR + Cosign + Kyverno, Terraform, Argo CD/Rollouts, EKS Pod Identity. **gVisor on EKS is self-installed** on a dedicated node group (custom AMI) — there is no managed gVisor. GPU = `g6` (L4) on Spot via Karpenter with On-Demand fallback; Spot capacity is measured, not assumed. Claude: first-party API primary; Claude on Amazon Bedrock is an optional second provider with its own capability table (verify parity before enabling). Where a section file still says GKE, GCP, GCS or Vertex, read the AWS equivalent from the ADR-0024 table. I6's local/Compose vLLM profile is unchanged; I13's EKS work no longer waits on the ADR. |
| R30 | Intelligence ADRs start at 0023 (0023 track, 0024 cloud, 0025 backfill amending ADR-0006, 0026 delegated identity, 0027 approvals, 0028 history/compaction, then per-stage ADRs). Placeholders `ADR-AI-xx`/`ADR-I*` in section files are renumbered when written. New technologies are added to `docs/TECHNOLOGY_CATALOG.md` as an I0 exit item. |
| R31 | **I11 scope**: fault classes are exactly the I1 injector's list — `stuck`, `drift`, `offset`, `noise`, `spike`, `dropout`, `cable_break` — plus `real_event` and `none`. `battery_brownout`, `cross_wired`, `mount_error` and `clock_skew` are out unless I1 and the telemetry contract add them. Training rows use prompt–completion format with `completion_only_loss`. |
| R32 | **Backfill** (ADR-0025, amends ADR-0006): separate authenticated backfill endpoint, one reading per receipt, max age set by owner (§8 Q6); readings carry `backfilled=true`; synthetic tenants (`tenant.synthetic`) and backfilled readings never notify (alerts recorded as backfilled). |

## 3. Name registry

| Kind | Name | Owner | Notes |
|---|---|---|---|
| DB | `greenguard_ml` | ml-scoring | predictions, shadow table, window state, inbox/outbox, training manifests |
| DB | `greenguard_ai_usage` | model-gateway | budgets (sharded), reservations, `ai_usage_ledger`, outbox/inbox, entitlements projection |
| DB | `greenguard_knowledge` | knowledge-service | tenant `documents`/`chunks`, `public_documents`/`public_chunks`, outbox/inbox |
| DB | `greenguard_advisor` | grain-advisor | `threads`, `run_events`, checkpoint tables, `action_proposals` (includes approval and effect columns — no separate approvals/effects tables), `ai_interaction_content`, `thread_summaries`, outbox |
| DB | `greenguard_mlflow` | ml-platform | MLflow backend only; never raw tenant data |
| Topic | `greenguard.ml.prediction.v1` | ml-scoring | key `tenant_id:subject_id` with `subject_type ∈ {device, bin}` (tier A per device, tier B forecasts per bin); material change only |
| Topic | `greenguard.ml.scored_through.v1` | ml-scoring | key `cell:partition`; watermark every cycle |
| Topic | `greenguard.ml.drift.v1` | ml-scoring | key `model_name`; aggregate only, no per-tenant data |
| Topic | `greenguard.ai.usage.v1` | model-gateway | key `tenant_id`; consumed by billing-service |
| Topic | `greenguard.knowledge.document.v1` / `.chunks.v1` | knowledge-service | key `tenant_id:document_id`; IDs only |
| Topic | `greenguard.advisor.action.v1` | grain-advisor | key `tenant_id:proposal_id` |
| Topic | `greenguard.ai.interaction.completed.v1` | grain-advisor | key `tenant_id:turn_id`; IDs only |
| Topic | `greenguard.tenant.ai_consent.v1` | tenant-control-plane | key `tenant_id` |

Every new source DB needs **CDC onboarding** in the stage that creates it: Debezium connector, replication slot with WAL/slot-age alerts (review H3), audited CDC read exemption on its outbox only (review R1/H2), `contracts/events/` schemas, transformer raw-topic and routing entries (`services/cdc-transformer/event.go`), aggregate-ID checks (review H5).

## 4. Changes to existing services (each assigned to a stage)

| Change | Service | Stage | Exit test |
|---|---|---|---|
| Mount/position and lot-sample events; `site.changed.v2`, `bin.changed.v2` | device-service | I1 | contract tests + two-tenant test |
| `tenant.synthetic` flag; `tenant.ai_consent.v1`; platform tenant-deletion event | tenant-control-plane | I1 (synthetic), I2 (consent), I10 prereq (deletion) | event contract + revocation tests |
| Backfill endpoint (ADR-0025) | telemetry-ingest | I1 | receipt-per-reading + no-notify tests |
| Notification suppression for synthetic/backfilled | notification-service | I1 | no send for synthetic tenant |
| Python OTel helper `packages/otel-py` | packages | I1 | traceparent on outbox rows |
| Forecast read model, read-api endpoint, BFF predictions GraphQL | projection-builder, read-api, bff | I5 | two-tenant + freshness-watermark test |
| Alert verdict on acknowledge (if §8 Q10 = yes) | workflow-alerts | I5 | verdict persisted, tenant-scoped |
| Consume `ai.usage.v1` for metering | billing-service | I6 (after GG-09) | idempotent inbox test |
| BFF delegated-token issuer + internal delegation endpoint | bff, packages/tenant-auth | I8a | audience/expiry/tenant/`act`-chain tests; only mcp-gateway may delegate |
| SSE stream; `AdvisorRun` subscription | bff | I8a (read-only), I8b (proposal state) | reconnect/resume + two-user tests |
| CO₂ measurement contract (I1 G5) | telemetry-ingest, risk-engine | deferred (future stage) | risk-engine tolerates unknown measurement types first |
| Consume `advisor.action.v1` | notification-service | I8b | idempotent inbox test |
| Per-cell deployment manifest + reconciler | infra/gitops | I5 | alias drift reconciled to Git |

## 5. Stage table (dependencies corrected)

**Rule:** no I-stage other than I0 starts before the GG-04 and GG-05 exit gates (linked evidence and green remote CI, or an owner-signed waiver — ADR-0023 decision 2). Every stage below inherits GG-04/GG-05 in addition to the dependencies listed.

| Stage | Build | Depends on (must meet exit gates) |
|---|---|---|
| I0 | Charter recompute (R5), ADRs 0023–0024, catalog entries, owner approval of ADR-0023 | — |
| I1 | (also: ADR-0025 Accepted first; each new service added to Sonar sources and coverage script) Simulator, `packages/ml-features`, offline corpus + sequence export, parity sample, `otel-py`, backfill (ADR-0025), device/tenant contract changes | GG-04 (incl. bounded recovery relay), GG-05 |
| I2 | Classical ladder, backtests, MLflow; consent event | I1 |
| I3 | PyTorch labs, LSTM/TCN, autoencoder | I2 |
| I4 | Transformer from scratch, foundation-model baselines | I3 |
| I5 | `ml-scoring` online path, shadow table, cohort canary, watermark, drift, retraining, forecast read model, **minimum metrics + alert rules** (or manual promotion until I12) | I2, GG-06, GG-10b (flags) |
| I6 | `model-gateway`, local vLLM profile, budgets, caching, CPU guard/embedding models | GG-02b, **GG-04** (outbox/CDC onboarding for `greenguard_ai_usage`), GG-05; GG-09 entitlements (local budget config until then) |
| I7 | `knowledge-service`, parser sandbox, hybrid RAG, public corpus | I6, GG-05, GG-10a |
| I8a | `grain-advisor` read-only Q&A, delegated-token issuer, tenant checkpointer, content store, per-tenant DEK, SSE | I5, I7, GG-08 |
| I8b | Proposals, approvals, action execution | I8a + I10 subset (S-injection, S-approval-hash, S-tenant) |
| I8c | External MCP clients (OAuth, RFC 8693) | I10 complete, GG-09 |
| I9 | Eval platform, online evals, CI gates | I8a |
| I10 | Guardrails and AI security, gates S1–S16 | I8a, I9; tenant-deletion event |
| I11 | QLoRA fault-triage adapter | I6, I9 |
| I12 | Full AI/ML observability, SLOs, dashboards, alerts | I8a (instrumentation from I5/I6) |
| I13 | EKS deployment, load/chaos/DR certification | all I-stages, GG-12, GG-13, ADR-0024 |

**Current state (2026-09-29):** GG-04 and GG-05 are In progress, GG-06/08 are CI-pending, so under ADR-0023 no I-stage may start implementation yet. Only I0 (documents/ADRs) may proceed now; no other I-stage starts before its dependencies meet their exit gates (linked evidence **and** green remote CI, or an owner-signed waiver — ADR-0023 decision 2). Legend: `GG-nn` = core Stage nn in `docs/MILESTONES.md`; `10a`/`10b` per `docs/STAGE_10_PLAN.md`.

## 6. Review gaps touched

Closed or advanced: O1 (AI data key hierarchy, R23), R5 (per-tenant AI spend limits), R7/H1 (freshness watermark pattern reused). Tracked as I-stage gates: R3 (write amplification measured in I5), H3 (slot/WAL alerts per new DB), H5 (aggregate-ID check before ML keyed events), O2 (deletion event prerequisite of I10), O3 (residency is a blocking owner decision for cell placement). Also gates for I1: H6 (facility events — verify what `site.changed`/`bin.changed` v1 emit today before adding v2) and H4/ADR-0010 (Registry registration for every new topic's schema). Not addressed by this track: P1, P2.

## 7. Senior topics map

Classical ML, calibration, backtesting (I2) · tensors, autograd, training loops, LSTM/TCN, autoencoders (I3) · attention and transformers from scratch (I4) · feature stores, train/serve skew, shadow/canary, drift, retraining (I1, I5) · LLM serving, vLLM, KV cache, quantisation, routing, budgets, prompt caching (I6) · embeddings, hybrid search, reranking, retrieval evals (I7) · LangGraph, durable agents, MCP, human-in-the-loop, idempotent actions (I8) · eval methodology, LLM-as-judge calibration, statistics (I9) · threat modelling, prompt injection, capability security, red teaming (I10) · QLoRA/PEFT, decontamination, adapter serving (I11) · OTel GenAI, SLOs, AI dashboards (I12) · Kubernetes GPU ops, load/chaos/DR, cost (I13).

## 8. Owner decisions needed

1. **ADR-0023** — DECIDED 2026-09-29: accepted.
2. **Consent** — DECIDED 2026-09-29: opt-in, model in R24 (default `none`, org admin sets).
3. **Cloud** — DECIDED 2026-09-29: AWS, platform-wide (ADR-0024).
4. **Claude channel** — DECIDED 2026-09-29: first-party API primary, Bedrock optional. Still open: is zero data retention in place on the Anthropic org?
5. **Budgets** — DECIDED 2026-09-29 (R22): $1,000/month total; infra ≤ $600, product Claude ≤ $300, eval Claude ≤ $100. Interpretation to confirm: the $1,000 includes all Claude spend.
6. **Backfill** (R32): maximum age (proposal 400 days)?
7. **Weather source**: paid Open-Meteo, self-hosted, or ERA5?
8. **Labels / alert budget**: spoilage 0.5% dry-matter loss; hotspot +5 °C for 6 h; ≤ 0.5 false alarms per bin-week?
9. **Self-approval**: may a single-operator tenant approve its own proposals?
10. **Alert verdict** on acknowledge (needed for anomaly labels): yes/no?
11. **ML advisories during canary**: dashboard only, or notifications too?
12. **Pipelines**: Argo Workflows on EKS (recommended) or AWS Step Functions or SageMaker Pipelines?
13. **SLOs**: 99.5% copilot availability, validated-TTFT provisional p95 ≤ 5 s, groundedness ≥ 95%?
14. **Knowledge corpus**: approve public sources/licences; OCR for scanned PDFs?
15. **Safety reviewer** for agronomic advice policy (e.g. fumigants)?
16. **CI GPU**: none (GPU evals as scheduled EKS jobs) — acceptable?
17. **Data residency** (review O3): are tenants pinned to a region?
18. **Tier 1 event rate**: the R5 sensor model gives ~1,111 readings/s at Tier 1, versus 20k/50k events/s in `CAPACITY_MODEL.md`. Keep the capacity model's envelope as the platform target (AI sized from R5), or lower it?
19. **Billing records after deletion**: may `ai_usage_ledger` rows survive tenant deletion in pseudonymised form for billing/tax retention?
20. **Poisoning tolerance** (R24): maximum allowed shift in another tenant's metrics when one adversarial tenant is at the 10% cap (proposal: ≤ 1 pt PR-AUC, within CI)?

**Binding numbers from rev 2 section updates:** Tier 1 copilot load = **6.7 questions/s peak (~20 LLM calls/s)** from I00 (A-copilot); any other copilot rate in I06 or I12 is superseded. Tier 1 ML scoring = 1,111 device scores/s and 69 bin forecasts/s (UNMEASURED).
