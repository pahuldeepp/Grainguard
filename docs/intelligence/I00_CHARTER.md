# I0 Charter: architecture, service map, workload and cost model

Status: conformed to README rev 3 (2026-09-29; owner decisions applied), edited to conform to the binding [Intelligence README](README.md) §2–§6 (decisions R1–R32, name registry, changes table, stage table). All capacity, throughput and cost figures in this section are **UNMEASURED estimates**. Each one names the stage that must measure it. A figure with no evidence file under `evidence/` is a planning input. It is not a claim.

Read this section first. The I1–I13 sections build on the service boundaries, data owners, topic names, tenancy rules and budgets it sets. **The README is binding:** where this charter or another section file disagrees with README §2–§6, the README wins, and the section file is edited to match (R-numbers are cited inline below). Any other conflict is resolved by the owner through an ADR.

---

## 0. What "GreenGuard Intelligence" is, in one paragraph

GreenGuard already turns sensor readings into durable events, projections, deterministic risk scores and alerts. The Intelligence track adds three capabilities on top of that pipeline without replacing any of it:

1. **Learned prediction:** forecasts, anomaly detection and learned risk scores. These run first in shadow mode (table-only, R8) and then as a cohort canary beside the deterministic `risk-engine`.
2. **Grounded language:** a retrieval index over agronomy knowledge and tenant documents, plus a "Grain Advisor" agent. The agent answers questions from the read models and proposes actions. A human approves every action.
3. **The discipline that makes (1) and (2) trustworthy:** evals, guardrails, observability, cost caps, and measured capacity and recovery.

The deterministic risk engine stays the **authority** for alerts. ML is advisory only; it never suppresses or alters a threshold alert, and promotion to authority needs a new ADR that is out of this track's scope (R7).

---

## 1. End-to-end architecture

### 1.1 Diagram

Existing components are in plain boxes. New Intelligence components are marked `[AI]`. Arrows show data flow. `(ob)` means "written through the owner's transactional outbox, then Debezium, then the canonical transformer". This is the only way any new service publishes a domain event.

```
                       ┌──────────────────────────── existing GreenGuard cell ────────────────────────────┐
 devices ──HTTP──► gateway ─► telemetry-ingest ──(reading+outbox+receipt+audit, 1 tx)──► Postgres ingest
   ▲                                                         │ WAL
   │ (parity sample only, ~20 bin-seasons, R4)               ▼
   │                                             Debezium ─► raw topics ─► cdc-transformer
   │                                                                          │ canonical topics
[AI] sim-lab (I1) ──bulk: packages/ml-features ──► S3 Parquet (R4)     ┌─────┼──────────────────────────────┐
                                                                         ▼     ▼                              ▼
         greenguard.telemetry.recorded.v1   greenguard.inventory.device.v1 / .lot.v1 / .facility.v1   greenguard.alerts.lifecycle.v1
                                     │           │       │                    │                                   │
             ┌───────────────────────┘           │       └──► projection-builder / cassandra-writer / search-indexer (existing)
             ▼                                   ▼                                                                │
     risk-engine (existing,             [AI] ml-scoring (I5 online path; R2, R3, R9)                              │
     deterministic AUTHORITY, R7)         • packages/ml-features (same kernel online+offline)                     │
       │ (ob) greenguard.risk.assessment.v1 / .assessment_invalidated.v1  (lot join + verdict for comparison)     │
       ▼                                  • tier A per-device reading window; tier B per-bin 15-min forecast      │
     workflow-alerts                      • shadow → ml_shadow_predictions TABLE ONLY (never outbox, R8)          │
       (does NOT consume ml.prediction,   │ DB greenguard_ml (RLS) ──(ob)──► greenguard.ml.prediction.v1 (champion/canary,
        R8)                               │                                    material change only)             │
                                          │                          ──(ob)──► greenguard.ml.scored_through.v1 (watermark)
                                          │                          ──(ob)──► greenguard.ml.drift.v1             │
                                          ▲ champion/canary per cohort from Git manifest + Stage-10 flags (R10)  │
   ┌─────────────── offline / training plane (per environment, not per cell) ───────────────┐                    │
   │ [AI] ml-platform: MLflow tracking+registry (Postgres greenguard_mlflow, S3 artifacts)  │                    │
   │   Argo/K8s Jobs: offline corpus (simulator → feature kernel → Parquet; consented       │                    │
   │   pooled export per R24), training I2–I4, QLoRA I11 (L4 spot GPU pool), drift, evals I9 │                    │
   │   promotion = PR to per-cell deployment manifest in infra/gitops (Argo); MLflow aliases │                    │
   │   are a reconciled projection (R10). No model_deployment topic or table.               │                    │
   └──────────────────────────────────────────────────────────────────────────────────────────┘                   │
                                                                                                                  │
 browser ─► gateway ─► bff (GraphQL + SSE) ─► read-api  ◄──────────────────────── tools (read) ──┐                 │
                        │  issues ≤5-min delegated token (R14); AdvisorRun subscription, SSE (R18)│                │
                        ▼                                                                         │                │
                 [AI] grain-advisor (I8, LangGraph)  ──MCP──► [AI] mcp-gateway ──(delegated token, aud per API)──┘ │
                   DB greenguard_advisor (RLS):        │        read tools → read-api / bff GraphQL                │
                   threads, run_events, checkpoints,   │        action tools → PROPOSE only → approval (R15, R16)  │
                   action_proposals,                   │        approved action → owning service API ◄─────────────┘
                   ai_interaction_content (R23) ──(ob)──► greenguard.advisor.action.v1
                                                ──(ob)──► greenguard.ai.interaction.completed.v1 (IDs only, R25)
                        │ retrieve
                        ▼
                 [AI] knowledge-service (I7; API+retrieval, indexer worker, gVisor parser worker — R1, R13)
                   DB greenguard_knowledge (RLS for tenant docs; public_* non-tenant tables, R11)
                   ──(ob)──► greenguard.knowledge.document.v1 / .chunks.v1 (IDs only, R12) ──► indexer ──►
                             OpenSearch: tenant index per cell+embedding version (_routing=tenant_id)
                                         + separate single-shard public index (curator credential)
                        │ every LLM / embedding / rerank call that is not a CPU-local model
                        ▼
                 [AI] model-gateway (I6, I10 enforcement point, sole emitter of LLM spans, R28)
                   DB greenguard_ai_usage (RLS): sharded budgets, reservations, ai_usage_ledger ──(ob)──► greenguard.ai.usage.v1 ─► billing-service
                   consumes greenguard.billing.lifecycle.v1 entitlements (ADR-0018 pattern)
                   providers: Claude (first-party API or Bedrock, R19) │ vLLM on EKS L4 (generation, QLoRA adapters, evals — R21)
                              │ CPU: Prompt Guard 2 86M, small embedder, small reranker (R21) │ Ollama (local dev only)

 tenant-control-plane ──(ob)──► greenguard.tenant.ai_consent.v1 (R24) ─► ml-platform export, eval worker
 OTel (packages/otel, ADR-0004; packages/otel-py for Python, R28) spans every hop, GenAI semantic conventions for LLM calls (I12).
```

### 1.2 How the diagram obeys the existing invariants

| Invariant | How the Intelligence track keeps it |
| --- | --- |
| One write owner per aggregate and database | Each new database has exactly one owning service (§3, README §3 registry). Feature state has one owner, `ml-scoring` (R2). The advisor **never** writes another service's tables. Approved actions call the owning service's API with the approver's live delegated token (R14, R15). |
| Tenant tables: `tenant_id`, forced RLS, composite FKs, non-owner role, `set_config(...,true)` | This applies to every new tenant table, checked by a catalog-driven test with a reviewed non-tenant allowlist such as `public_*` (R27). MLflow's own schema is not tenant data. Tenant lineage lives in training manifests stored as tenant-scoped rows in `greenguard_ml` (§3). |
| Domain change and event commit together through the outbox | Champion/canary predictions, watermarks, drift events, usage records, knowledge document/chunk events, advisor actions and interaction-completed events all publish through outboxes. Shadow predictions are never written to an outbox (R8). No service calls the Kafka producer from a request path. |
| Idempotent consumers through an inbox; offsets commit after the effect | `ml-scoring`, the knowledge indexer, the eval worker and `model-gateway`'s entitlement projector all use inboxes. `ml-scoring` batches transactions per poll and commits offsets after the batch's effects (R9). Every new consumer has a Kafka-key / envelope / payload tenant-mismatch test (R12, R27). LLM calls are **not** idempotent, so the usage ledger records a reservation before the call and a settlement after it (§7, E-cases). |
| IDs created once | `prediction_id`, `thread_id`, `run_id`, `turn_id`, `proposal_id = uuidv5(run_id ‖ action_hash)` (R15), `llm_call_id` and `chunk_id` (recomputed from tenant by the indexer, R12) are minted once and persisted before any side effect. Retries reuse them. |
| Explicit lock choice | **Budgets:** money/quotas row of ADR-0002 — `FOR UPDATE NOWAIT` on a random budget shard, move to the next shard on conflict, deny only when all shards are busy or exhausted (R22). **Approvals:** optimistic concurrency — `If-Match: version`, 409 on mismatch, 409 `proposal_expired` after 15 min (R15, ADR-0002). **Model deployment:** no database pointer; Git is the authority (R10). |

### 1.3 Design decisions and rejected alternatives

| Decision | Reasoning | Rejected alternatives |
| --- | --- | --- |
| AI services consume **canonical** topics and never touch the ingest write path or its DB. The only ingest change is the separate authenticated backfill endpoint of ADR-0025 (R32), owned by telemetry-ingest (README §4) | Keeps the durable ingest path untouched. The AI layer can fail completely without losing a reading. | Scoring inline in `telemetry-ingest`. That couples ingest latency and availability to model inference and breaks the Tier 1 p95 budget. |
| **Two scoring tiers** (R9): tier A, a lightweight CPU fault/anomaly model per device reading window (inline micro-batch); tier B, forecasts per bin every 15 min on the bin feature grid (scheduled micro-batch). All predictions commit to `ml_predictions`; `ml.prediction.v1` is published only on material change; `ml.scored_through.v1` is published every cycle | Devices report every 15 min (R5), so tier A is one score per reading and batching amortises call overhead rather than skipping readings. Grain-bin physics changes over hours, so bin forecasts on a 15-min grid are enough. The watermark (ADR-0009 checkpoint pattern) gives every read-side freshness check one signal. | Per-event forecasting per device (16× the bin forecasts for no physical gain). Nightly batch only (too slow for hotspot detection). |
| Deterministic `risk-engine` stays the alert authority. ML runs shadow (table-only), then cohort canary; ML stays advisory (R7) | Safety and explainability. A regulator or customer can audit a threshold. | Replacing risk-engine with ML at I5 (unproven, and failure modes are opaque). Promotion to authority is out of scope and needs a new ADR. |
| **One** `model-gateway` for all remote LLM, embedding and rerank traffic | This is the single place for quota, cost caps, guardrails, provider failover, prompt caching and GenAI telemetry; it is the sole emitter of LLM spans/metrics and `ai.usage.v1` (R28). | Each service calls providers directly (caps become impossible). A LiteLLM proxy as the system of record: it cannot follow the tenant RLS, outbox or ADR-0018 projection invariants. Its provider-adapter design may still be borrowed. |
| Agent actions are **proposals** that a human approves and the **owning service** executes, inside the resumed graph with the approver's live delegated token (R15) | Keeps one write owner. The model never holds write credentials, which is the root mitigation for prompt injection. If the approver's token is unavailable, the proposal becomes `approved_pending_reauth`; there is no outbox retry of execution. | An agent with a service account that writes directly (breaks one-owner, and injection becomes a write). |
| Separate `mcp-gateway` service (TypeScript, official MCP TS SDK, reuses `packages/tenant-auth`, R1) rather than tools inside the advisor | The tool boundary is where untrusted model output meets real APIs. It needs its own authz, rate limits and audit, and it lets external MCP clients reuse the same governed tools (I8c, RFC 8693, R14). Tool policy comes from `ai/policy/tools.yaml`, enforced at both grain-advisor and mcp-gateway (R16). | Tools as in-process functions (no reusable boundary; the injection surface mixes with agent state). Tools inside the BFF (mixes a human-request path with a model-request path and their different threat models). |
| OpenSearch (Stage 10a) for the knowledge index: one shared tenant index per cell and embedding version with `_routing = tenant_id` and a mandatory server-side tenant filter inside the k-NN query, plus a separate single-shard public index (R11) | Hybrid BM25+kNN in one engine the platform already runs. The index is a **projection** of `greenguard_knowledge` and is rebuildable. | A separate vector DB such as pgvector, Pinecone or Qdrant (another stateful system to secure and scale). pgvector remains an acceptable dev and lab profile. A sentinel "public tenant" inside the tenant index (rejected by R11). |
| Training plane per **environment**, serving per **cell** | Training needs the pooled corpus (consented only, R24). Serving must stay inside the cell failure boundary (SCALE doc). | Training per cell (too little data per model; 100+ duplicate pipelines at Tier U). |
| AWS/EKS as the deployment target for Intelligence (R29) | Owner decision: AWS, platform-wide (ADR-0024, accepted 2026-09-29). L4 GPUs (`g6`) are available on EC2 and Claude is also offered on Amazon Bedrock. gVisor is **not managed on EKS**: the sandbox node group is self-installed (custom AMI plus `runsc` runtime class, see the risk in §2.4). Until I6/I13 ship, I6 uses a local/Compose vLLM profile. | A second cloud for AI (rejected: ADR-0024 keeps one cloud and reuses the Stage 10b/12 profile: MSK, S3, CDK). See §6.2 ADR-0024. |

---

## 2. New service map (minimal set)

Rule applied: a new deployable exists only if it has a different **write owner**, **scaling curve**, **failure domain** or **threat model** from everything that already exists. Everything else is a library, a job or configuration. There is no `feature-service`, `retrieval-api`, `advisor` or `mcp-server`; read those names in any section file as the services below (R1).

### 2.1 Runtime services (5, R1)

| Service | Lang | Single responsibility | Owned datastore (README §3) | Inputs | Outputs | Why separate |
| --- | --- | --- | --- | --- | --- | --- |
| `ml-scoring` (online path built in I5; R2) | Python 3.14 (same toolchain as risk-engine) | Sole owner of feature state. Computes point-in-time features with `packages/ml-features`, scores tier A per device reading window and tier B per bin every 15 min (R9), compares against risk-engine, writes shadow predictions table-only (R8), serves champion/canary per cohort from the Git manifest and Stage-10 flags (R10). | `greenguard_ml`: `ml_predictions`, `ml_shadow_predictions`, online window state (formerly `greenguard_features`), inbox/outbox, `training_manifests` (tenant lineage), per-tenant calibration rows | `greenguard.telemetry.recorded.v1`, `greenguard.inventory.device.v1`, `greenguard.inventory.lot.v1`, `greenguard.inventory.facility.v1`, `greenguard.risk.assessment.v1`, `greenguard.risk.assessment_invalidated.v1` (R3). Sensor values come from telemetry only; risk events supply the lot join and verdict for comparison | `greenguard.ml.prediction.v1` (material change), `greenguard.ml.scored_through.v1` (every cycle), `greenguard.ml.drift.v1` — all through the outbox | Its scaling curve is CPU per device window and per bin, not per request. Its failure must not stop risk-engine. It needs a different release cadence (models change weekly). |
| `model-gateway` (I6, I10, I12) | Go (streaming proxy, high concurrency, `go-common`/OTel reuse) | The only egress to remote LLM, embedding and rerank providers. Handles budget reservation, cost caps, routing and failover, tenant-keyed caches and prompt caching (R20), guardrail hooks and GenAI spans (sole emitter, R28). Stores **no** prompt/response content (R23). Rejects tenant-scoped `task_type` without a tenant-bound token (R14). | `greenguard_ai_usage`: sharded budgets, reservations, `ai_usage_ledger`, outbox/inbox, entitlements projection | Internal gRPC/HTTP from grain-advisor, knowledge-service, ml-platform eval jobs; `greenguard.billing.lifecycle.v1` | Provider calls; `greenguard.ai.usage.v1` (outbox) for billing-service | Different threat model (holds provider credentials). It is the single enforcement point for spend. |
| `knowledge-service` (I7) | Python; **three deployables from one codebase and DB** (R1): API with the retrieval module, indexer worker, sandboxed parser worker (fresh gVisor pod per document, zero network, R13; on EKS gVisor is self-installed on a dedicated node group, §2.4) | Write owner of knowledge documents: public curated corpus (non-tenant `public_*` tables, curator role) and tenant uploads. Chunks, embeds (under a platform budget, R12) and indexes them, and serves hybrid retrieval with rerank. | `greenguard_knowledge`: tenant `documents`/`chunks`, `public_documents`/`public_chunks`, outbox/inbox. OpenSearch tenant index and public index are **projections** | Upload API (through BFF), own `knowledge.document.v1` / `.chunks.v1` events consumed by its indexer worker | Retrieval API (top-k with citations); `greenguard.knowledge.document.v1`, `greenguard.knowledge.chunks.v1` (IDs, not chunk text, R12) | Document lifecycle, deletion, parser sandboxing and embedding-version migrations are a separate aggregate and threat model from telemetry search (`search-indexer`). |
| `grain-advisor` (I8) | Python (LangGraph) | Owns threads: the agent graph (single policy `ai/policy/tools.yaml`, R16), a custom tenant-scoped checkpointer, proposals and approvals, and the single content store (R23). | `greenguard_advisor`: `threads`, `run_events`, checkpoint tables (forced RLS, blobs wrapped with the per-tenant DEK), `action_proposals` (approval fields and execution result per R15), `ai_interaction_content`, `thread_summaries`, outbox | BFF GraphQL mutations, `AdvisorRun` subscription and SSE stream (R18), with the BFF-issued delegated token (R14) | Validated answer stream; `greenguard.advisor.action.v1`; `greenguard.ai.interaction.completed.v1` | Long-lived, stateful and bursty (LLM-latency-bound). Very different from request/response read-api. |
| `mcp-gateway` (I8, I10) | TypeScript (official MCP TS SDK, reuses `packages/tenant-auth`, R1) | MCP server exposing governed tools. Read tools call read-api/BFF with the **delegated token** for that audience (`greenguard-mcp`, `read-api`, `workflow-alerts`; R14). Action tools only create proposals; viewers get read tools only (R16). No raw bearer forwarding. | None (stateless). Audit goes to OTel and `packages/audit` | MCP calls from grain-advisor; external clients only in I8c (RFC 8693) | read-api/BFF calls; proposal create on grain-advisor | Tool boundary threat model; reusable by external MCP clients. |

### 2.2 Platform components, jobs and libraries (not new domain services)

| Component | Kind | Stage | Notes |
| --- | --- | --- | --- |
| `sim-lab` | CLI/Job (Python) | I1 | Physics simulator (heat and moisture diffusion in a bin, aeration, insect/mould respiration hotspots, sensor faults of exactly the classes I11 uses, R31). **Bulk data runs the shared feature kernel directly into Parquet**, never through ingest (R4). A **real-ingest parity sample** (~20 bin-seasons through telemetry-ingest → CDC → ml-scoring) must produce identical features; this is an I1/I5 gate. It runs only against `tenant.synthetic` tenants (R32, X27). |
| `packages/ml-features` | Library (Python) | I1 | One feature kernel used by the online scorer **and** offline corpus generation, which is the train/serve skew control (R2). Versioned `feature_set@MAJOR.MINOR`. |
| `packages/otel-py` | Library (Python) | I1 | ADR-0004 rules for Python services, `traceparent` on outbox rows; built before any Python AI service emits events (R28). |
| `ml-platform` | MLflow server plus Argo Workflows / K8s Jobs | I2–I5, I9, I11 | MLflow tracking and registry (backend `greenguard_mlflow`, never raw tenant data; artifacts in S3). Training, offline corpus, drift and eval jobs. The GPU node pool (L4, spot, scale to zero) is shared with vLLM batch jobs. |
| Per-cell deployment manifest + reconciler | `infra/gitops` (Argo) | I5 | The only authority for champion/canary per cohort; MLflow aliases reconciled to Git (R10, README §4). |
| `vllm` | Inference deployment (infra) | I6, I11 | GPU (L4, scale to zero) serves generation, fine-tune adapters and evals only (R21). Reached only through `model-gateway`; per-tenant `cache_salt` (R20). |
| CPU guard and retrieval models | Deployments on CPU (or a hosted equivalent) | I6, I7, I10 | Prompt Guard 2 86M, a small embedding model, a small reranker, and a small quantised output-safety classifier sized to fit (chosen and verified in I10; Llama Guard 4 12B does not fit an L4). Needed on every turn, so never waits on a cold GPU (R21). |
| `packages/ai-guardrails` | Library (Python + TS + Go shim) | I10 | Input and output policies. Enforced in model-gateway, mcp-gateway and grain-advisor (defence in depth). |
| `evals/` | Workspace plus CI jobs | I9 | Golden sets, LLM-judge rubrics, red-team suite. T0 recorded responses per PR ($0), T1 self-hosted in GPU windows, T2 Claude weekly via Message Batches ≤ $12/run (≈ $52/month) plus a $30 release-candidate reserve and $18 for online-eval judge calls and recalibration, all inside the $100/month eval cap (R22). Results go to MLflow and `evidence/`. |
| Ollama | Local dev only | I6 | Never deployed to shared environments. |

### 2.4 Sandbox runtime on EKS

gVisor (`runsc`) is **self-installed** on EKS: a dedicated tainted node group built from a custom AMI with a `gvisor` RuntimeClass, because AWS provides no managed gVisor (ADR-0024). Consumers are the knowledge-service parser worker (R13) and any tool that executes untrusted content. Consequences: the AMI, containerd config and upgrade cadence are maintained by us; sandbox pods get no AWS identity (no Pod Identity); the escape/egress suite re-runs per AMI (I10, I13); see edge case X35. The sandbox pool is tainted, Spot m7i.large, scales from 0 and has no GPU; its cost is its own line in §5.1, not part of the general/app pool.

**Rejected additions:** a `feature-service` (feature state belongs to `ml-scoring`, R1/R2); a separate feature-store product (Feast or SageMaker Feature Store), because Parquet on S3 plus the scorer's own window state is enough and measurable; Feast can be a lab later. A separate drift service (drift is a job plus a scorer metric). Langfuse or ClickHouse as a required component (I12 may add it as an optional lab; the required path is OTel GenAI semantic conventions plus the grain-advisor content store). A per-tenant model-serving deployment (infeasible at 10M orgs; see §7.1).

### 2.3 New canonical topics (README §3; all through outbox, Debezium and the canonical transformer)

| Topic | Key | Producer (owner) | Consumers |
| --- | --- | --- | --- |
| `greenguard.ml.prediction.v1` | `tenant_id:device_id` | ml-scoring (champion/canary only; material change only) | projection-builder (forecast read model, I5), comparator job. **Not** workflow-alerts (R8) |
| `greenguard.ml.scored_through.v1` | `cell:partition` | ml-scoring (watermark every cycle, R9) | projection-builder / read-api freshness, advisor staleness check, SLO, missing-prediction guardrail |
| `greenguard.ml.drift.v1` | `model_name` | ml-scoring (aggregate only, no per-tenant data) | ml-platform retrain trigger, alerting |
| `greenguard.ai.usage.v1` | `tenant_id` | model-gateway | billing-service (metering, I6 after GG-09), cost dashboards |
| `greenguard.knowledge.document.v1` / `greenguard.knowledge.chunks.v1` | `tenant_id:document_id` | knowledge-service (IDs only, R12) | knowledge indexer worker |
| `greenguard.advisor.action.v1` | `tenant_id:proposal_id` | grain-advisor | notification-service (I8b), audit export |
| `greenguard.ai.interaction.completed.v1` | `tenant_id:turn_id` | grain-advisor (IDs only, R25) | eval worker (one tenant per transaction, judge called with that tenant's token) |
| `greenguard.tenant.ai_consent.v1` | `tenant_id` | tenant-control-plane (I2 prerequisite, R24) | ml-platform export jobs, eval worker, consumers that project consent |

`greenguard.ml.model_deployment.v1` and the `model_deployments` table are **removed**; Git is the deployment authority (R10). `risk.assessed.v1` and `telemetry.canonical.v1` do not exist (R3).

Every new source DB needs **CDC onboarding** in the stage that creates it: Debezium connector, replication slot with WAL/slot-age alerts (review H3), audited CDC read exemption on its outbox only (review R1/H2), `contracts/events/` schemas, transformer raw-topic and routing entries (`services/cdc-transformer/event.go`) and aggregate-ID checks (review H5).

**Capacity conflict:** ADR-0008 gives one raw partition per source DB, processed serially (CAPACITY_MODEL: "only ONE can own the telemetry raw partition"). Each new DB gets its **own** raw topic, so AI traffic never shares the telemetry raw partition. With the R5/R9 workload (§4), `ml-scoring` commits about **1,181 prediction rows/s at Tier 1** (1,111 tier A + 69 tier B). The current transformer ceiling (about 200 events/s/worker at a 5 ms cycle) **cannot carry** all of them. **Decision (R9): publish predictions only on material change**, estimated 1–5% of rows (≈ 12–59 events/s at Tier 1, UNMEASURED), plus the per-partition watermark. Every prediction still commits to `ml_predictions` for audit and backtest. I5 must measure the publish ratio and write amplification (review R3). At Tier U (≈ 1.2k–5.9k events/s) the per-cell split and the Stage 04/13 transformer concurrency redesign are still required.

---

## 3. Data ownership and deletion inventory (R26)

Every store that can hold tenant data is listed with its owner, tenant model, retention and **deletion mechanism**. Tenant deletion is driven by the platform tenant-deletion event from tenant-control-plane (review O2; an I10 prerequisite, README §4). The deletion rule is: **crypto-shred the tenant DEK + hard delete + deletion-ledger replay after any restore** (R26). Test IT-05 (§7.3) is delete → restore → assert zero rows/hits in every store below. Retention values marked "set in Ix" are not yet decided and must be fixed by that stage's ADR.

### 3.1 Postgres (primary rows)

| Store | Owner | Tenant model | Retention | Deletion mechanism | Notes |
| --- | --- | --- | --- | --- | --- |
| `greenguard_ml`: online window state | ml-scoring (sole owner, R2) | Row per `(tenant_id, device_id, feature_set_version)`, forced RLS. Hot copy in process memory | Latest plus N windows | Hard delete by `tenant_id` in one RLS transaction; in-process copy evicted on the deletion event | Rebuildable from canonical topics and Cassandra history. Not authoritative business state. |
| `greenguard_ml`: `ml_predictions` (time-partitioned) | ml-scoring | tenant-scoped, forced RLS | 400 days, tiered: full resolution 30 days, then material changes plus daily samples (I1/I5 ADR) | Hard delete by `tenant_id` across all partitions | Needed for backtests, calibration and dispute; tenants read prediction logs here, never from Parquet (R6). |
| `greenguard_ml`: `ml_shadow_predictions` | ml-scoring | tenant-scoped, forced RLS; table-only, never in the outbox (R8) | Set in I5 (shadow evaluation window) | Hard delete by `tenant_id` | — |
| `greenguard_ml`: `training_manifests` + tenant child rows, per-tenant calibration | ml-scoring (written by ml-platform jobs through its API) | Tenant child rows carry the per-dataset HMAC pseudonym and consent version | Life of the model versions they describe | Tenant child rows and calibration rows hard deleted; affected model versions marked `retrain_required` (X2) | The manifest is what lets deletion find every affected model version. |
| `greenguard_ml` inbox/outbox | ml-scoring | tenant-scoped | Short (drained) | Hard delete by `tenant_id` | — |
| `greenguard_ai_usage`: sharded budgets, reservations, `ai_usage_ledger`, entitlements projection, inbox/outbox | model-gateway | tenant-scoped, forced RLS | Ledger 25 months (billing disputes); others short | Hard delete by `tenant_id`; ledger rows hold no prompt/response content (R23) | Whether billing law requires keeping ledger rows after deletion is an owner question (not settled by the README). |
| `greenguard_knowledge`: tenant `documents`, `chunks`, inbox/outbox | knowledge-service | tenant-scoped, forced RLS | Life of the document | Hard delete by `tenant_id`; document/chunk delete events drive index deletion | `public_documents` / `public_chunks` are non-tenant (curator role, no RLS exception, R11) and are not deleted with a tenant. |
| `greenguard_advisor`: `threads`, `run_events`, `thread_summaries`, `action_proposals`, outbox | grain-advisor | tenant plus `user_id`; author-owned, tenant admins may read (R17) | Threads 30 days default (R23); proposals per audit policy | Hard delete by `tenant_id` | — |
| `greenguard_advisor`: checkpoint tables | grain-advisor (custom tenant-scoped checkpointer, R23) | `tenant_id`, forced RLS; blobs wrapped with the per-tenant DEK | 30 days | Crypto-shred DEK + hard delete | Never loaded across tenants or users (X23). |
| `greenguard_advisor.ai_interaction_content` (the **one** content store, R23) | grain-advisor | tenant plus `user_id`; per-tenant DEK envelope encryption (AWS KMS KEK per env, built in I8a) | 30 days default | Crypto-shred DEK + hard delete | Raw prompts, retrieved tenant data and answers live only here, **not** in model-gateway, traces or eval stores. Eval replay reads through grain-advisor's API with a tenant-bound token. |
| `greenguard_mlflow` | ml-platform | **Not** tenant data (MLflow backend only, never raw tenant data) | Every served version plus 2 prior | Nothing tenant-keyed to delete; run metadata references manifests only | — |
| **PITR / WAL archives and base backups** of every database above | Platform backup owner (per DB) | Contain the rows above as of backup time | PITR window (set in Stage 14 / I13) | Cannot be edited in place: encrypted content is unreadable after crypto-shred; plaintext rows age out with the PITR window; **after any restore, the deletion ledger is replayed** before the restored DB serves traffic | IT-05 restores a pre-deletion backup and asserts zero rows after replay. |

### 3.2 Search, object storage, streams, caches and models

| Store | Owner | Tenant model | Retention | Deletion mechanism | Notes |
| --- | --- | --- | --- | --- | --- |
| OpenSearch tenant knowledge index (one per cell and embedding version, R11) | knowledge-service (projection) | `_routing = tenant_id`, mandatory server-side tenant filter inside the k-NN query | Life of the source document; old index versions kept 7 days after alias switch (X25) | `delete_by_query` on `tenant_id` with routing, in every live index version; proof by count query = 0 | Rebuildable from `greenguard_knowledge`. |
| OpenSearch public index (single shard) | knowledge-service (curator credential) | Non-tenant | Curated | Not deleted with a tenant | Public hits are accepted only from this index (R11). |
| **OpenSearch snapshots** | Platform backup owner | Contain tenant documents as of snapshot time | Snapshot retention (set in I7/I13) | Age out with snapshot retention; after any snapshot restore, deletion-ledger replay (`delete_by_query`) before serving | — |
| S3 offline corpus: per-bin feature rows and `sequence_windows` Parquet (R6) | ml-platform (export jobs are the only writers) | Keys pseudonymised with a per-dataset HMAC, never dropped; files partitioned by tenant pseudonym | 13 months (seasonal cycle), then lifecycle delete; **retention lock is not applied to tenant data** (R6) | Delete the tenant-pseudonym partition(s) | Parquet is never served to tenants. Until ≥ 50 tenants consent to `pooled`, the corpus is simulator data only (R24). |
| S3 labels, eval datasets derived from tenants | ml-platform / evals | Pseudonymised; eval reuse only when `eval_review = true` (R25) | As features | Delete tenant-pseudonym partitions / items | — |
| **S3 soft delete** on the buckets above | Platform | Deleted objects remain restorable during the soft-delete window | Bucket soft-delete window (S3 default 7 days; set in I1) | Objects are unrecoverable after the window; deletion proof is dated after it ends; any restore from soft delete triggers deletion-ledger replay | — |
| MLflow artifacts (S3) | ml-platform | Model weights and run artifacts; no raw tenant rows | Every served version plus 2 prior | Model versions trained with the tenant are marked `retrain_required` and superseded by the next retrain (≤ 30 days, X2); artifacts of superseded versions deleted on the normal schedule. No machine-unlearning claim | — |
| Kafka topics with tenant keys: `ml.prediction.v1`, `knowledge.document.v1`, `knowledge.chunks.v1`, `advisor.action.v1`, `ai.usage.v1`, `ai.interaction.completed.v1`, raw CDC topics of the new DBs | Topic owner per README §3 | Key contains `tenant_id`; knowledge and interaction topics carry IDs only (R12, R25) | Time-based topic retention (set per topic in the owning I-stage) | Records cannot be deleted per key: they **age out with topic retention**; consumers check the deletion ledger so a replay cannot re-create deleted rows; deletion proof is dated after the longest retention | — |
| Kafka compacted `tenant.ai_consent.v1` | tenant-control-plane | Key `tenant_id` | Compacted | Tombstone for the tenant key | — |
| Redis (tenant-keyed embedding and response caches, rate limits) | model-gateway / knowledge-service | Every key includes `tenant_id` (R20) | Short TTL | Delete by tenant key prefix on the deletion event; TTL bounds any miss | No final-answer or semantic answer cache exists (R20). |
| Provider-side and vLLM prompt caches | model-gateway | Tenant segments start with a per-tenant secret nonce; vLLM per-tenant `cache_salt` (R20) | Provider cache TTL (minutes); vLLM in memory | Expire on TTL; rotating the tenant nonce/salt makes any remaining entry unreachable | Zero data retention with the provider is an owner question (README §8 Q4). |
| OTel traces, metrics, logs | Platform (I12) | No prompt/response text or tenant IDs in labels or attributes; content hashes are HMAC with a per-tenant key (R20, R28) | Trace backend retention | Destroying the tenant's HMAC key makes remaining hashes unlinkable; no tenant rows to delete | — |

---

## 4. Workload model

### 4.1 Rules

* Human traffic and device traffic are independent. Never derive one from the other (SCALE doc).
* **Tier 1** is the certifiable target: 100k registered, 10k concurrent, 10k orgs, 1M devices, 20k/50k events/s. It is certified by I13, which depends on Stage 13.
* **Tier U** is 10M registered, 10M orgs and 10M concurrent. It is a forecast. Only Stages 12–14 cell and fleet evidence can certify it.
* **Inconsistency in the base model:** Tier U puts registered and concurrent users both at 10M, which implies 100% of accounts are online at once. That works as a stress envelope for connections but not as a daily-usage model. For daily **cost**, this charter uses DAU = 30% of registered (assumption A2). For **peak rate**, it uses the stated concurrent figure. The owner must confirm (open question Q1).
* **Sensor model is fixed by R5:** one cable node = one device; 4 cables × 4 depths = 16 devices per reference bin; one reading per device every 15 min; feature/forecast grid 15 min per bin; I4 patch = 8 steps (2 h). All rates, capacity and cost rows below are recomputed from this.
* **Inconsistency with the Tier 1 event envelope:** at R5 cadence, 1M devices produce 1M / 900 s ≈ **1,111 readings/s**, far below the Tier 1 envelope of 20k/50k events/s (which implies one event per device every 50 s). AI rates use R5; the platform envelope is not changed by this charter. The owner must say whether the envelope is headroom or a different device mix (open question Q8).

### 4.2 Assumptions (every row UNMEASURED)

| # | Assumption | Value | Measured by |
| --- | --- | --- | --- |
| A1 | Devices per bin | **16** (4 cables × 4 depths; one cable node = one device, R5) | I1 simulator config; Stage 13 fixture census |
| A2 | DAU / registered | 30% | I12 product analytics |
| A3 | Advisor questions per DAU per day | 3 | I12 |
| A4 | Advisor questions (turns) per concurrent user per hour (peak) | **2.4** (2% of concurrent users active in the copilot × 1 turn per 30 s; reconciled with I12/I13 load profile) | I8 load test, I13 |
| A5 | LLM calls per question (router + plan + answer; tool calls are not LLM calls) | 3 (p95 6) | I8 traces, I12 |
| A6 | Input tokens per question (sum over calls) | 12k, of which 8k is a cacheable prefix | I6 usage ledger |
| A7 | Output tokens per question | 1.2k | I6 |
| A8 | Model mix after routing | 60% Haiku 4.5, 35% Sonnet 5.5, 5% Opus 5.5 | I6 routing eval (I9) |
| A9 | Reading cadence / scoring / forecast grid | **15 min per device reading; tier A scored per device reading window; tier B forecast every 15 min per bin; I4 patch 8 steps (2 h)** (R5, R9) | I3/I5 backtest (accuracy against cost curve) |
| A10 | Anomaly triage rate needing the LLM (QLoRA) | 0.1% of tier A windows, deduplicated to 1 per device incident | I3/I11 |
| A11 | Per-bin feature vector size | 64 float32 plus keys ≈ 400 B | I1 |
| A12 | Knowledge chunks | 100k public; 50 per org average | I7 |
| A13 | Interaction content per question with tool trace | 20 KB | I8 |
| A14 | `sequence_windows` row (one node reading at native cadence, R6) | ≈ 64 B | I1 |

**Tier 1 copilot rate (one number): 6.7 questions (turns)/s at peak** = 10,000 concurrent × A4 2.4/h ÷ 3,600. With A5 that is **20 LLM calls/s**. Daily volume for cost stays 90,000 questions/day (A2 × A3; average 1.04/s, so peak/average ≈ 6.4). Section files that state other Tier 1 copilot rates (I12/I13 "~7 turns/s steady, 20 turns/s peak"; I06 "50 req/s per cell") are read as: 20 turns/s = a 3× burst test of this rate, 50 req/s = LLM-call headroom for cell certification, not the design rate. They are edited to cite this number when those stages start.

### 4.3 Derived rates

| Quantity | Formula | Tier 1 | Tier U | Measured by |
| --- | --- | ---: | ---: | --- |
| Registered users | given | 100,000 | 10,000,000 | — |
| DAU | A2 × registered | 30,000 | 3,000,000 | I12 |
| Peak concurrent users | given | 10,000 | 10,000,000 | I13 / Stage 13 |
| Sensor events/s normal / peak (platform envelope) | given | 20k / 50k | 1.67M / 8.33M | Stage 13 |
| Devices | given | 1,000,000 | 100,000,000 | Stage 13 |
| Bins | devices / A1 | 62,500 | 6,250,000 | I1 / Stage 13 |
| Device readings/s at R5 cadence | devices / 900 | 1,111 | 111,111 | I1 parity sample, Stage 13 |
| **Tier A scores/s** (one per device reading window) | devices / 900 | 1,111 | 111,111 | I5 |
| **Tier B forecasts/s** (per bin, every 15 min) | bins / 900 | 69 | 6,944 | I5 |
| Prediction rows committed/s (A + B) | sum | 1,181 | 118,056 | I5 |
| Score reduction vs per-event scoring | — | 1× for tier A (every reading is scored; micro-batching reduces call overhead, not rows); tier B is 1/16 of per-device forecasting | same | I5 |
| `greenguard.ml.prediction.v1` published (1–5% material change) | rows × 0.01–0.05 | 12–59/s | 1.2k–5.9k/s | I5 |
| `greenguard.ml.scored_through.v1` | 1 per partition per cycle | ≤ partitions / 15 min | same per cell | I5 |
| QLoRA triage requests/s | tier A × 0.1% | ~1.1/s | ~111/s | I11 |
| Advisor questions/day | DAU × A3 | 90,000 | 9,000,000 | I12 |
| **Advisor questions/s at peak** | concurrent × A4 / 3600 | **6.7** | 6,667 | I8 / I13 |
| LLM calls/s at peak | × A5 | 20 | 20,000 | I6 |
| Peak LLM input tokens/min | q/s × 12k × 60 | 4.8M | 4.8B | I6 |
| Peak LLM output tokens/min | q/s × 1.2k × 60 | 480k | 480M | I6 |
| Concurrent streaming advisor sessions (15 s average generation) | q/s × 15 | ~100 | ~100k | I8 |
| Embedding calls (queries) | = questions | 6.7/s | 6,667/s | I7 |
| Rerank pairs/s (top-20; top-50 in brackets) | q/s × 20 | ~133 (333) | ~133k (333k) | I7 |

**CPU/GPU throughput (UNMEASURED; I5, I6 and I13 must replace these):**

| Workload | Assumed unit cost | Tier 1 | Tier U |
| --- | --- | --- | --- |
| Tier A fault/anomaly model, gradient boosting (ONNX, batched) | ~50 µs/row/core | < 1 core | ~6 cores (+70% headroom → ~10) |
| Tier B LSTM/TCN forecaster (seq 96 = 24 h on the 15-min grid, hidden 64, CPU batch) | ~0.2 ms/sample | < 1 core | ~1.4 cores; a GPU is optional |
| Autoencoder anomaly (tier A) | ~0.1 ms/window | < 1 core | ~11 cores |
| Transformer forecaster (I4, small, patch 8 steps) | ~1 ms/sample CPU; ~0.05 ms GPU | < 1 core | ~7 cores or < 1 L4 |
| QLoRA triage (8B, 4-bit, vLLM on L4) | ~1,000 output tok/s per L4 aggregate (batched) | 300 tok × 1.1/s ≈ 330 tok/s → share of 1 L4 | 33k tok/s → ~33 L4. Cascade first: rules → AE score → dedupe per incident → LLM. Target ≤ 10 L4 |
| Embeddings (small 384-dim model, CPU per R21) | ~200 queries/s per core | < 1 core | ~35 cores for queries; ingestion is batch under a platform budget (R12) |
| Cross-encoder rerank (small model, CPU per R21) | ~200 pairs/s per core | ~1 core (top-20) | ~670 cores at top-20. **Keep top-k at 20**; cache per `(tenant_id, query_hash, index_version)` (R20) |

### 4.4 Storage growth (UNMEASURED; before compression and replication)

| Store | Formula | Tier 1/day | Tier U/day | Measured by |
| --- | --- | ---: | ---: | --- |
| Offline per-bin features (15-min grid) | bins × 96 × 400 B | 2.4 GB | 240 GB | I1 (Parquet compression often 3–8×, which I1 must measure) |
| `sequence_windows` (per node, native cadence) | devices × 96 × 64 B | 6.1 GB | 614 GB | I1 |
| Online feature state (latest) | devices × 400 B | 0.4 GB total | 40 GB total (0.4 GB/cell) | I5 |
| `ml_predictions` | rows/s × 86,400 × 200 B | 20.4 GB | 2.04 TB | I5 (400-day retention untiered ≈ 816 TB at Tier U; **must** keep only material changes plus daily samples beyond 30 days) |
| `ml_shadow_predictions` | as `ml_predictions` × shadow models | 20.4 GB per shadow model | 2.04 TB per shadow model | I5 (short retention) |
| Interaction content (R23) | questions × 20 KB | 1.8 GB (≈ 54 GB at 30-day retention) | 180 GB | I8 |
| Usage ledger | LLM calls × 300 B | 0.08 GB | 8 GB | I6 |
| Knowledge vectors (384-dim, int8 plus HNSW ≈ 2× raw) | chunks × 384 B × 2 | 0.4 GB total | 385 GB total (10M orgs × 50 chunks) | I7 |
| GenAI traces (sampled 10%, bodies excluded) | calls × 2 KB × 0.1 | 0.05 GB | 5 GB | I12 |

Offline corpus rows are an upper bound (every device in the corpus); until the R24 consent floor is met, the corpus is simulator data only.

**Finding:** at Tier U, prediction retention dominates AI storage, followed by the `sequence_windows` export. Both need a tiered policy: full resolution for 30 days, then material-change events plus daily aggregates. I1 and I5 own that ADR.

---

## 5. Cost model

Prices are AWS list prices for us-east-1, re-verified on 2026-09-29 from two kinds of source, recorded per line in `cost_model.json` (`price_source`, `source_kind`, `verified`, `date`): (1) AWS's own pricing pages (`aws.amazon.com/.../pricing`, fetched as text; EKS from the AWS containers blog) for EKS, EBS, S3, NAT, ALB, KMS, CloudWatch, Secrets Manager, SSM, VPC endpoints and the data-transfer allowance; (2) the Vantage instances page (`instances.vantage.sh`, page stamped 2026-09-29) for EC2 On-Demand and Spot, because AWS's EC2 page does not render prices as text. Neither is the AWS Price List API; re-verify in the AWS Pricing Calculator at I13. The aggregator does not say whether its Spot figure is a minimum, an average or a current value, and Spot moves by the hour, so Spot lines are "verified as displayed, volatile". us-west-2 was spot-checked for r7g.xlarge only (same On-Demand $0.214, same Spot $0.082 as displayed). **Still UNVERIFIED (from memory or estimated): EBS snapshot $0.05/GB-month, ECR storage $0.10/GB-month, the $1 miscellaneous lump sum, the $0.09/GB internet-egress tier (used at 0 GB), interface VPC endpoint hourly rate ($0.01/h/AZ; only the $0.01/GB data rate was read), Savings Plan rates, and Claude on Amazon Bedrock** (priced separately by AWS; I6 must confirm prices, model IDs and feature parity before enabling it as the second channel, ADR-0024, README §8 Q4). Claude prices are Anthropic first-party rates. Model aliases: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5`, with Bedrock IDs mapped per provider and the served snapshot logged (R19).

| Item | Reference price (us-east-1, 2026-09-29) | Status |
| --- | --- | --- |
| Claude Opus 5.5 | $4 in / $20 out per MTok; cache read $0.40 (0.1x input; the earlier $0.20 was a typo and did not reproduce the old $0.0432 figure) | first-party rate as previously recorded |
| Claude Sonnet 5.5 | $2 / $10; cache read $0.20 | as above |
| Claude Haiku 4.5 | $1 / $5; cache read $0.10; **minimum cacheable prefix 4,096 tokens: a shorter prefix is billed uncached** | as above; the 4,096 floor is a stated planning input |
| Cache floor for Sonnet 5.5 / Opus 5.5 | not confirmed here; priced conservatively as the same 4,096 floor | UNVERIFIED (I6 checks) |
| Message Batches | 50% of standard (evals and offline labelling only) | as above |
| EKS control plane | $0.10/h per cluster (~$73/month), no free credit; Extended Support $0.60/h if a cluster is left on an out-of-support Kubernetes version ([AWS blog](https://aws.amazon.com/blogs/containers/amazon-eks-extended-support-for-kubernetes-versions-pricing/)) | verified |
| t4g.large (arm64, 2 vCPU, 8 GiB) | On-Demand $0.067/h; Spot $0.027/h ([Vantage](https://instances.vantage.sh/aws/ec2/t4g.large?region=us-east-1)); t3.large is $0.0832/h (verified) | verified |
| r7g.xlarge (arm64, 4 vCPU, 32 GiB) | On-Demand $0.2142/h; Spot $0.082/h; 1-yr Reserved $0.142/h ([Vantage](https://instances.vantage.sh/aws/ec2/r7g.xlarge?region=us-east-1)); r7i.xlarge (x86) On-Demand $0.265/h, Spot $0.111/h | verified |
| m7g.xlarge (arm64, 4 vCPU, 16 GiB) | On-Demand $0.163/h; Spot $0.095/h ([Vantage](https://instances.vantage.sh/aws/ec2/m7g.xlarge?region=us-east-1)); m7g.large On-Demand $0.082/h, Spot $0.052/h | verified |
| m7i.xlarge (x86, 4 vCPU, 16 GiB) | On-Demand $0.2016/h; Spot $0.092/h ([Vantage](https://instances.vantage.sh/aws/ec2/m7i.xlarge?region=us-east-1)); m7i.large On-Demand $0.101/h, Spot $0.046/h; m7i.2xlarge On-Demand $0.4032/h, Spot about $0.159/h (earlier check) | verified (the earlier "derived, UNVERIFIED" m7i.xlarge Spot $0.08 was low by $0.012/h) |
| g6.xlarge (1x NVIDIA L4, 4 vCPU, 16 GiB) | On-Demand $0.805/h; Spot $0.605/h; 1-yr Reserved $0.524/h ([Vantage](https://instances.vantage.sh/aws/ec2/g6.xlarge?region=us-east-1)). Spot is only ~25% below On-Demand and capacity is not guaranteed | verified |
| EBS gp3 | $0.08/GB-month, 3,000 IOPS and 125 MB/s included; gp2 $0.10; io2 $0.125 plus $0.065/IOPS-month ([AWS](https://aws.amazon.com/ebs/pricing/)) | verified |
| NAT gateway | $0.045/h plus $0.045/GB processed; public IPv4 $0.005/h ([AWS VPC pricing](https://aws.amazon.com/vpc/pricing/); the page labelled the NAT figure US East Ohio, same list price in us-east-1); S3 gateway endpoint free | verified |
| Interface VPC endpoint | $0.01/GB first 1 PB ([AWS PrivateLink](https://aws.amazon.com/privatelink/pricing/)); $0.01/h per AZ from memory | rate per GB verified, hourly UNVERIFIED |
| Application Load Balancer | $0.0225/h plus $0.008 per LCU-hour ([AWS](https://aws.amazon.com/elasticloadbalancing/pricing/)); public IPv4 $0.005/h per address | verified |
| KMS | $1/key-month, $0.03 per 10,000 requests, 20,000 free ([AWS](https://aws.amazon.com/kms/pricing/)) | verified |
| Secrets Manager / SSM Parameter Store | $0.40/secret-month and $0.05 per 10,000 calls ([AWS](https://aws.amazon.com/secrets-manager/pricing/)); SSM standard parameters free ([AWS](https://aws.amazon.com/systems-manager/pricing/)) | verified |
| CloudWatch | Logs ingest $0.50/GB after the first 5 GB, storage $0.03/GB-month, custom metrics $0.30, alarms $0.10 ([AWS](https://aws.amazon.com/cloudwatch/pricing/)) | verified |
| S3 | Standard $0.023/GB-month (first 50 TB), PUT $0.005 and GET $0.0004 per 1,000 ([AWS](https://aws.amazon.com/s3/pricing/)). Intelligent-Tiering tiers as recorded earlier ($0.0125 infrequent, $0.004 archive instant) | verified |
| AWS WAF | Web ACL $5, $1/rule, $0.60/million requests ([AWS](https://aws.amazon.com/waf/pricing/)) | verified; not in the demo plan |
| Data transfer | 100 GB/month free outbound across services ([AWS EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/)); same-Region ECR pulls free | allowance verified, egress tier UNVERIFIED |
| ECR storage, EBS snapshots | $0.10 and $0.05 per GB-month | UNVERIFIED |
| Other services used elsewhere in this charter | RDS db.t4g.large $0.129/h Single-AZ; ElastiCache cache.t4g.small $0.032/h; OpenSearch t3.medium.search $0.073/h; MSK kafka.t3.small $0.0456/h, kafka.m5.large $0.21/h, storage $0.10/GB-month (used only in §5.2 and the removed Higher illustration) | as recorded on 2026-09-29 from aggregators, not re-checked |

### 5.1 Demo environment: Lean plan of record, all UNMEASURED

**Owner caps (2026-09-29, R22): $1,000/month total = infrastructure <= $600 + product Claude <= $300 + eval Claude <= $100.** Infrastructure and Claude are separate budgets and are added separately below. The Lean plan is the plan of record; the earlier "Higher" managed-services illustration ($1,032 infrastructure, exceeding the cap) is deleted because it used unverified prices and is not a target. Managed-service prices remain in the reference table for §5.2 only.

**Result: infrastructure $492.92 (target <= $500, cap $600), grand total at caps $892.92, headroom $107.08 (target >= $100).** The earlier plan was $582 / $982 / $18. The lines below are also in `docs/intelligence/cost_model.json`, and `make intelligence-cost-check` recomputes them.

**Lean topology (I13 aligns to this):**

* **One small On-Demand managed `system` node group** (1 x t4g.large, arm64). It runs only cluster add-ons (Karpenter controller, CoreDNS, EBS CSI controller, Argo CD, Kyverno, cert-manager, metrics-server, KEDA, OTel collector). It exists so the Karpenter controller never runs on nodes Karpenter provisions. t4g is burstable: alarm on CPU-credit balance; if it is sustained above the baseline, move to m7g.large On-Demand ($0.082/h, +$11/month).
* **One On-Demand `data` node** (1 x r7g.xlarge, arm64, 4 vCPU, 32 GiB, tainted `workload=stateful`, 24x7) for Postgres (with PgBouncer), Kafka, Cassandra, OpenSearch and Redis. **These stores never run on Spot and are never scheduled off** (see rejected savings).
* **Spot general/app nodes via Karpenter** (2 x m7g/m7i.xlarge, NodePool `limits.cpu: 8`, `capacity-type: spot` only, both architectures allowed so Spot has more pools to draw from; no On-Demand fallback in Lean). **Scheduled scale-down:** the app-pool Deployments are scaled to 0 outside demo hours by KEDA `cron` scalers (or kube-downscaler); Karpenter then removes the empty nodes (`consolidateAfter: 10m`). **Assumed demo hours (owner to confirm): 10 h/day, Monday to Friday = 217 h/month per node.** Persistent volumes (RabbitMQ, Prometheus, Loki, MLflow) stay attached and bill 24x7.
* **Sandbox pool**: tainted, custom gVisor AMI (ADR-0024, §2.4), scales from 0, m7i.xlarge **On-Demand** (matches I12 §2.2; a Spot reclaim mid-execution would corrupt an eval), ~30 h/month including boot and consolidation. x86 for the demo.
* **GPU pool**: g6.xlarge Spot, scales to zero, Karpenter `nvidia.com/gpu: 1` limit, **80 GPU-hours/month** (I12 §2.2 budget and alarm). This replaces the 40 h assumed before. **The GPU stays x86** (vLLM CUDA image, L4 host).

**Platform components that run in the demo:** Postgres, Kafka (KRaft, RF1), Cassandra (1 node), OpenSearch (1 node), Redis, Debezium/Kafka Connect, Schema Registry and RabbitMQ (the last three on the Spot app pool). Stage 10 optional profiles are not run.

**Architecture check for Graviton (arm64) on system, data and app nodes.** Images in `infra/kafka/compose.yaml` and `infra/compose/compose.yaml`, checked with `docker buildx imagetools inspect` on 2026-09-29, all publish linux/arm64: postgres:16-alpine, apache/kafka, cassandra, opensearchproject/opensearch:3.8.0, redis:7.4-alpine, rabbitmq:4.2-alpine, confluentinc/cp-schema-registry, quay.io/debezium/connect, node, golang, python, nginx-unprivileged, dex, mosquitto. Not verified: the locally built `grainguard/*` service images (Dockerfiles use the multi-arch bases above, but CI builds amd64 only today), the locally built `debezium-connect-avro`, and the Intelligence services and CPU model images (PyTorch/ONNX CPU wheels exist for arm64; I1-I8 must confirm). **Required before adopting arm64: multi-arch (amd64+arm64) image builds in CI (Stage 12) and an arm64 smoke run.** Until then the NodePools allow both architectures and the system/data node choice falls back to t3.large ($0.0832/h) and r7i.xlarge ($0.265/h), which costs +$11.8 and +$37.1 per month, infrastructure ~$542, still inside the cap.

**Sizing check (requests; UNMEASURED, replaced by I13 measurements).** Memory and vCPU match the earlier x86 sizes (r7g.xlarge and r7i.xlarge are both 4 vCPU / 32 GiB; t4g.large and t3.large both 2 vCPU / 8 GiB; m7g.xlarge and m7i.xlarge both 4 vCPU / 16 GiB), so the requests carry over unchanged:

| Node | Pods (GiB / vCPU requests) | Memory requested | vCPU requested | Allocatable (approx.) | Utilisation |
| --- | --- | --- | --- | --- | --- |
| Data, r7g.xlarge | Postgres+PgBouncer 4.25 / 0.75; Kafka 4.0 / 0.75; Cassandra 6.0 / 0.75; OpenSearch 6.0 / 0.75; Redis 1.0 / 0.1; DaemonSets ~0.3 vCPU | 21.25 | 3.1 + 0.3 = 3.4 | 29.5 GiB / 3.9 vCPU | 72% memory, 87% vCPU (CPU binds first) |
| Spot app, 2 x xlarge | ~20 existing services 4.0 / 1.5; Connect 1.5 / 0.5; Schema Registry 0.75 / 0.25; RabbitMQ 1.0 / 0.25; 5 Intelligence services 3.0 / 1.0; CPU guard+embed+rerank models 3.0 / 1.25; MLflow 1.0 / 0.25; Prometheus+Grafana+Loki 3.0 / 0.75; Argo Workflows/Rollouts 1.0 / 0.25; DaemonSets 2 x 0.3 vCPU | 18.25 | 6.0 + 0.6 = 6.6 | 59 GiB / 7.6 vCPU | 31% memory, 87% vCPU |
| System, t4g.large | Karpenter 0.5, Argo CD 1.0, Kyverno 0.5, others ~1.5 | ~3.5 | ~1.2 | ~7 GiB / 1.9 vCPU | ~50% memory, ~63% vCPU |

The data node has only about 13% vCPU headroom. If I5/I13 measure it CPU-bound, the fix is r7g.2xlarge On-Demand (derived, UNVERIFIED: 2 x $0.2142 = $0.4284/h, +$156/month), which **breaks the $600 cap** in a certification month and needs an owner decision; the alternative is dropping Cassandra from the demo profile.

| Line | Lean sizing | Arithmetic (rate x quantity) | $/month |
| --- | --- | --- | ---: |
| EKS control plane | 1 cluster, standard support | 730 h x 0.10 | 73.00 |
| System node | 1 x t4g.large On-Demand | 730 x 0.067 | 48.91 |
| Data node | 1 x r7g.xlarge On-Demand | 730 x 0.2142 | 156.37 |
| Spot app nodes | 2 x m7g.xlarge Spot, 217 h each (scheduled) | 434 x 0.095 | 41.23 |
| Sandbox pool | m7i.xlarge On-Demand, 30 h | 30 x 0.2016 | 6.05 |
| GPU pool | g6.xlarge Spot, 80 h | 80 x 0.605 | 48.40 |
| EBS gp3 | ~266 GB-month equivalent: 235 GB persistent (Postgres 40, Kafka 20, Cassandra 40, OpenSearch 40, Redis 5, RabbitMQ 10, Prometheus/Loki/MLflow 30, system and data roots 50) plus prorated roots of scheduled nodes (app 60 x 217/730, GPU 100 x 80/730, sandbox 50 x 30/730) | 266 x 0.08 | 21.28 |
| EBS snapshots (UNVERIFIED rate) | ~100 GB stored | 100 x 0.05 | 5.00 |
| S3 storage | ~300 GB Standard with lifecycle | 300 x 0.023 | 6.90 |
| S3 requests | 200k PUT, 2M GET | 200 x 0.005 + 2,000 x 0.0004 = 1.00 + 0.80 | 1.80 |
| NAT gateway | 1 NAT, ~60 GB processed | 730 x 0.045 + 60 x 0.045 = 32.85 + 2.70 | 35.55 |
| NAT public IPv4 | 1 EIP | 730 x 0.005 | 3.65 |
| ALB | 1, ~0.5 LCU average | 730 x 0.0225 + 365 x 0.008 = 16.43 + 2.92 | 19.35 |
| ALB public IPv4 | 2 addresses (2 AZ subnets) | 1,460 x 0.005 | 7.30 |
| CloudWatch | logs 10 GB (5 billable) + 10 GB stored + 15 alarms + 5 custom metrics | 2.50 + 0.30 + 1.50 + 1.50 | 5.80 |
| KMS | 6 keys, 500k requests | 6 x 1 + 48 x 0.03 = 6.00 + 1.44 | 7.44 |
| Secrets Manager / SSM | 2 rotating secrets + ~18k calls; ~25 other secrets in SSM standard (free) | 2 x 0.40 + 1.825 x 0.05 = 0.80 + 0.09 | 0.89 |
| ECR (UNVERIFIED rate) | ~30 GB | 30 x 0.10 | 3.00 |
| Misc (UNVERIFIED) | Route 53 zone, SQS/EventBridge | lump sum | 1.00 |
| Internet egress | inside 100 GB/month free allowance | 0 x 0.09 | 0.00 |
| **Infrastructure subtotal (Lean)** | | 73.00 + 48.91 + 156.37 + 41.23 + 6.05 + 48.40 + 21.28 + 5.00 + 6.90 + 1.80 + 35.55 + 3.65 + 19.35 + 7.30 + 5.80 + 7.44 + 0.89 + 3.00 + 1.00 | **492.92** |
| **Claude, product (cap, R22)** | customer traffic $220 + local/dev real-Claude (own key) $60 + I6 E2E and calibration $20; a cap, not a forecast | cap | **300** |
| **Claude, eval (cap, R22)** | T0 $0 per PR; T1 self-hosted in GPU windows; T2 weekly via Message Batches <= $12/run (~$52/month) + $30 release-candidate reserve + $18 online-eval judge calls and recalibration | 52 + 30 + 18 = 100 | **100** |
| **Grand total (Lean)** | | 492.92 + 300 + 100 | **892.92** |

Checks: infrastructure 492.92 <= 500 (target) <= 600 (cap); grand total 892.92 <= 1,000; headroom $107.08 (10.7% of the total, 17.9% of the infrastructure cap). Every quantity is UNMEASURED.

**Scenarios that must still fit or be governed (from `cost_model.json`).** (1) **Certification/soak month** (I13-G3/G9 need 24x7 availability, so scheduled scale-down is switched off): app nodes 2 x 730 x 0.095 = 138.70 and EBS 308.2 GB, infrastructure **$593.77, inside the $600 cap by $6**. That month has no room for anything else; do not run the GPU beyond 80 h or add nodes. (2) Same month with all 80 GPU-hours On-Demand (0.805/h): $609.77, **over the cap**; therefore the GPU guard in I12 §2.2 adds a dollar alarm (GPU spend $60/month) next to the 80-hour alarm, and the `gpu-l4-od` pool stays gated. (3) Other breakers: a third Spot app node (about +$20.6 at scheduled hours, +$69 always-on), Spot app nodes falling back to On-Demand (2 x 217 x (0.163 - 0.095) = +$29.5 scheduled, +$99 always-on), r7g.2xlarge data node (+$156). The AWS Budgets action and Karpenter limits (R22) enforce this in code. AWS WAF ($8.60/month, verified) is **not** in the plan: prod and G2 only; the demo ALB uses a security-group allow-list plus gateway rate limits. Adding it uses $8.60 of the headroom (owner decision).

**Savings evaluated.**

| Option | Decision | Reasoning |
| --- | --- | --- |
| Graviton for system, data, app nodes | **Adopted, conditional on multi-arch images** | Data node 156.37 vs 193.45 on r7i (-$37.1), system 48.91 vs 60.74 (-$11.8). Spot app price is a wash (m7g $0.095 vs m7i $0.092), so the app pool allows both architectures and is priced at the higher. GPU, sandbox AMI stay x86. |
| Scheduled scale-down of Spot app nodes | **Adopted** | 217 h vs 730 h: 2 x (730 - 217) x 0.095 = -$97.5. Stateless plus RabbitMQ on a persistent volume; the Debezium slot retains WAL while Connect is down (a 62-hour weekend is small at demo write rates; slot lag alarm still applies). Disabled in the certification month. |
| Scheduled scale-down of sandbox and GPU pools | Already at zero when idle | Karpenter scale-from-zero and KEDA `fallback.replicas: 0`. |
| Data node scheduled off (nights/weekends) | **Rejected** | Would save about $110 but stops Postgres, Kafka, Cassandra and OpenSearch together: WAL-slot, Kafka log and Cassandra commit-log recovery on every morning, one failed cold start breaks a demo day, and it contradicts the 30-day G9 measurement. Revisit only with a tested startup runbook. |
| Spot for the data node or any stateful store | **Rejected** | Interruption mid-write on a single-node store loses availability and risks corruption; violates "never Spot" (I00 §5.1, I12 §2.2). |
| Single NAT vs alternatives | **Single NAT kept** (already single) | Public subnets for nodes: saves $33 but gives every node a public IPv4 ($3.65 each) and breaks the private-subnet and known-egress-IP design (I12 §2.2). Interface endpoints for ECR, STS, KMS and Secrets Manager: about 5 x 730 x $0.01 = $36.5 in the demo, more than the NAT. NAT instance (fck-nat): saves about $25 but is unsupported, patched by us and a throughput cap; recorded as optional, not taken. **Adopted:** free S3 gateway endpoint, which keeps ECR layer pulls off the NAT data charge. |
| EBS right-sizing, gp3 vs io | **gp3 kept; sized to about 266 GB-eq** | gp3 baseline (3,000 IOPS, 125 MB/s) covers a single-node demo; io2 at $0.125 plus $0.065/IOPS is never needed here. EBS is only ~4% of the total, so the saving is small (about -$2.7 vs 300 GB). Snapshots added (previously omitted). |
| S3 lifecycle | **Adopted, small** | Standard with noncurrent-version expiry and Glacier IR after 90 days; Intelligent-Tiering rejected (per-object monitoring fee, nothing to tier at 300 GB). |
| Secrets Manager to SSM Parameter Store | **Adopted** | 25 non-rotating secrets move to free standard parameters: -$10.0; keep 2 rotating secrets. |
| Drop the ALB WAF in the demo | **Adopted, owner decision** | -$8.60; not a permanent removal (G2). |
| 1-year Compute Savings Plan | **Optional, not relied on** | Reserved 1-yr shows r7g.xlarge $0.142/h vs $0.214 (-34%), but it is a commitment on a demo that may be shut down, and Savings Plan rates were not verified. If taken later on the always-on data and system nodes, it is extra headroom, never part of the plan of record. |
| Higher illustration (managed RDS/ElastiCache/OpenSearch) | **Deleted** | Exceeded the cap by $432 and was built on unverified prices. |

Notes. (a) AWS charges for the EKS control plane, a NAT gateway, an ALB and public IPv4; the ALB can be dropped (port-forward) in idle weeks, saving about $26.6 (ALB, LCU and both addresses). (b) Replacing in-cluster Kafka with 3 x MSK kafka.t3.small plus 100 GB each adds about $130, which the Lean plan cannot afford. (c) The demo is single-AZ; production is multi-AZ (ADR-0024) and is priced in §5.2 only as order of magnitude. (d) Prices, disk sizes and hours are planning inputs, UNMEASURED until the I13 calibration run. (e) Corrections made while verifying: public IPv4 charges (NAT and ALB, $10.95), EBS snapshots ($5), ECR ($3), Secrets Manager, CloudWatch alarms and metrics were missing from the earlier plan; GPU hours were 40 while I12 budgets 80.

**Single cost source.** All figures in this section, the Claude call-type prices and the caps live in one machine-readable file, `docs/intelligence/cost_model.json`, created in I0 (§8.1 item 5). I06 (budgets, routing), I09 (eval spend), I12 (dashboards) and the G-I0-5 gate read that file. Prose numbers in section files are derived from it and are updated with it.


Hard-cap behaviour: at 100% of a tenant or global budget, the gateway returns **429 `budget_exhausted` with `Retry-After`** (R22; never 402). The advisor degrades to "retrieval-only answers with citations" (no generation), and the ML scoring path is unaffected. The demo **never** runs Tier 1 load against paid LLMs. Load tests use a stub provider in model-gateway with recorded latency distributions, plus one short, capped real-provider calibration run. This rule is repeated in I13.

### 5.2 Full-target monthly cost (UNMEASURED, order of magnitude)

**Cost per question, by call type, cached-prefix size and model.** A question is three LLM calls (A5). Token split follows A6/A7 (12k input, 8k of it static prefix, 1.2k output): router 2.0k in / 0.1k out with only a ~1.5k own prefix; plan 5.0k in (4.0k static prefix) / 0.3k out; answer 5.0k in (4.0k static prefix) / 0.8k out. The router is always Haiku. Plan and answer run on the routed model. **The static prefix is 4.0k tokens, below the 4,096 minimum, so nothing is cached on Haiku (and, conservatively, on Sonnet/Opus).** Prices in $/call = in x rate + out x rate.

| Call type | Haiku 4.5 | Sonnet 5.5 | Opus 5.5 |
| --- | ---: | ---: | ---: |
| Router (2.0k in, 0.1k out, Haiku only) | $0.0020 + $0.0005 = $0.0025 | (Haiku) $0.0025 | (Haiku) $0.0025 |
| Plan, uncached (5.0k in, 0.3k out): input + output | $0.0050 + $0.0015 = $0.0065 | $0.0100 + $0.0030 = $0.0130 | $0.0200 + $0.0060 = $0.0260 |
| Answer, uncached (5.0k in, 0.8k out): input + output | $0.0050 + $0.0040 = $0.0090 | $0.0100 + $0.0080 = $0.0180 | $0.0200 + $0.0160 = $0.0360 |
| **Question, uncached (router + plan + answer)** | **$0.0180** | **$0.0335** | **$0.0645** |
| Plan, prefix > 4,096 and warm (1k fresh in + 4k cache read + 0.3k out) | $0.0010 + $0.0004 + $0.0015 = $0.0029 | $0.0020 + $0.0008 + $0.0030 = $0.0058 | $0.0040 + $0.0016 + $0.0060 = $0.0116 |
| Answer, prefix > 4,096 and warm (1k fresh + 4k read + 0.8k out) | $0.0010 + $0.0004 + $0.0040 = $0.0054 | $0.0020 + $0.0008 + $0.0080 = $0.0108 | $0.0040 + $0.0016 + $0.0160 = $0.0216 |
| Question, prefix > 4,096 and warm (router + plan + answer) | $0.0108 | $0.0191 | $0.0357 |

Weighted by A8 (60% / 35% / 5%):

* **Uncached, plan of record:** 0.60 x 0.0180 + 0.35 x 0.0335 + 0.05 x 0.0645 = 0.01080 + 0.01173 + 0.00323 = **$0.0258 per question**. All downstream rows use this.
* **Target after I6 lifts the static prefix above 4,096 tokens (warm cache, write premium excluded, so a lower bound):** 0.60 x 0.0108 + 0.35 x 0.0191 + 0.05 x 0.0357 = 0.00648 + 0.00669 + 0.00179 = **$0.0150** (about 42% lower). I6 must measure the real hit rate; the old $0.0162 assumed a cached prefix and a Haiku prefix below the floor, and is withdrawn. All figures UNMEASURED.

| Driver | Tier 1 | Tier U | Dominates? |
| --- | ---: | ---: | --- |
| LLM tokens (questions/day x $0.0258 x 30; 90,000 x 30 = 2.7M questions/month, x100 at Tier U) | ~$70k (about $41k at the $0.0150 target) | ~$7.0M (about $4.1M at target) | **Yes, by far** |
| QLoRA triage GPUs (g6.xlarge On-Demand $0.8048/h verified, ≈ $590 per GPU-month; Spot about $0.60/h ≈ $440, capacity not guaranteed) | share of 1 L4 ≈ $0.6k | ≤ 10 L4 (with cascade) ≈ $6k; ~33 L4 without ≈ $19k | Only without the cascade |
| Rerank and embedding (CPU per R21; m7i, vCPU-month about $37 On-Demand or about $15 Spot, derived from the verified m7i.2xlarge rates) | < $0.1k | ~700 vCPU ≈ $10–26k at top-20 | Second, if top-k is not held at 20 |
| ML scoring CPU (tier A + tier B, ~30 vCPU + headroom at Tier U) | < $0.1k | ~$0.6–1.5k | No |
| Offline corpus + prediction storage (compressed 5×, tiered): S3 corpus about $1.5k at $0.023/GB-month, the rest is RDS/Postgres storage at about $0.115/GB-month (UNVERIFIED) | ~$0.2k | ~$10–30k | Third at Tier U |
| OpenSearch Service kNN memory (knowledge; only t3.medium.search priced, larger memory-optimised instance prices not verified) | small | ~$20–40k (UNVERIFIED) | Moderate |

**Consequences for the design** (these are requirements, not suggestions):

1. Per-tenant token budgets come from plan entitlements (ADR-0018 projection), held on sharded rows in `greenguard_ai_usage` (R22). A free plan gets a small fixed budget; a paid plan is metered through `ai.usage.v1` into billing. Without this, Tier U LLM cost is unbounded by design. **Free-plan default (demo): 10 advisor turns per tenant per day, Haiku-routed only** (no Sonnet/Opus), enforced as a per-tenant budget of $0.20/day (10 x $0.018 = $0.18, rounded up). Derivation: the demo has **25 tenants** (assumption, owner confirms); the $300 product cap is split $60 local/dev (README R22) + $20 I6 E2E and calibration (assumption) + **$220 customer traffic**; worst case, every tenant uses every turn every day = 25 x 10 x 30 x $0.018 = **$135**, which is inside $220 with 1.6x margin (the turn limit that would exactly exhaust $220 is 220 / (25 x 30 x 0.018) = 16 turns/day). The global product budget row still hard-caps at $300 regardless.
2. Prompt caching is mandatory. It needs a stable static system and tool prefix; any tenant segment starts with a **per-tenant secret nonce**, and vLLM uses a per-tenant `cache_salt` (R20). Target ≥60% of input tokens read from cache, measured in I6.
3. Routing (I6/I9) must show Haiku handles ≥60% of questions at no measurable quality loss on the I9 golden set, or the A8 cost assumption fails.
4. ~~Semantic answer cache per tenant~~ **Withdrawn (R20).** There is no final-answer or semantic answer cache. Only tenant-keyed embedding and response caches, and provider prompt caching as in item 2.
5. Batch API is used for evals and offline labelling only, never for interactive traffic.

---

## 6. ADRs

### 6.1 ADR-0023: parallel Intelligence track

The accepted text lives in [docs/adr/0023-intelligence-track.md](../adr/0023-intelligence-track.md) (single source; this section no longer duplicates it).

### 6.2 Other ADRs this charter requires (numbering per R30)

Intelligence ADRs start at 0023; placeholders such as `ADR-AI-xx` / `ADR-I*` in section files are renumbered when written.

| ADR | Decision | Stage |
| --- | --- | --- |
| ADR-0024 | **AWS, decided** (owner, 2026-09-29): platform-wide production cloud. EKS, RDS, MSK, S3, KMS, ECR, EKS Pod Identity (IRSA); first-party Claude API primary, Amazon Bedrock optional second channel (R29). [docs/adr/0024-aws-platform.md](../adr/0024-aws-platform.md) | Accepted; implemented I6 → I13 |
| ADR-0025 | Backfill endpoint, amends ADR-0006: one reading per receipt, max age set by owner, `backfilled=true`, synthetic/backfilled never notify (R32) | I1 |
| ADR-0026 | Delegated identity: BFF-issued ≤ 5-min token with `act`, per-audience; job-scoped tokens; RFC 8693 for external MCP clients only (R14) | I8b / I8c |
| ADR-0027 | Approval contract: endpoint, row fields, optimistic `If-Match`, 15-min expiry, `approved_pending_reauth` (R15) | I8b |
| ADR-0028 | Append-only history, compaction / strip-thinking policy (R19) | I8a |
| Per-stage ADR | Consent and pooled training: `tenant.ai_consent.v1`, cohort floor and cap, structured features only (R24) | I2 prerequisite |
| Per-stage ADR | Feature bitemporality and point-in-time correctness (event_time vs knowledge_time; leakage tests) | I1 |
| Per-stage ADR | Feature-set versioning, train/serve parity and the real-ingest parity sample (R4) | I1 |
| Per-stage ADR | Git deployment manifest, cohort canary via flags, rollback fast path (R10) | I5 |
| Per-stage ADR | Prediction publication on material change and the scored-through watermark (R9) | I5 |
| Per-stage ADR | Model gateway as sole LLM egress; sharded budget reservation pattern (R22) | I6 |
| Per-stage ADR | Provider choice and data residency for LLM calls (Bedrock region vs first-party `inference_geo`), depends on O3 | I6 |
| Per-stage ADR | Knowledge index as projection; public vs tenant indexes; embedding version migration (R11) | I7 |
| Per-stage ADR | Content store, per-tenant DEK, key hierarchy (R23) | I8a |
| Per-stage ADR | Guardrail layers and red-team gate | I10 |
| Per-stage ADR | AI deletion inventory and deletion-ledger replay (R26) | I0 / I10 |

---

## 7. Cross-cutting edge cases and failure modes

### 7.1 Decision: pooled vs per-tenant models, and privacy

**Decision:** use **pooled global models with per-tenant calibration**. There are no per-tenant deep models. Consent follows the single model in R24.

* Consent is owned by tenant-control-plane as `greenguard.tenant.ai_consent.v1` with `training ∈ {none, own_tenant, pooled}` (default `none`) and `eval_review: bool` (default `false`), set by an org admin and projected to consumers. It is built as an I2 prerequisite (R24).
* Base models (GBM, LSTM/TCN, AE, transformer, QLoRA adapter) train on simulator data **only** until ≥ 50 tenants consent to `pooled`. After that, they train on simulator data plus data from tenants whose consent is `pooled` at snapshot time; `own_tenant` data is used only for that tenant's calibration. The consent version is recorded per manifest row.
* Pooled training uses **structured features and enums only — no free text, no agent trajectories** (R24). Keys are **pseudonymised with a per-dataset HMAC, never dropped** (R6); the mapping stays in the manifest. The QLoRA dataset (I11) is synthetic plus consented, scrubbed structured triage cases in prompt–completion format (R31). It never includes transcripts.
* Export runs one RLS transaction per tenant (no BYPASSRLS, no SECURITY DEFINER). Minimum cohort ≥ 50 consenting tenants and ≤ 10% of rows per tenant. Tests: floor, per-tenant cap, no free-text columns, and an adversarial tenant at the cap does not move another tenant's metrics beyond tolerance (R24). I10 also runs a membership-inference probe.
* Per-tenant **calibration** (isotonic or temperature scaling plus per-bin baseline normalisation) is a small, tenant-owned row in `greenguard_ml`. It is fitted only on that tenant's own data and is never shared.
* Why not per-tenant models: 10M orgs × models is infeasible, most tenants have too little data, and cold start is bad. Why not a pooled model with no consent: tenant data would influence predictions served to other tenants without agreement, which is legally and commercially unacceptable.
* **Serving another tenant** from a pooled model is allowed. The model's influence from a tenant's data is statistical, the tenant gave `pooled` consent, and I10 checks there is no memorised extraction. **LLM prompts never contain another tenant's data. That rule has no exceptions.**

### 7.2 Edge-case and failure-mode table

| # | Scenario | Risk | Required behaviour | Test (stage) |
| --- | --- | --- | --- | --- |
| X1 | Tenant deleted mid-training job | Deleted data ends up in a new model | The training job snapshots the manifest at start. Before registering the model, it re-checks tenant status and consent. If any contributing tenant was deleted or revoked, the model is **not registered** and the job retrains without it. | Kill tenant mid-job fixture (I2) |
| X2 | Tenant deleted after a model shipped | Model retains the influence of deleted data | Policy: the next scheduled retrain (≤30 days) excludes the tenant. The manifest marks affected model versions `retrain_required`. There is no machine-unlearning claim. Deletion proof lists those versions and when they were superseded. Content and checkpoints are crypto-shredded immediately (R26). | Deletion proof report (I10/O2) |
| X3 | Consent changed from `pooled` to `own_tenant` or `none` | Same as X2 | Same as X2. The tenant-pseudonym Parquet partitions are deleted within 7 days (R6 partitioning bounds the rewrite). | I1/I2 |
| X4 | Model trained on tenant A serving tenant B | Leakage or bias | Pooled with `pooled` consent only (§7.1). Extraction probe on the QLoRA adapter: prompts with tenant A's device IDs must not produce A-specific values. | I10, I11 |
| X5 | Device clock skew (observed_at in the future) | Wrong window, leakage | Ingest already rejects > 5 min future (ADR-0006). Features use `observed_at` for windowing and `knowledge_time` for point-in-time availability. Skew within 5 min is logged. Windows close by watermark, not wall clock. | I1 leakage test |
| X6 | Late data within allowed lateness | Stale feature, wrong score | Recompute the affected window. Emit a new prediction with `supersedes_prediction_id`. Never mutate the old row. | I5 |
| X7 | Late data beyond max age (ADR-0006 late path) or backfilled readings (`backfilled=true`, R32) | Unbounded recompute; notifications from old data | Offline store only, flagged `late=true`. No live rescore. Backfilled and synthetic-tenant readings never notify; alerts are recorded as backfilled (R32). | I1 |
| X8 | Replay of canonical topics | Replay emits live predictions or alerts; duplicate advisor notices | Replay for corpus building runs under a separate consumer group and writes offline Parquet only, **never** the outbox. The scorer's inbox dedupes live replay by event ID. | I1/I5 replay test |
| X9 | Feature schema evolution (new feature, changed definition) | Train/serve skew | `feature_set@MAJOR.MINOR`. MINOR is additive and older models ignore it. MAJOR means a new online computation runs beside the old one. The deployment reconciler refuses a Git manifest whose model's feature set is not live in the target cell. | I1/I5 |
| X10 | Canonical event schema evolution (Registry, ADR-0010) | Scorer parse failure | Strict parse. Unknown major version is quarantined and the offset committed only after quarantine (existing pattern). Alert on quarantine rate. | I5 |
| X11 | Model rollback while predictions are in flight | Mixed versions | Every prediction row carries `model_version`. Rollback fast path: set the cohort flag to 0% (seconds) and open an automatic Git revert PR; nothing writes MLflow aliases directly (R10). The scorer drains and switches at a window boundary. | I5 |
| X12 | Registry (MLflow) down | Cannot deploy | Serving uses the pinned local artifact (image or S3 digest) named in the Git manifest. The registry is not on the request path. | I5 chaos |
| X13 | EC2 Spot interruption during QLoRA or eval (2-minute interruption notice, Karpenter drains on it) | Lost work, cost; L4 Spot capacity is not guaranteed | Checkpoint every N steps to S3 (a checkpoint must fit in the 2-minute notice window). Resume is idempotent by `run_id`. On repeated interruption or no Spot capacity, fall back to the On-Demand `g6.xlarge` pool (I13). | I11 |
| X14 | GPU pool at zero when triage or generation requests arrive | Latency | Triage is asynchronous and queued; SLO is minutes, not seconds; the advisor reports "triage pending". Guard, embedding and rerank run on CPU so no turn waits on a cold GPU; `self_hosted_only` tenants see a bounded wait (≤ 15 min, shown in UI) (R21). | I11/I13 |
| X15 | LLM provider outage or 429 | Advisor down | Gateway failover: Claude primary, then an alternate region or provider, then vLLM small model (reduced capability, labelled), then retrieval-only. The circuit breaker is per provider. | I6 chaos |
| X16 | LLM call succeeds but the gateway crashes before settlement | Unbilled usage or double charge | Reserve (row with `llm_call_id`), call, then settle. The reaper settles orphan reservations from provider usage headers, or at the reserved maximum after a TTL. The billing event is emitted once per `llm_call_id`. | I6 crash matrix |
| X17 | Budget exhausted mid-conversation | Truncated answer | Reservation is sized to max_tokens before the call, so the call either runs in full or is refused. The user sees **429 `budget_exhausted` with `Retry-After`** (R22). | I6 |
| X18 | Streaming client disconnects | Wasted tokens | Cancel the upstream stream. Settle actual tokens. Resume uses `Last-Event-ID` on the BFF SSE endpoint (R18). | I6 |
| X19 | Agent proposes an action, user approves twice or on two devices | Double effect | `proposal_id = uuidv5(run_id ‖ action_hash)`; approval uses `If-Match: version` and the second decision gets 409 (R15). The owning service receives the idempotency key; a replay returns the first result. | I8b |
| X20 | Approved action's target changed since the proposal (stale), or the proposal expired | Wrong effect | The proposal stores the target `version`. The owning service rejects on mismatch (409); expired proposals return 409 `proposal_expired` (15 min). Advisor re-plans. | I8b |
| X21 | Prompt injection in a tenant document or device name | Tool misuse, exfiltration | Tools use the approver's or user's delegated token (no escalation, R14). Actions are proposals only; viewers cannot propose (R16). Retrieved text is marked as data. Answer text is released only after structured-output, groundedness and output-safety checks (R18). Red-team suite. | I10 |
| X22 | Cross-tenant retrieval through a missing filter | Data leak | The OpenSearch query builder **requires** a tenant filter inside the k-NN query (type-level), plus `_routing = tenant_id` in the shared per-cell index. Public hits are accepted only from the public index (R11). A test proves tenant B gets 0 hits for tenant A's unique canary string. | I7 |
| X23 | Checkpoint resumed under a different tenant or user | Leak | Custom checkpointer with `tenant_id` and forced RLS, blobs wrapped with the per-tenant DEK (R23). Threads, run events, streams and proposals are author-owned via RLS on `user_id` plus repository filter (R17). User mismatch returns 404. | I8a |
| X24 | Cache (embedding, response, prompt) served across tenants | Leak | Every cache key includes `tenant_id`. There is **no final-answer or semantic answer cache and no global answer cache** (R20; the earlier "global-corpus-only answer" exception is withdrawn). Prompt-cache tenant segments start with a per-tenant secret nonce; vLLM uses per-tenant `cache_salt`. | I6/I8a |
| X25 | Embedding model upgrade | Mixed-vector index | New tenant index per cell and embedding version built from source, recall eval (I9), then alias switch. Old index kept 7 days (and included in deletion, §3.2). | I7 |
| X26 | Tenant moved between cells (SCALE doc tenant movement) | AI state left behind | Feature state is rebuilt in the target cell from history. Content and knowledge move with the tenant's DB snapshot and DEK. The Git deployment manifest is per cell, so the same model version must be deployed in the target cell's manifest before cutover (R10). | I13 |
| X27 | Simulator pointed at a production tenant | Fake data in the real tenant | sim-lab only accepts tenants with the `tenant.synthetic` flag (enforced server-side by the device token claim, not just CLI config); synthetic tenants never notify (R32). | I1 |
| X28 | Label leakage (future label in features) | Inflated metrics | Point-in-time join on `knowledge_time`. A backtest harness with a purged, embargoed time split. A deliberate-leak test must be caught by the pipeline. | I1/I2 |
| X29 | Concept drift: new crop, season, sensor firmware | Silent accuracy loss | PSI/KS per feature and prediction distribution against the reference, per cohort, never per tenant label in metrics. Drift event triggers retrain proposal. **Retrain requires human promotion** through the Git manifest. | I5 |
| X30 | Feedback loop: ML advisories change operator behaviour, which becomes labels | Self-reinforcing bias | Labels from ML-influenced actions are tagged. Hold out a random 5% of devices scored by risk-engine only (canary design) for unbiased evaluation. | I5 |
| X31 | Cost runaway from an agent loop | Budget burn | Per-turn limits from `ai/policy/tools.yaml`: **8 tool calls and 60 s per turn** (R16), a task budget per turn, per-tenant budget, global kill switch (feature flag). | I6/I8a |
| X32 | Model ID drift or deprecation (provider retires a model) | Outage | Model IDs live in gateway config, not code, with first-party aliases `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5` and Bedrock IDs mapped per provider (R19). No sampling parameters on 5.5 routes; the gateway startup check rejects them. The I9 eval must pass on the replacement before switch. | I6 |
| X33 | Data residency (O3) | Tenant data processed out of region | Gateway routes by tenant home region (Bedrock region or `inference_geo`). Unknown region means refuse. | I6 (blocked on O3) |
| X34 | Clock skew between services timing SLOs | Wrong latency evidence | Reuse the Stage 13 rule: measured clock-error bounds. Commit time is never inferred from an HTTP ACK. | I13 |
| X35 | gVisor is self-installed on EKS (no managed sandbox, unlike some other clouds) | Sandbox escape or a broken runtime after an AMI, containerd or kernel upgrade; parser/tool sandbox silently falls back to `runc` | Dedicated tainted node group on a custom AMI with `runsc` registered as a RuntimeClass (ADR-0024). Pods that require the sandbox set `runtimeClassName: gvisor` and Kyverno rejects them if the class is absent; no fallback to the default runtime. The escape and egress test suite re-runs per AMI build. The AMI and upgrade cadence are a maintained artifact with an owner. Firecracker/Kata on bare-metal nodes is the documented hardening path. | I10 (suite), I13 (AMI pipeline) |

### 7.3 Tenant-isolation tests owned by the charter (cross-service)

| ID | Test | Pass criterion |
| --- | --- | --- |
| IT-01 | Two tenants, same device-name and document canary strings. Tenant B uses every AI surface: advisor, MCP tools, retrieval, predictions GraphQL, usage API | 0 occurrences of tenant A's canary in any response, trace attribute, cache or log line (grep over captured output) |
| IT-02 | Catalog-driven (R27): every table and partition in every AI database has `tenant_id` + FORCE RLS unless on the reviewed non-tenant allowlist (e.g. `public_*`); runtime role has no BYPASSRLS; composite FKs | Catalog query asserts it; a cross-tenant insert fails with 42501 |
| IT-03 | PgBouncer transaction pooling: interleave tenants on one pooled connection in each new service | No context leaks (D03 pattern) |
| IT-04 | Training export for tenants with consent `none` or `own_tenant` into the pooled corpus | 0 rows; no free-text columns in any pooled export (R24) |
| IT-05 | Tenant deletion → restore → replay (R26) | After a pre-deletion restore and deletion-ledger replay: zero rows/hits in every store in §3 (all AI Postgres DBs incl. checkpoints and PITR restore, OpenSearch indexes and restored snapshots, S3 partitions incl. soft-deleted objects after the window, Redis keys); tenant DEK destroyed; Kafka records past retention; affected model versions listed `retrain_required` |
| IT-06 | Budget isolation: tenant A exhausts its budget | Tenant B's calls are unaffected; A gets 429 `budget_exhausted` with `Retry-After` |
| IT-07 | Every new consumer: Kafka key / envelope / payload tenant mismatch (R12, R27) | Message quarantined; no effect written |

---

## 8. Acceptance gates for I0

### 8.1 I0 exit gate list

I0 is complete only when every item below has linked evidence under `evidence/` (README §5, R5, R29, R30):

1. **ADR-0023 approved by the owner** (status "Accepted" in `docs/adr/0023-intelligence-track.md`).
2. **ADR-0024 (cloud) written and decided**: done, **AWS platform-wide, accepted 2026-09-29** ([ADR-0024](../adr/0024-aws-platform.md)); link the evidence of acceptance (R29).
3. **`docs/TECHNOLOGY_CATALOG.md` entries** added for every new technology family introduced by the track (for example MLflow, LangGraph, MCP TS SDK, vLLM, PyTorch/ONNX runtime, OpenSearch k-NN usage, gVisor, Prompt Guard, Argo Workflows) (R30).
4. **Recomputed workload model** from R5 (A1 = 16, A9 = 15-min cadence and grid) reproduced by the capacity script, every figure labelled UNMEASURED (G-I0-3 below).
5. **`docs/intelligence/cost_model.json` created** (I0 deliverable): the single machine-readable cost source for §5.1/§5.2 and the R22 caps, read by I06, I09, I12 and the gates (G-I0-5).

### 8.2 Gate metrics

| Gate | Metric | Threshold |
| --- | --- | --- |
| G-I0-1 | Owner approval of ADR-0023; ADR-0024 accepted (AWS) | Signed status "Accepted" in `docs/adr/` |
| G-I0-2 | Every service in §2.1 has an owner DB, topics and README stub with "scaffolded, not implemented" status | 5/5 |
| G-I0-3 | `capacity_assumptions.json` gains an `intelligence` block with A1–A14, and `scripts/capacity_model.py` (in an isolated copy, per CAPACITY_MODEL rules) reproduces §4.3 and §4.4 | Byte-identical numbers; `make check-plan` passes |
| G-I0-4 | Each assumption A1–A14 is linked to the I-stage evidence file that will measure it | 14/14 |
| G-I0-5 | `docs/intelligence/cost_model.json` exists and is the **single machine-readable cost source** read by I06, I09, I12 and the gates. It carries the §5.1 Lean lines and subtotal (492.92), the §5.2 call-type prices and weighted cost per question, the free-plan default, and the caps: infrastructure ≤ $600, product Claude ≤ $300, eval Claude ≤ $100, total ≤ $1,000 (R22). AWS Budgets alerts (50/90/100%) are defined as code | File present and its totals recompute to §5.1 (infrastructure 492.92, grand total 892.92, headroom 107.08); `make intelligence-cost-check` passes and fails on any cap breach; `terraform plan` or equivalent dry-run shows the budget resource (after ADR-0024) |
| G-I0-6 | `TECHNOLOGY_CATALOG.md` entries for new technology families | Every new family listed |
| G-I0-7 | `architecture-guard` subagent review of this charter against CLAUDE.md invariants and the README | No unresolved blocking findings |

---

## 9. Senior topics covered by I0

Service decomposition by write owner, failure domain and threat model; data ownership, lineage and a full deletion inventory for ML and AI stores; bitemporal point-in-time data; train/serve skew control; tenancy for pooled ML (consent, cohort floor, calibration, unlearning policy); workload modelling from first principles, with explicit assumptions and measurement owners; tiered capacity (certifiable vs forecast); LLM unit economics (caching, routing, batch, hard caps); cell-aligned serving vs environment-level training; ADR-driven governance of a parallel track; cost-dominance analysis (tokens ≫ CPU retrieval ≫ storage ≫ GPU with a cascade); graceful degradation ladders.

## 10. Skills an implementer should load

`wshobson-architecture-patterns`, `ecc-architecture-decision-records` (or `wshobson-architecture-decision-records`), `wshobson-cost-optimization`, `ecc-cost-aware-llm-pipeline`, `claude-api` (model IDs, pricing, caching, Bedrock client), `wshobson-ml-pipeline-workflow`, `ecc-mle-workflow`, `wshobson-microservices-patterns`, `wshobson-gdpr-data-handling` (deletion and consent), `ecc-kubernetes-patterns` (EKS pools), `wshobson-slo-implementation`.

## 11. Open questions for the owner

The owner decision list is README §8. Charter-specific questions:

1. **Q1 Tier U users:** 10M registered and 10M concurrent imply 100% online. Should concurrent be read as a connection-stress envelope and DAU as 30% for cost? (At Tier U the A4 peak rate is 64× the daily average.)
2. **Q2 Consent:** decided in R24 (default `none`, org admin sets, ≥ 50-tenant floor); owner confirmation is README §8 Q2.
3. **Q3 Provider:** decided (ADR-0024, owner 2026-09-29): **first-party Anthropic API primary, Amazon Bedrock optional second channel** and data-residency option. Bedrock model IDs, prices and feature parity are UNVERIFIED and must be checked in I6 before enabling (README §8 Q4).
4. **Q4 Cloud:** decided, AWS (ADR-0024). Budget caps decided (R22).
5. **Q5 ML authority:** out of scope; ML stays advisory (R7). A future ADR is needed to reopen it.
6. **Q6 Budgets:** decided 2026-09-29 (R22).
7. **Q7 Haiku model ID:** decided in R19 (first-party alias `claude-haiku-4-5`, Bedrock IDs mapped per provider in config).
8. **Q8 Tier 1 event envelope vs R5:** 1M devices at a 15-min cadence give ~1,111 readings/s, not 20k/50k events/s. Is the envelope headroom, or does Tier 1 assume a different device mix?
9. **Q9 Usage ledger after deletion:** must `ai_usage_ledger` rows survive tenant deletion for billing law (§3.1)?
