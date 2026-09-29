# I12 Agent/LLM and ML observability, and I13 Production deployment, scale and resilience certification

Section 06 of the GreenGuard Intelligence design spec. Status: DRAFT rev 3 for owner review, 2026-09-29 (rev 3: AWS platform per ADR-0024). Conformed to the binding [README](README.md) §2 (R1–R32), §3 name registry, §4 and §5; where this file and the README disagree, the README wins.

Service names follow README R1: `grain-advisor` (the copilot; formerly "copilot-svc"), `model-gateway` (`model-gw` below), `knowledge-service` (retrieval module and indexer), `mcp-gateway`, `ml-scoring`.

## 0. Starting point (verified in the repository, 2026-09-28)

| Asset | Actual state | Consequence for I12/I13 |
| --- | --- | --- |
| `packages/otel` | Implemented: TypeScript. W3C propagator, `ParentBasedSampler(TraceIdRatioBased)`, OTLP/HTTP trace export, in-memory test exporter. Traces only. No metrics or logs SDK. | I12 adds a Python equivalent (`packages/otel-py`, `greenguard_otel`) because the AI services (LangGraph, scoring, MLflow) are Python. It must follow the same ADR-0004 rules: store `traceparent` on outbox rows, never invent IDs, tenant only as a span attribute. |
| ADR-0004 | Accepted. Tempo, Loki, the collector and Python propagation are deferred to Stage 11. Stage 11 exit proof: one trace across HTTP, outbox, CDC, Kafka and projection. | I12 adds to Stage 11 and does not build a second stack. |
| `infra/observability`, `infra/helm`, `infra/kubernetes`, `infra/gitops`, `infra/terraform` | Only a README in each. Nothing implemented. **`infra/terraform/README.md` says "Terraform, AWS".** | Everything below is new. **No conflict any more:** ADR-0024 (accepted 2026-09-29) makes AWS/EKS the platform-wide target, matching the `infra/terraform` README, and the Stage 10b CDK serverless code is unchanged. Nothing is implemented, so I13 EKS/Terraform work waits for the Stage 12 shared platform and I12/I13 run on the local/Compose profile until then (§2.4). |
| `infra/staging/compose.yaml` | postgres, device-service, telemetry-ingest, gateway, dashboard | The local and staging parity path for AI services starts from here. |
| Prometheus client usage | Only `services/read-api` (prom-client). The Stage 07 saga worker exposes metrics too (`docs/runbooks/saga-alerts.rules.yml`). | The metric conventions below have almost nothing to stay compatible with. Follow the saga precedent: rule files live next to their runbooks, and no rule uses a tenant or ID label. |
| Stages 11–14 | Planned (12 has only GitHub Actions, SonarQube and local Docker). | **Ordering risk:** I12/I13 cannot wait for Stages 11–14 to finish, and must not fork them either. See §3. |
| ADR numbering | `0018-machine-authentication.md` and `0018-quotas-and-overage.md` both exist. | Same defect class as GrainGuard's "duplicate migration numbers". Intelligence ADRs start at 0023 (README R30: 0023 track, 0024 cloud, 0025–0028 fixed). The remaining `ADR-AI-xx` placeholders here are renumbered from 0029 upward when written. |

**OTel GenAI semantic conventions: verified at `open-telemetry/semantic-conventions-genai@e57c543` (2026-09-24).** These conventions have moved out of the main semconv repo into that repository. Status is **Development**, so names can change. Findings that affect this design:

- Operation names (`gen_ai.operation.name`): `chat`, `embeddings`, `retrieval`, `execute_tool`, `invoke_agent`, `invoke_workflow`, `plan`, `create_agent`, memory operations, `generate_content`, `text_completion`.
- Span attributes: `gen_ai.provider.name` (well-known values include `anthropic`; `aws.bedrock` is expected for the optional Bedrock channel but was **not re-checked** at the pinned commit, so verify before use; vLLM takes a custom value, `vllm`), `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.response.time_to_first_chunk`, `gen_ai.conversation.id`, `gen_ai.agent.name|id|version`, `gen_ai.workflow.name`, `gen_ai.tool.name|type|call.id`, `gen_ai.data_source.id`, `gen_ai.retrieval.top_k`, `error.type` (stable).
- Opt-in content attributes: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.retrieval.query.text`, `gen_ai.retrieval.documents`. These are gated by an explicit opt-in such as `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.
- **Metrics were renamed.** The old `gen_ai.client.token.usage` is now `gen_ai.client.inference.usage.input_tokens` / `.output_tokens` / `.cache_read.input_tokens` / `.cache_write.input_tokens` / `.reasoning.output_tokens`. Also: `gen_ai.client.operation.duration`, `gen_ai.client.operation.time_to_first_chunk`, `gen_ai.client.operation.time_per_output_chunk`, `gen_ai.invoke_agent.duration`, `gen_ai.invoke_agent.tool_calls`, `gen_ai.invoke_agent.inference_calls`, `gen_ai.execute_tool.duration`, `gen_ai.invoke_workflow.duration`, `gen_ai.server.time_to_first_token`, `gen_ai.server.request.duration`.
- Events: `gen_ai.evaluation.result` with `gen_ai.evaluation.name`, `gen_ai.evaluation.score.value`, `gen_ai.evaluation.score.label`, `gen_ai.evaluation.explanation`, `gen_ai.response.id`. This is the standard hook for linking a trace to an eval.
- MCP conventions exist: `mcp.method.name`, `mcp.session.id`, `mcp.request.id`, `mcp.protocol.version`, `mcp.resource.uri`, `jsonrpc.request.id`, and the metrics `mcp.client.operation.duration`, `mcp.server.operation.duration` and `mcp.client|server.session.duration`.
- HTTP retries use the stable `http.request.resend_count`.

Because the conventions are Development, we pin the commit in `packages/otel-py/SEMCONV_VERSION`, add a conformance test (§1.12), and keep our own names under `gg.*` so an upstream rename touches one mapping module.

---

# I12 — Agent/LLM and ML observability

## 1.1 Scope and non-goals

In scope: traces, metrics, logs, eval events and cost for every copilot request (Grain Advisor, I8), model-gateway call (I6), RAG retrieval (I7), MCP tool call, guardrail decision (I10) and human approval; every ML scoring batch, forecast run, drift job and training/QLoRA job (I1–I5, I11). Also dashboards, SLOs, alerts, runbooks, sampling, privacy and per-tenant cost attribution.

Not in scope:
- Billing itself (Stage 09 billing-service owns metering and Stripe).
- Offline eval methodology (I9 owns datasets, judges and thresholds; I12 transports and links their results).
- Guardrail policy content (I10).

## 1.2 Decisions

| # | Decision | Reasoning | Rejected alternatives |
| --- | --- | --- | --- |
| O-D1 | **The OTel GenAI semconv is the canonical schema. Custom attributes live under `gg.*`.** One mapping module per language emits both. | Owner-mandated OTel → Prometheus → Grafana path. Vendor-neutral. Standard `gen_ai.evaluation.result` gives trace↔eval linking for free. | OpenInference (Phoenix-native) as canonical: a second competing schema, and Phoenix already ingests OTLP GenAI. Vendor SDK schemas (Langfuse, Datadog): lock-in. |
| O-D2 | **Self-hosted Grafana LGTM on EKS:** OTel Collector, Prometheus (kube-prometheus-stack), Tempo and Loki on S3 object storage (SSE-KMS, lifecycle set to the retention in §1.9), Grafana. Amazon Managed Prometheus/Grafana are **not** used now (reasoning in §2.3.1). This is the single production observability plane shared with Stage 11. It runs in the local/Compose profile now; the EKS deployment follows the Stage 12 platform. | Fits the proposed ~$500/month demo budget (README §8 Q5; product Claude is separately hard-capped at $300/month and eval Claude at $100/month, R22): Tempo and Loki on S3 should cost tens of dollars at demo volume (estimate, to be recomputed with AWS prices in I0). One RBAC surface. No tenant content leaves the cluster and account. It is exactly the Stage 11 technology list in `infra/observability/README.md`. | **Langfuse v3 self-hosted in prod:** needs ClickHouse, Redis, S3 and Postgres (≈4 more stateful systems), and it is a second store of prompt content with its own tenancy model. It duplicates trace storage. **Grafana Cloud / Datadog LLM Observability:** per-series and per-span pricing, and tenant data egress. **Amazon Managed Prometheus + Amazon Managed Grafana now:** AMP replaces only Prometheus and AMG has no Tempo/Loki, so we would still run two of the four components and split the RBAC and rule-test surface; kept as the Tier U option (ADR-AI-O2). **CloudWatch as the primary store:** no PromQL rule tests and a poor fit for the exemplar/label design of the metric catalogue; used only for AWS-managed service metrics (§2.3.1). |
| O-D3 | **Arize Phoenix is allowed only in local and staging**, fed by a collector fan-out, for developers to inspect prompts. It is never in prod. | Phoenix gives an LLM-specific trace UI with content, useful while iterating prompts on synthetic data. It is one container. Prod content must go through the encrypted content store (O-D6). | Phoenix in prod: it would hold decrypted prompt content outside RLS and KMS. |
| O-D4 | **Instrumentation.** The model gateway owns all `chat`/`embeddings` spans and GenAI metrics, since it is the single choke point for every LLM call. The LangGraph callback handler owns `invoke_workflow`, `invoke_agent`, node and `execute_tool` spans. The MCP client and server wrappers own `mcp.*`. Official `opentelemetry-python-contrib` GenAI instrumentations are used only where they match the pinned semconv. | One place computes tokens, cost, TTFT, routing and retries, so there is no double counting. Owning these spans also means content capture cannot be switched on by a library default. | **OpenLLMetry/Traceloop auto-instrumentation as primary:** captures prompt content by default (`TRACELOOP_TRACE_CONTENT` defaults to true) and lags semconv renames. Can be evaluated in local for convenience. **LangSmith:** SaaS, sends content off-platform. |
| O-D5 | **Metrics are emitted by the application, not derived from spans.** Token, cost, TTFT and eval histograms are recorded in-process at 100% before sampling. The `spanmetrics` connector is used only for generic RED on HTTP/gRPC spans, in the agent-tier collector *before* tail sampling. | Tail sampling would bias span-derived metrics. Token counts and cost must be exact. | spanmetrics for everything: wrong after sampling, and cardinality is driven by span attributes. |
| O-D6 | **Content never goes in spans, metrics or logs in staging or prod.** Prompts, completions, retrieved chunks and tool arguments/results go to the **single tenant-scoped, envelope-encrypted content store** `grain-advisor.ai_interaction_content` (DB `greenguard_advisor`, owned by grain-advisor, `tenant_id` + forced RLS, per-tenant DEK wrapped by a per-environment AWS KMS KEK, 30-day default retention; built in I8a, README R23). **model-gateway stores no prompt/response content**; eval replay reads content only through grain-advisor's API with a tenant-bound token. The span carries only `gg.content.ref` (opaque UUID) and `gg.content.hmac` = HMAC-SHA256 of the content under a **per-tenant key** (README R20), so equal content in two tenants never produces a comparable hash. | PII (farmer names, phones, locations) and tenant confidentiality. Crypto-shred on tenant deletion (review O2). Also supports replay (§1.10). | Opt-in semconv content attributes in prod, with Tempo-level redaction: Tempo has no row-level tenancy, and one misconfiguration leaks every tenant. |
| O-D7 | **Per-tenant cost comes from a durable usage ledger, not telemetry.** model-gateway (sole emitter, README R28) writes an `ai_usage_ledger` row in `greenguard_ai_usage` (tenant, request, model, tokens, cost, price-table version) and, in the same transaction, an outbox event published to `greenguard.ai.usage.v1` (key `tenant_id`). The Stage 09 billing-service consumes it idempotently (README §4, I6 after GG-09). | Traces are sampled and metrics carry no tenant (invariant), so neither can bill. Outbox gives exactly-once effect through an inbox. | Deriving cost from Prometheus: violates the tenant-label invariant. Deriving it from Tempo: sampled, lossy. |
| O-D8 | **Two-tier collectors with tail sampling.** An agent DaemonSet does k8s attributes, redaction, spanmetrics and a `loadbalancing` exporter keyed on `traceID`. A gateway Deployment does `tail_sampling`, then Tempo. | Tail sampling needs every span of a trace on one gateway replica. | Head sampling only: drops the rare errors and guardrail blocks we most need. Single-tier tail sampling: splits traces across replicas. |
| O-D9 | **Asynchronous boundaries use span links, never one long trace.** This covers human approval, delayed eval, Kafka batches and training jobs. | An approval can wait hours, and tail-sampling `decision_wait` cannot. ADR-0004 already uses links for later hops. | Keeping the root span open until approval: the trace is never complete, and memory grows unbounded. |
| O-D10 | **Grafana dashboards, alert rules and recording rules are code** in `infra/observability/`, provisioned by a sidecar, with tests (promtool, dashboard linter, a metric-catalogue cross-check). | The Stage 11 gate "dashboard matches actual labels/routes". The GrainGuard source had deployment probe/metric drift. | Dashboards built by clicking in the UI: they drift. |

## 1.3 Span trees

### 1.3.1 Copilot request (one user turn, streaming)

```
[SERVER] POST /v1/copilot/threads/{thread}/messages            gateway/bff   (http.*, gg.tenant.id, enduser.pseudo.id)
└─ [INTERNAL] invoke_workflow grain_advisor                     grain-advisor gen_ai.workflow.name, gen_ai.conversation.id=thread,
   │                                                                          gg.task.id, gg.task.outcome, gg.eval.sampled, gg.canary
   ├─ [INTERNAL] gg.guardrail.check input                       guardrails    (CPU: Prompt Guard 2 86M, R21) gg.guardrail.stage=input, .rule, .action, .blocked
   ├─ [INTERNAL] invoke_agent grain_advisor                     LangGraph     gen_ai.agent.name/version, gg.graph.recursion_limit
   │  ├─ [INTERNAL] gg.graph.node plan  (gg.graph.step=1)                     gg.graph.state.bytes, gg.graph.state.messages, gg.graph.checkpoint.id
   │  │  └─ [CLIENT] chat claude-…  ── see "model gateway call" below
   │  ├─ [INTERNAL] gg.graph.node retrieve (step=2)
   │  │  └─ [INTERNAL] retrieval grain-kb-v3     knowledge-service (retrieval module) gen_ai.data_source.id, gen_ai.retrieval.top_k,
   │  │     │                                                                 gg.retrieval.hits, .top_score, .doc_refs[], .scores[],
   │  │     │                                                                 gg.retrieval.tenant_scoped=true (namespace from principal), gg.retrieval.empty, gg.retrieval.degraded_mode
   │  │     ├─ [CLIENT] embeddings <model>                      model-gw      gen_ai.usage.input_tokens
   │  │     ├─ [CLIENT] search grain-kb-v3 (lexical)             Postgres      db.system.name=postgresql, db.operation.name=SELECT (FTS, RLS)
   │  │     ├─ [CLIENT] query grain-kb-v3 (dense)                Pinecone      gg.vectorstore.adapter=pinecone, db.operation.name=query, gg.vectorstore.read_units, gg.vectorstore.degraded; namespace pseudonym never an attribute
   │  │     └─ [INTERNAL] gg.rerank                                            gg.rerank.model, gg.rerank.in, gg.rerank.out
   │  ├─ [INTERNAL] gg.graph.node act (step=3)
   │  │  └─ [INTERNAL] execute_tool get_bin_readings            grain-advisor gen_ai.tool.name, gen_ai.tool.call.id, gen_ai.tool.type=function,
   │  │     │                                                                 gg.tool.outcome, gg.tool.side_effect=read|write
   │  │     ├─ [INTERNAL] gg.guardrail.check tool               guardrails    (argument policy / tenant scope)
   │  │     └─ [CLIENT] tools/call get_bin_readings             mcp client    mcp.method.name=tools/call, mcp.session.id, jsonrpc.request.id
   │  │        └─ [SERVER] tools/call get_bin_readings          mcp-gateway   (traceparent via params._meta)
   │  │           └─ [CLIENT] GET /v1/bins/{id}/readings        read-api      (existing tenant-scoped API; RLS)
   │  ├─ [INTERNAL] gg.graph.node propose_action (step=4)      → write tool requires approval
   │  │  └─ [INTERNAL] gg.approval.request                                    gg.approval.id, gg.approval.tool, gg.approval.state=pending
   │  │     (span ends; graph interrupts; checkpoint persisted; turn streams "awaiting approval")
   │  └─ [INTERNAL] gg.graph.node answer (step=5) └─ [CLIENT] chat …
   ├─ [INTERNAL] gg.guardrail.check output (per buffered sentence)          structured-output ⑫, groundedness ⑬, output-safety ⑭ (README R18)
   └─ [INTERNAL] gg.stream.sse                                                gg.copilot.ttft_validated_ms, gg.stream.chunks, gg.stream.client_abort
```

**Streaming and TTFT (README R18).** Before validation only progress and tool events stream. Answer text is buffered and released per sentence only after the ⑫/⑬/⑭ checks pass. **TTFT in this document always means time to first *validated* token** delivered to the client over the BFF SSE endpoint (`Last-Event-ID` resume); run/approval state uses the GraphQL subscription `AdvisorRun`. Provider time-to-first-chunk (`gen_ai.response.time_to_first_chunk`) is recorded separately as a diagnostic, never as the user SLI. Guard and embedding/reranker models on this path run on CPU (README R21), so their spans never wait on a GPU.

**Model gateway call** (inside every `chat` span):

```
[CLIENT] chat claude-<ver>              grain-advisor → model-gw   gen_ai.operation.name=chat, gen_ai.provider.name, gen_ai.request.model
└─ [SERVER] POST /v1/chat                model-gw                 gg.route.decision=claude|vllm|refuse, gg.route.reason,
   │                                                              gg.budget.state=ok|soft|hard, gg.cost.usd, gg.price_table.version
   │                                                              (no answer or semantic cache exists — README R20; provider prompt
   │                                                               caching is reported only via cache_read/cache_write token counts)
   ├─ [CLIENT] chat claude-<ver>  (attempt 1)                     http.request.resend_count=0, error.type=overloaded|rate_limited|timeout
   └─ [CLIENT] chat claude-<ver>  (attempt 2) / chat <vllm-model>  http.request.resend_count=1 | gg.route.fallback_from=claude
                                                                  gen_ai.response.model, gen_ai.response.id, gen_ai.response.finish_reasons,
                                                                  gen_ai.usage.{input,output,cache_read.input,cache_write.input}_tokens,
                                                                  gen_ai.response.time_to_first_chunk
```

**Approval decision** is a separate trace: `POST /v1/advisor/proposals/{id}/decision` (README R15; `If-Match: version`) → `gg.approval.decide` → resume `invoke_agent` → `execute_tool` (write). It has a **span link** to the `gg.approval.request` span context stored on the approval row, with `gg.approval.wait_ms` and `gg.approval.decision=approved|rejected|expired`.

**Online eval** is a separate trace: the `ai-eval-worker` consumes `greenguard.ai.interaction.completed.v1` (grain-advisor outbox, key `tenant_id:turn_id`, IDs only; README R25) → `gg.eval.run` with a span link to the original `chat` span (from the `traceparent` stored on the outbox row). It processes one tenant per transaction and calls the judge through model-gateway **with that tenant's job-scoped token**, so the tenant's data-routing policy applies (`self_hosted_only` → vLLM judge or skip, recorded as `outcome=skipped_policy`). Human review and dataset reuse require the tenant's `eval_review = true`. It emits a `gen_ai.evaluation.result` log event with the original `trace_id`/`span_id` and `gen_ai.response.id`.

### 1.3.2 ML scoring batch (Kafka consumer, I1–I5)

```
[CONSUMER] process greenguard.telemetry.recorded.v1    ml-scoring   messaging.system=kafka, messaging.batch.message_count,
│                                                                   messaging.consumer.group.name, gg.batch.partitions,
│                                                                   links → origin traceparents of events (cap 32; gg.links.dropped)
├─ [INTERNAL] gg.inbox.dedupe                                        gg.inbox.duplicates
├─ [INTERNAL] gg.features.window                                     gg.feature_view, gg.features.missing, gg.features.stale
│                                                                   (window state in greenguard_ml, owned by ml-scoring; README R2)
├─ [INTERNAL] gg.model.predict                                       gg.model.name, gg.model.version, gg.ml.cohort=champion|canary
├─ [INTERNAL] gg.model.predict (shadow)                              gg.shadow=true → ml_shadow_predictions table ONLY (README R8)
├─ [INTERNAL] gg.db.write                                            ml_predictions rows + outbox ml.prediction.v1 (material change only,
│                                                                   champion/canary cohorts only) + ml.scored_through.v1 watermark,
│                                                                   same tx as inbox mark (README R9)
└─ [INTERNAL] gg.offset.commit                                       (after the batch's effects, per invariant)
```

Inputs are exactly the README R3 topics: `greenguard.telemetry.recorded.v1` (sensor values), `greenguard.inventory.device.v1`, `greenguard.inventory.lot.v1`, `greenguard.inventory.facility.v1`, `greenguard.risk.assessment.v1` and `greenguard.risk.assessment_invalidated.v1` (lot join and verdict for comparison only). Each input consumer has its own `[CONSUMER]` root with the same shape. ML output is advisory only (README R7): no span or event from ml-scoring alters a risk-engine alert.

Scheduled jobs each get one root trace: forecast run, drift job, backtest job, and training/QLoRA job (a K8s Job). The `mlflow.run_id` is a span attribute, and the MLflow run stores the `trace_id` as a tag, so each side links to the other.

## 1.4 Attribute schema: where each datum goes

| Datum | Span attribute | Metric label | Log field | Content store |
| --- | --- | --- | --- | --- |
| tenant ID | `gg.tenant.id` (ADR-0004) | **Never** | yes (structured metadata, not a Loki stream label) | row key + RLS |
| user ID | `enduser.pseudo.id` (HMAC, per-env key) | never | pseudonym only | yes |
| conversation / thread | `gen_ai.conversation.id` | never | yes | yes |
| model requested/served | `gen_ai.request.model` / `gen_ai.response.model` | yes, **bounded enum from routing config**; unknown → `_OTHER` | yes | — |
| provider | `gen_ai.provider.name` (`anthropic`, `aws.bedrock` only if the optional Bedrock channel is enabled, `vllm`, `mock`) | yes | yes | — |
| operation | `gen_ai.operation.name` | yes | yes | — |
| agent / node | `gen_ai.agent.name`, `gg.graph.node` | yes (registry, ≤ 30 nodes) | yes | — |
| tool | `gen_ai.tool.name` | yes (MCP registry, ≤ 40) | yes | args/result |
| tokens, cost | `gen_ai.usage.*`, `gg.cost.usd` | as metric **values** | — | ledger row |
| route decision/reason | `gg.route.decision`, `gg.route.reason` | yes (enums) | yes | — |
| retry | `http.request.resend_count`, `error.type` | `error.type` (bounded) | yes | — |
| guardrail | `gg.guardrail.{stage,rule,action,blocked}` | stage, rule (registry ≤ 50), action | yes (no matched text) | matched span offsets only |
| retrieval docs | `gg.retrieval.doc_refs` (ID@version), `gg.retrieval.scores` | — | — | chunk text |
| prompt/completion text | `gg.content.ref`, `gg.content.hmac` (HMAC-SHA256, per-tenant key; README R20) | never | never | **yes (encrypted, grain-advisor only)** |
| eval scores | event `gen_ai.evaluation.result` | value in histogram, label `gen_ai.evaluation.name` | yes | judge rationale |
| plan tier | `gg.plan.tier` | yes (`free\|pro\|enterprise`) | yes | — |
| model version (ML) | `gg.model.version` | yes (only the ≤ 3 live versions per model) | yes | — |
| device/bin/site IDs | yes | **never** | yes | — |
| canary | `gg.canary=true`, `service.version` | `service_version` (≤ 2 live) | yes | — |

**Enforcement is three layers of defence.**

1. The SDK wrapper `greenguard_otel.genai` has a typed attribute builder with an allowlist. A `ContentStrippingSpanProcessor` drops `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.retrieval.query.text` and `gen_ai.retrieval.documents` unless `GG_ENV=local`.
2. The agent collector's `attributes/delete` and `redaction` processors apply the same deny list, plus a blocked-value regex for emails, phone numbers and card-like numbers.
3. The metrics pipeline runs a `transform` processor that drops every label outside the per-metric allowlist, and Prometheus sets `sample_limit` and `label_limit` per scrape.

**Cardinality budget:** at most 60k active series for the whole AI layer in one cell. It is checked by a Prometheus query in CI against the staging snapshot, and by the alert `GGAIMetricCardinalityHigh`.

## 1.5 Metrics catalogue

Prometheus names come from OTLP translation (dots become underscores, and unit/`_total` suffixes are added). Pin the Prometheus `otlp.translation_strategy` so names are stable.

| Metric (OTel name → Prometheus) | Type | Labels (complete list) | Emitted by |
| --- | --- | --- | --- |
| `gen_ai.client.operation.duration` → `gen_ai_client_operation_duration_seconds` | histogram | operation, provider, request_model, response_model, error_type, gg_route | model-gw |
| `gen_ai.client.operation.time_to_first_chunk` → `…_time_to_first_chunk_seconds` | histogram | provider, request_model, gg_route | model-gw |
| `gen_ai.client.operation.time_per_output_chunk` | histogram | provider, request_model | model-gw |
| `gen_ai.client.inference.usage.input_tokens` / `.output_tokens` / `.cache_read.input_tokens` / `.cache_write.input_tokens` | histogram (per semconv) | provider, request_model, operation | model-gw |
| `gg.llm.tokens` → `gg_llm_tokens_total` | counter | provider, model, direction=input\|output\|cache_read\|cache_write, gg_plan_tier | model-gw (cheap rate queries) |
| `gg.llm.cost` → `gg_llm_cost_usd_total` | counter | provider, model, gg_route, gg_plan_tier, cost_source=list_price\|gpu_amortized | model-gw |
| `gg.llm.requests` → `gg_llm_requests_total` | counter | provider, model, gg_route, outcome=ok\|error\|refused\|budget_exhausted, error_type | model-gw |
| `gg.llm.retries` → `gg_llm_retries_total` | counter | provider, error_type | model-gw |
| `gg.llm.fallbacks` → `gg_llm_fallbacks_total` | counter | from_route, to_route, reason | model-gw |
| `gg.llm.budget.remaining_ratio` | gauge | scope=global\|plan_tier | model-gw |
| `gg.llm.circuit.state` | gauge (0/1/2) | provider | model-gw |
| `gg.model_gateway.queue.depth` | gauge | route | model-gw (**KEDA trigger**) |
| `gen_ai.server.time_to_first_token`, `gen_ai.server.request.duration` + vLLM native `vllm:*` | histogram | model | vLLM |
| `gg.gpu.seconds` → `gg_gpu_seconds_total` | counter | model, node_pool | DCGM exporter + recording rule |
| `gg.copilot.ttft_validated` → `gg_copilot_ttft_validated_seconds` | histogram (time to first **validated** token at the BFF SSE endpoint, README R18) | agent, gg_route, gg_plan_tier | grain-advisor / BFF |
| `gg.copilot.turn.duration` | histogram | agent, outcome | grain-advisor |
| `gg.copilot.tasks` → `gg_copilot_tasks_total` | counter | agent, outcome=success\|partial\|failed\|refused\|abandoned\|awaiting_approval | grain-advisor |
| `gg.copilot.feedback` | counter | agent, rating=up\|down | grain-advisor |
| `gen_ai.invoke_agent.duration`, `.tool_calls`, `.inference_calls` | histogram | agent | LangGraph handler |
| `gg.agent.node.duration` | histogram | agent, node | LangGraph handler |
| `gg.agent.steps` | histogram | agent | LangGraph handler |
| `gg.agent.recursion_limit_hits` | counter | agent | LangGraph handler |
| `gen_ai.execute_tool.duration` | histogram | tool, error_type | grain-advisor |
| `gg.agent.tool_calls` → `gg_agent_tool_calls_total` | counter | tool, outcome=success\|error\|timeout\|denied\|approval_required | grain-advisor |
| `mcp.client.operation.duration`, `mcp.server.operation.duration` | histogram | mcp_method_name, tool (gen_ai_tool_name), error_type | MCP client/server |
| `gg.agent.approvals` | counter | tool, decision=approved\|rejected\|expired | grain-advisor |
| `gg.agent.approval.wait` | histogram | tool | grain-advisor |
| `gg.agent.approvals.pending` | gauge | tool | grain-advisor |
| `gg.guardrail.decisions` → `gg_guardrail_decisions_total` | counter | stage, rule, action=allow\|redact\|block\|escalate | guardrails |
| `gg.guardrail.duration` | histogram | stage | guardrails |
| `gg.rag.duration` | histogram | index, phase=embed\|search\|rerank | knowledge-service |
| `gg.rag.top_score` | histogram | index | knowledge-service |
| `gg.rag.empty_results` | counter | index | knowledge-service |
| `gg.rag.context_tokens` | histogram | index | knowledge-service |
| `gg.rag.index.freshness` | gauge (seconds behind source) | index | knowledge-service indexer |
| `gg.vectorstore.duration` → `vectorstore_request_seconds` | histogram | op=query\|upsert\|delete\|fetch\|describe, stage=retrieve_tenant\|retrieve_public\|index\|delete\|evalgate, adapter | knowledge-service |
| `gg.vectorstore.errors` → `vectorstore_errors_total` | counter | op, code (429, 5xx, timeout, breaker_open) | knowledge-service |
| `gg.vectorstore.read_units` / `.write_units` → `vectorstore_read_units_total` / `vectorstore_write_units_total` | counter | stage (no tenant label; per-tenant units are in `kb_vector_usage`) | knowledge-service |
| `gg.vectorstore.circuit_state` → `vectorstore_circuit_state` | gauge (0 closed, 1 half-open, 2 open) | index | knowledge-service |
| `gg.vectorstore.freshness_wait` → `vectorstore_freshness_wait_seconds` | histogram (LSN wait until a write is visible) | index | knowledge-service indexer |
| `gg.vectorstore.stale_hits` → `vectorstore_stale_hit_total` | counter (hit dropped at Postgres hydration) | index | knowledge-service |
| `gg.rag.degraded` → `retrieval_degraded_total` | counter | mode=vector\|semantic\|lexical\|rerank | knowledge-service |
| `gg.eval.score` → `gg_eval_score` | histogram (with **exemplars** = trace_id) | evaluation_name (groundedness, answer_relevance, citation_validity, task_success, tool_selection), agent, mode=online\|offline\|canary | eval-worker |
| `gg.eval.runs` | counter | mode, outcome | eval-worker |
| `gg.eval.backlog` | gauge | — | eval-worker |
| `gg.content_store.writes` | counter | outcome | grain-advisor |
| `gg.ml.predictions` | counter | model, version, cohort=champion\|canary\|shadow, outcome | ml-scoring |
| `gg.ml.prediction.value` | histogram | model, version, cohort | ml-scoring |
| `gg.ml.predictions.published` | counter (material-change publishes to `ml.prediction.v1`; publish ratio for review R3) | model | ml-scoring |
| `gg.ml.scored_through.lag` → `gg_ml_scored_through_lag_seconds` | gauge (now − `ml.scored_through.v1` watermark, max over partitions) | model | ml-scoring / consumers of the watermark |
| `gg.ml.batch.duration` | histogram | model | ml-scoring |
| `gg.ml.features.missing` | counter | feature_view | ml-scoring |
| `gg.ml.features.stale` | counter | feature_view | ml-scoring |
| `gg.ml.feature_drift.psi` | gauge | model, feature (≤ 40 registered) | drift job |
| `gg.ml.prediction_drift.psi` | gauge | model, version | drift job |
| `gg.ml.shadow.agreement` | gauge (ratio) | model, champion_version, challenger_version | ml-scoring |
| `gg.ml.alert.precision` | gauge | model, version, window=7d\|28d | label job (from Stage 06 acknowledgements) |
| `gg.ml.forecast.mae` | gauge | model, version, horizon=1h\|24h\|72h | backtest job |
| `gg.ml.forecast.age` | gauge (derived from the `ml.scored_through.v1` watermark, not from row timestamps) | model | ml-scoring (tier B scheduled micro-batch) |
| `gg.ml.forecast.fresh_ratio` | gauge (partitions whose watermark is within 2 × 15 min / all partitions) | model | ml-scoring |
| `gg.ml.consumer.lag` (from Kafka exporter) | gauge | group, topic | kafka-exporter |
| `gg.training.job.duration` | histogram | pipeline, outcome | training jobs (Pushgateway **not** used; job exports via OTLP before exit) |

Histogram buckets: TTFT uses 0.1–30 s, exponential; token histograms use the semconv-advised boundaries. Where Prometheus native histograms are enabled, native histograms are preferred for latency.

## 1.6 Grafana dashboards (code in `infra/observability/grafana/dashboards/ai/`)

| Dashboard | Key panels | Data source |
| --- | --- | --- |
| AI-01 LLM cost & tokens | $/h by model/route; tokens in/out/prompt-cache read/write; prompt-cache token ratio (provider prompt caching only; no answer/semantic cache exists, R20); cost per successful task; burn vs the $300/month product cap and, separately, the $100/month eval cap with the ≤ $12 per-run T2 limit (R22); `budget_exhausted` 429 rate; GPU amortized $/1k tokens vs Claude list price | Prometheus; **plus an admin-only panel "top tenants by cost" from the billing read model** (Postgres datasource, ops role, audited). Never from Prometheus. |
| AI-02 Latency & TTFT | user TTFT p50/p95/p99 vs SLO; provider TTFT; time-per-chunk; gateway overhead = e2e − provider; queue depth; vLLM cold starts | Prometheus + exemplars → Tempo |
| AI-03 Agent execution | steps per task; node duration heatmap; recursion-limit hits; task outcome mix; approvals pending/wait/decision | Prometheus, Tempo TraceQL |
| AI-04 Tool reliability | per-tool success/error/timeout/denied; MCP p95; top failing tools | Prometheus |
| AI-05 Guardrails | decisions by stage/rule/action; block rate vs baseline; false-positive reports (from feedback) | Prometheus, Loki |
| AI-06 RAG quality | retrieval latency by phase; top-score distribution; empty-result rate; context tokens; index freshness; Pinecone query/upsert latency and errors, read-unit and write-unit spend per stage, circuit state, freshness wait, stale hits, degraded modes; offline recall@k/MRR from last I9 run | Prometheus, eval results table |
| AI-07 Eval scores | groundedness/relevance/citation validity trend by agent and version; canary vs stable; eval backlog; worst traces (exemplar links) | Prometheus, Loki events |
| AI-08 ML model health | prediction and feature drift PSI; shadow-vs-champion agreement; alert precision 7d/28d; forecast MAE by horizon; forecast freshness; consumer lag; features missing/stale | Prometheus |
| AI-09 GPU & capacity | GPU util/memory (DCGM), KV-cache usage (`vllm:*`), node-pool size, scale-up events, Spot interruptions, Karpenter provisioning and insufficient-capacity events | Prometheus |
| AI-10 AI SLO overview | error-budget remaining and burn rate for each SLO in §1.7 | Prometheus recording rules (Sloth-generated or hand-written) |

Tempo datasource settings: `tracesToLogs` (trace_id → Loki), `tracesToMetrics`, and service graph. Loki derived field: `trace_id` → Tempo. The Tempo metrics-generator is disabled in favour of O-D5.

## 1.7 SLOs and error budgets (28-day rolling)

| SLO | SLI (good / valid) | Target | Measurement point | Budget policy |
| --- | --- | --- | --- | --- |
| Copilot availability | turns ending in an answer, an explicit safe refusal or a documented degraded-mode answer / all turns except client-cancelled | **99.5%** | BFF | Burn ≥ 2× over 6h freezes prompt/model promotions. |
| Copilot validated TTFT | turns whose **first validated token** (README R18: after ⑫/⑬/⑭ pass) reaches the client in ≤ 5 s / turns that produced a validated token | **p95 ≤ 5 s (provisional)**; final target set from I12 measurement and owner decision §8 Q13 | BFF SSE endpoint | Cold-GPU generation waits count against the budget, which is the reason for fallback routing. |
| Turn completion latency | turns completed < 20 s (≤ 3 tool calls) / completed turns | 95% | BFF | — |
| Task success | tasks with outcome=success (judge ≥ threshold or explicit 👍, and not 👎) / sampled evaluated tasks | **≥ 85%** (slow SLI, weekly review) | eval-worker | Below target blocks the I11 adapter promotion. |
| Groundedness floor | sampled answers with groundedness ≥ 0.8 **and** all citations valid / sampled answers | **≥ 95%**; hard floor 90% daily | eval-worker | Below 90% pages and triggers automatic rollback of the last prompt/model change (§2.5). |
| Knowledge retrieval (vector leg) | retrieval calls whose vector leg answers within 150 ms and without error / retrieval calls for tenants with a knowledge base (a call served lexical-only counts as bad here but as good for copilot availability because it is a documented degraded-mode answer) | **p95 ≤ 150 ms and ≥ 99.5% good (UNMEASURED; set from I13 measurement)** | knowledge-service | Burn pages `GGVectorStoreBurn`; the lexical fallback keeps answers flowing while it burns. |
| Tool reliability | MCP calls with success / calls excluding `denied` and `approval_required` | 99.0% | grain-advisor, mcp-gateway | — |
| Forecast freshness | 1-min samples in which every ml-scoring partition's `ml.scored_through.v1` watermark is < 2 × 15 min old / samples | **99%** | watermark consumer (README R9) | — |
| Anomaly scoring latency | `telemetry.recorded.v1` events covered by the `ml.scored_through.v1` watermark < 60 s after publish / events | 99% | watermark vs event publish time | Ties into the Stage 04/05 pipeline SLO. |
| Cost guard (budget, not SLO) | monthly product LLM spend ≤ $300 hard cap (product Claude; eval Claude has its own $100 cap) (README R22), tracked daily | 100% | model-gw (`greenguard_ai_usage`, authoritative) | Soft cap routes to vLLM; hard cap returns **429 `budget_exhausted` with `Retry-After`**. |

Burn-rate alerts use the multiwindow method: page at 14.4× over 1h and 5m, page at 6× over 6h and 30m, ticket at 1× over 3d. Slow SLIs (task success, groundedness) use daily and weekly windows, because a 5-minute burn on sampled judge output is noise.

## 1.8 Alerts and runbooks

These go in `infra/observability/rules/ai-*.rules.yml`, each with a runbook in `docs/runbooks/ai-*.md`, following the `saga-alerts.rules.yml` convention.

| Alert | Expression (sketch) | Sev | Runbook: first actions |
| --- | --- | --- | --- |
| GGCopilotAvailabilityBurn | multiwindow on `gg_copilot_tasks_total{outcome=~"failed"}` + 5xx | page | `ai-copilot-availability.md`: check provider circuit, gateway errors by `error_type`, recent rollout; roll back. |
| GGVectorStoreBurn | vector-leg SLI burn, or `vectorstore_circuit_state == 2` for 2m, or 429 ratio > 10% | page | `ai-vectorstore.md`: check Pinecone status page and our 429 counters; confirm lexical-only mode is serving (`retrieval_degraded_total{mode="vector"}`); check per-tenant read-unit budgets and monthly spend alarm; verify no Pinecone backup or collection exists. |
| GGVectorStoreSpend | monthly read+write-unit spend projection > 50% or > 90% of the planned Pinecone bill | ticket | `ai-vectorstore-cost.md`: top stages; per-tenant `kb_vector_usage`; reindex or eval-gate runs. |
| GGCopilotTTFTBurn | TTFT SLI burn | page | `ai-ttft.md`: compare provider vs gateway overhead; queue depth; vLLM cold starts; force Claude route. |
| GGLLMProviderDegraded | `gg_llm_circuit_state{provider="anthropic"} == 2` for 2m, or 429/529 ratio > 20% | page | `ai-provider-outage.md`: confirm the provider status page; fallback to vLLM is automatic; scale the GPU pool min=1; announce degraded mode. |
| GGLLMSpendAnomaly | `sum(rate(gg_llm_cost_usd_total[1h]))*24 > 1.5 × daily budget` | page | `ai-cost-spike.md`: top model/route; top tenants from ledger; loop detection (steps histogram); enable hard cap. |
| GGBudgetHardCapReached | `gg_llm_budget_remaining_ratio{scope="global"} <= 0` | page | same |
| GGAgentLoop | `rate(gg_agent_recursion_limit_hits_total[15m]) > 0.05/s` or p99 steps > 12 | ticket | `ai-agent-loop.md` |
| GGToolFailureRate | per tool error ratio > 5% for 10m | ticket | `ai-tool-failures.md`: check read-api/MCP server health, auth token, schema drift. |
| GGGuardrailBlockSpike | block rate > 3× 7-day baseline for 15m | ticket (page if `rule=~"prompt_injection\|cross_tenant"`) | `ai-guardrail-spike.md`: attack vs false positive; sample traces (kept by tail sampling). |
| GGCrossTenantGuardrailHit | any `rule="cross_tenant"` block | page | `ai-cross-tenant.md`: security incident procedure. |
| GGGroundednessBelowFloor | daily ratio < 0.90 | page | `ai-groundedness.md`: diff by version; auto-rollback status; RAG index freshness. |
| GGEvalBacklog | `gg_eval_backlog > 5000` for 30m | ticket | `ai-eval-backlog.md` |
| GGRAGIndexStale | `gg_rag_index_freshness_seconds > 3600` | ticket | `ai-rag-stale.md` |
| GGRAGEmptyResults | empty ratio > 20% | ticket | same |
| GGApprovalBacklog | pending > 50 or oldest > 24h | ticket | `ai-approvals.md`: expire per policy; notify approvers. |
| GGContentStoreWriteFailures | any failures for 5m | page | `ai-content-store.md`: turns fail closed (no content → no answer), per O-D6. |
| GGFeatureDrift | PSI > 0.25 for any feature over 24h | ticket | `ml-drift.md`: data pipeline vs real-world shift; retrain decision. |
| GGPredictionDrift | PSI > 0.2 | ticket | same |
| GGShadowDisagreement | agreement < 0.9 for 6h | ticket | `ml-shadow.md`: block challenger promotion. |
| GGAlertPrecisionDrop | 7d precision < 0.7 or −15 pts vs 28d | ticket | `ml-alert-precision.md` |
| GGForecastStale | `gg_ml_scored_through_lag_seconds > 1800` for 30m (watermark, README R9) | page | `ml-forecast-stale.md`: scheduled micro-batch failures, input lag, MLflow reachability (locally cached model continues). |
| GGScoringLag | consumer lag seconds > 120 for 10m | page | `ml-scoring-lag.md` |
| GGGPUNodeNotReady / GGVLLMColdStartSlow | scale-up > 10 min (the provisional cold-start budget, §2.2), or a GPU pod Pending > 5 min | ticket | `ai-gpu-capacity.md`: g6 Spot insufficient-capacity (Karpenter events/metrics); widen g6 sizes and AZs; On-Demand NodePool only if the §2.2 fallback policy and the GPU budget allow; keep Claude route. |
| GGSandboxAMIStale | any sandbox node running an AMI older than 45 days, or not on the approved list | ticket | `ai-sandbox-ami.md`: run the §2.2 AMI pipeline; do not extend the age limit without an owner decision. |
| GGAIMetricCardinalityHigh | `count({__name__=~"gen_ai_.*\|gg_.*"}) > 60000` | ticket | `ai-cardinality.md` |
| GGTelemetryPipelineDrop | collector `otelcol_exporter_send_failed_spans` / `otelcol_processor_refused_*` > 0 | ticket | `ai-otel-pipeline.md` |

## 1.9 Sampling strategy

- **Head:** keep ADR-0004's `ParentBased(TraceIdRatio)` with ratio 1.0 on copilot services, so the tail sampler sees every trace. Copilot volume is low relative to ingest. Telemetry ingest keeps its own low ratio.
- **`gg.eval.sampled`** is decided at the start of the turn as `hash(trace_id) < eval_rate` (5% by default, 100% in canary) and set on the root span. The same decision tells the eval worker to judge the turn, so every judged turn's trace is kept.
- **Tail (gateway collector) policies,** in order:

| Policy | Rule |
| --- | --- |
| errors | status ERROR anywhere |
| guardrail | `gg.guardrail.action` in (block, escalate) |
| approval | any `gg.approval.*` span |
| eval | `gg.eval.sampled=true` |
| canary | `gg.canary=true` |
| slow | latency > 10 s |
| expensive | `gg.cost.usd > 0.05` (numeric attribute on the root, aggregated by the workflow span at end) |
| fallback | `gg.route.fallback_from` present |
| ML | ML scoring batch errors, or `gg.features.missing > 0` |
| baseline | probabilistic 10% of copilot traces and 1% of ML batches |

- `decision_wait = 60s` for the copilot pipeline and 10s for ML. The collector is sized with `num_traces` and `expected_new_traces_per_sec`. A turn that runs longer than decision_wait is split by design: the root is kept because late spans are sampled per policy and the "slow" rule carries it. This is documented and tested (OBS-E07).
- Retention: Tempo 14 days, Loki 14 days (30 days for audit-relevant security events, routed to the existing audit path instead), Prometheus 35 days (28-day SLO windows plus margin), content store 30 days by default (tenant-configurable down to 0).

## 1.10 Linking traces to evals, and trace replay

- **Link keys:** `trace_id`, `span_id` of the `chat` span, `gen_ai.response.id`, `gg.task.id` and `gg.content.ref`. These are stored in `ai_eval_results` (tenant table, RLS), emitted as the `gen_ai.evaluation.result` log event, and attached as exemplars on `gg_eval_score`. Grafana jumps from a low score to its trace (exemplar) and from a trace to its eval events (Loki `trace_id`).
- **Replay** (`gg-replay` CLI and eval-harness mode, owned by I9 and consuming I12 data):
  - It reads the turn through grain-advisor's content API with a tenant-bound token (README R23; no other service stores content) and reconstructs: inputs, system prompt version, retrieved `doc_refs@version`, recorded tool results, and the route and model.
  - It re-executes against a candidate model or prompt with **tools stubbed from the recording** and write tools disabled, so there are no side effects and no approvals.
  - It emits new traces with `gg.replay.of=<original trace_id>` and a span link to the original.
  - Replay runs under the owning tenant's context. Using tenant content in the *global* regression set requires a scrub + consent flag (the data-governance decision is shared with I9/I10).
- A replay whose retrieval index version no longer exists falls back to the recorded chunk text, which is flagged `gg.replay.fidelity=degraded`.

## 1.11 Edge cases and failure modes (observability)

| ID | Situation | Expected behaviour | Test |
| --- | --- | --- | --- |
| OBS-E01 | Collector down / OTLP export failing | App keeps serving; BatchSpanProcessor drops at queue limit; `otelcol_*` and SDK drop counters rise; no request latency impact (> 1 ms p99 regression fails test) | kill collector during k6 run |
| OBS-E02 | Prometheus down | Apps unaffected; KEDA vLLM trigger fails → KEDA `fallback.replicas: 0` (a metrics outage must not pin an L4; the route serves from Claude); Alertmanager dead-man's switch (Watchdog) pages externally | chaos |
| OBS-E03 | Streaming response aborted by client mid-stream | Span ends with `gg.stream.client_abort=true`, status UNSET (not error); tokens actually generated still billed in ledger; task outcome `abandoned` | unit + e2e |
| OBS-E04 | Provider returns usage only at stream end and stream breaks | Tokens estimated with tokenizer; `gg.usage.estimated=true`; ledger row marked estimated; reconciled against the provider usage/cost report daily | unit |
| OBS-E05 | Retries: attempt 1 times out after partial tokens | Each attempt own CLIENT span with `http.request.resend_count`; tokens and cost counted per attempt (you pay for them); TTFT metric records first successful chunk to user | unit |
| OBS-E06 | Fallback Claude → vLLM mid-turn | Two `chat` spans with different `gen_ai.provider.name`; `gg_llm_fallbacks_total`; route label on TTFT | chaos C1 |
| OBS-E07 | Turn longer than tail `decision_wait` | Late spans arrive after decision; the policy keeps them if the root is kept (the collector's decision cache `decision_cache.sampled_cache_size` is sized for it); test asserts complete trace for a 90 s turn | integration |
| OBS-E08 | Approval waits 3 days | Separate trace with link; `gg.agent.approval.wait` histogram buckets to 7 d; expired at policy limit | e2e |
| OBS-E09 | Kafka batch of 500 events, each with its own origin traceparent | ≤ 32 links; remainder counted `gg.links.dropped`; per-event trace continuity preserved via outbox `traceparent` on produced events (ADR-0004) | unit |
| OBS-E10 | Model name not in routing registry (provider returns new snapshot name) | Metric label becomes `_OTHER`; span keeps exact `gen_ai.response.model`; ticket alert `GGUnknownModelLabel` | unit |
| OBS-E11 | Developer adds a `tenant_id` label | CI metric-catalogue test fails; collector transform drops it in prod; `GGAIMetricCardinalityHigh` | CI |
| OBS-E12 | Prompt text leaks into exception message / log | Logging filter redacts known content fields; exceptions recorded with `exception.type` only for GenAI spans (`exception.message` stripped); Loki canary query for seeded "CANARY-PII-" string must return 0 | canary test |
| OBS-E13 | Content store unavailable | Turn fails closed with degraded message (no unrecoverable, unaudited answer); spans still exported; alert | chaos |
| OBS-E14 | Eval judge (LLM) down or rate-limited | Eval backlog grows; turns unaffected; SLI computed over evaluated subset with `gg_eval_runs_total{outcome="skipped"}`; alert on backlog, not on SLO | chaos |
| OBS-E15 | Judge disagreement / judge drift | Judge model version is a label on `gg.eval.runs`; weekly human-labelled calibration set; judge changes are versioned like prompts | I9 |
| OBS-E16 | Clock skew between pods | Durations measured with monotonic clocks within a process; cross-service latency from span timestamps flagged if negative; NTP on nodes | unit |
| OBS-E17 | Price table changes mid-day | `gg.price_table.version` on span and ledger; costs never recomputed retroactively in metrics; billing recalculation is an explicit ledger job | unit |
| OBS-E18 | Prompt-cache tokens | `cache_read`/`cache_write` counted separately; cost uses separate rates; the cache hit ratio panel | unit |
| OBS-E19 | vLLM has no per-request cost | Amortized: `gg_gpu_seconds_total × hourly_rate / tokens` over 1 h window; `cost_source=gpu_amortized`; idle GPU time attributed to "platform" not tenants | recording rule test |
| OBS-E20 | Tenant deletion (O2, README R26) | Per-tenant DEK destroyed (crypto-shred of `ai_interaction_content` and checkpoint blobs) plus hard delete; per-tenant HMAC key destroyed so `gg.content.hmac` values become unlinkable; `ai_usage_ledger` retained per billing law with tenant pseudonymised after retention; traces age out ≤ 14 d (documented, not erased individually); deletion ledger replayed after any restore | IT-05 delete → restore → zero (§2.9.1) |
| OBS-E21 | Guardrail blocks on a trace that is then sampled out | Impossible by policy (guardrail policy keeps it); metric counted regardless | integration |
| OBS-E22 | Span attribute size (big `doc_refs`) | Attribute count/length limits set (`OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT=128`, value length 1024); doc_refs truncated to top-k with `gg.retrieval.doc_refs.truncated` | unit |
| OBS-E23 | MCP server in another process without trace context | `_meta.traceparent` propagated; if absent, server starts a root span and records `gg.trace.orphan=true`; never fabricates parent | unit |
| OBS-E24 | Metric exemplars contain trace IDs for dropped traces | Exemplars recorded only for spans with `sampled` flag; Grafana link may 404 for tail-dropped → acceptable, documented; eval-sampled exemplars always resolve | integration |
| OBS-E25 | Semconv rename upstream | Only mapping module changes; conformance test pinned to commit fails first; dashboards query `gg_*` stable names where possible | CI |
| OBS-E26 | ML drift job finds reference histogram missing (new model without artifact) | Drift gauge absent → `absent()` ticket alert; promotion gate requires reference artifact | unit |
| OBS-E27 | Delayed labels (alert ack days later) | Precision computed on matured window only (alerts older than 72 h); labelled-fraction exported; precision not shown when labelled fraction < 30% | unit |
| OBS-E28 | Tempo query across tenants by operator | Operators can see tenant attributes (ADR-0004 accepted); access via Grafana RBAC team `sre`; Tempo/Loki query audit logs; no customer has Grafana access | RBAC test |

## 1.12 Tenant-isolation tests (I12)

| ID | Test |
| --- | --- |
| OBS-T01 | Metric scrape of every AI service after a two-tenant workload has **no label value equal to any tenant, user, device, bin, thread or conversation ID** (the seeded IDs are grepped over `/metrics` and Prometheus `series` API). |
| OBS-T02 | Loki stream labels contain no tenant ID; `{service=~".+"} \|= "<tenant-A-id>"` finds only structured-metadata occurrences. |
| OBS-T03 | Content store (`grain-advisor.ai_interaction_content`, the only content store; model-gateway has none): tenant B session (`set_config('app.tenant_id', B, true)`) cannot read tenant A `gg.content.ref` rows (forced RLS); a runtime role without the tenant set gets zero rows. |
| OBS-T04 | Replay tool reads content only through grain-advisor's API with a tenant-bound token; it refuses a `content.ref` of another tenant, and refuses to run without tenant context. A catalogue test asserts `greenguard_ai_usage` has no prompt/response content column. |
| OBS-T05 | `ai_usage_ledger` and `ai_eval_results`: two-tenant RLS + composite FK tests; billing consumer inbox idempotency (duplicate event → one charge). |
| OBS-T06 | Crypto-shred: after tenant A deletion, A's content rows are undecryptable and B's still decrypt. |
| OBS-T07 | Seeded canary PII string in a prompt never appears in Tempo, Loki or Prometheus in staging profile (search after 5 min). |
| OBS-T08 | No final-answer or semantic cache exists (README R20; a config/catalogue test fails if one is added). Provider prompt-cache prefixes: any tenant segment starts with a per-tenant secret nonce, vLLM requests carry a per-tenant `cache_salt`; tenant B's identical prompt reports `cache_read_input_tokens = 0` for tenant A's tenant segment. Embedding caches are tenant-keyed. `gg.content.hmac` of identical content differs across tenants. |
| OBS-T09 | Grafana admin "top tenants by cost" panel is not visible to the `viewer` role; datasource user is read-only and audited. |
| OBS-T10 | Conformance: every emitted `gen_ai.*` attribute and metric exists in the pinned semconv registry; every `gg.*` attribute is in `packages/otel-py/attributes.yaml`. |

## 1.13 Acceptance gates (I12 done means all of these, with evidence under `evidence/`)

| Gate | Measurable criterion |
| --- | --- |
| I12-G1 | One copilot turn in staging produces one trace containing every span type in §1.3.1 (workflow, guardrail ×3, agent, ≥ 3 nodes, retrieval + embeddings + search, `chat` + provider client, `execute_tool` + MCP client + MCP server + read-api) and a linked approval trace and linked eval trace. Screenshot + TraceQL export. |
| I12-G2 | For 1,000 mixed turns: sum of `gg_llm_tokens_total` equals the sum of ledger tokens exactly; ledger cost equals the recomputation from the price table; the mock provider's own token count matches within 0 (mock) / ≤ 1% vs the Anthropic usage report (real slice). |
| I12-G3 | OBS-T01..T10 pass in CI. The cardinality test passes, with < 60k series after the Tier 1 AI load profile. |
| I12-G4 | All §1.7 SLOs have recording rules plus burn alerts. `promtool test rules` covers each alert firing and resolving. Each alert links an existing runbook. |
| I12-G5 | Fault injection: provider 529 storm → `GGLLMProviderDegraded` fires in ≤ 3 min; spend spike → `GGLLMSpendAnomaly` in ≤ 10 min; groundedness drop (poisoned KB fixture) → `GGGroundednessBelowFloor` and canary rollback. |
| I12-G6 | Tail sampling keeps 100% of error, guardrail-block, approval, eval-sampled and canary traces (seeded 10k-trace test, counted in Tempo). Baseline kept ratio 10% ± 2%. |
| I12-G7 | Instrumentation overhead: ≤ 2 ms p95 added to gateway per call, ≤ 3% CPU (A/B with exporter disabled). |
| I12-G8 | Dashboards AI-01..AI-10 provisioned from Git; the linter and catalogue cross-check pass (every PromQL metric and label exists). |
| I12-G9 | ML: drift, shadow agreement, precision and forecast freshness gauges present for every live model; the promotion gate refuses a model without a drift reference artifact. |

## 1.14 Senior topics covered (I12)

GenAI semconv (Development-status risk management), span modelling across async boundaries with links, tail sampling architecture (load-balanced two-tier), cardinality engineering, SLO/error-budget design for probabilistic systems (slow SLIs, judged SLIs), LLM cost accounting (cache tokens, amortized GPU cost, price-table versioning), billing-grade usage ledger via outbox (vs telemetry), privacy engineering (content store, envelope encryption, crypto-shred, PII canaries), trace↔eval linking, deterministic replay, ML monitoring (drift PSI, shadow agreement, delayed labels), observability-as-code with tests.

---

# I13 — Production deployment, scale and resilience certification

## 2.1 How this links to Stages 11–14 (no duplication)

| GreenGuard stage | Owns (shared platform) | I13 adds (AI-specific only) |
| --- | --- | --- |
| 11 Observability | Collector, Prometheus, Tempo, Loki, Grafana, base SLOs, runbooks | I12 content (above) as additional pipelines, rules, dashboards |
| 12 Delivery | Terraform platform, EKS cluster, Helm library chart, Argo CD, Argo Rollouts, SBOM/Cosign, secrets, mesh | GPU and training node pools, KEDA, vLLM chart, model-artifact provenance, AI-aware AnalysisTemplates, LLM secrets |
| 13 Capacity | k6 matrix (`CAPACITY_MODEL.md`), chaos, Tier 1 certification | AI scenarios in the same k6 run; mock LLM; AI chaos experiments; AI envelope |
| 14 Recovery | Backup/restore, PITR, multi-region, incident exercises | MLflow, `greenguard_ml` window state, Pinecone KB (rebuild from Postgres), checkpoints, content store, adapters DR; deletion-ledger replay after restore (README R26) |

**Ordering rule (proposed, owner decision Q1):** if an AI stage reaches deployment before Stage 11/12 is built, it builds the *shared* component to the Stage 11/12 spec in `infra/` (for example the collector or the Helm library chart), and Stage 11/12 then adopts it. It never builds an AI-only parallel copy.

## 2.2 EKS topology

> **Status.** ADR-0024 (accepted 2026-09-29) fixes AWS/EKS as the production platform. Nothing is built: `infra/terraform`, `infra/helm`, `infra/kubernetes` and `infra/gitops` still hold only READMEs. §2.2–§2.3 are the target design, and I13 certifies nothing on EKS until the Stage 12 shared platform (Terraform AWS modules, EKS, Argo CD) exists. Until then I6 uses a local/Compose vLLM profile, and all I12 work, AnalysisTemplate logic (as scripted checks), cluster-free chaos experiments, the mock-LLM load run and the deletion/restore test run on the local/Compose (`infra/staging/compose.yaml` + `compose.ai.yaml`) or kind profile. Gates that need EKS (I13-G1, G2, G3, G9, the AZ-loss chaos C12) stay open until then. Instance types, prices and capacity below are **unverified assumptions**: I0 recomputes cost with AWS prices and I13 measures Spot capacity (ADR-0024).

| Pool | Demo (Lean, plan of record; I00 §5.1) | Full target (prod / cert) | Taints / labels | Workloads |
| --- | --- | --- | --- | --- |
| `system` | ONE small **On-Demand** EKS managed node group (one node; size per I00 §5.1) | m7i.large On-Demand, 3–6, multi-AZ | none | kube-system, **Karpenter controller** (must not run on nodes it provisions), Argo CD, KEDA, cert-manager, ESO, collectors |
| `data` | ONE **On-Demand** data node, EBS gp3, **never Spot** (size per I00 §5.1). No 3× r6i.2xlarge pool in the demo | Karpenter NodePool or managed group: r6i.2xlarge–4xlarge, On-Demand only, 3–9 | `gg/data=true:NoSchedule` | Demo: all in-cluster stateful stores on this one node (Postgres with pgvector, Strimzi Kafka, Cassandra, OpenSearch, Redis, RabbitMQ). Full target: Cassandra (K8ssandra), RabbitMQ operator if not Amazon MQ; Postgres, Redis, Kafka and OpenSearch become managed services (table below). |
| `app` | Karpenter NodePool `app`, **Spot** (m7g/m7i class, sizes per I00 §5.1; KEDA cron scales its workloads to 0 outside demo hours, 217 h/month assumed, and the schedule is off in the certification month), 1–3 | Karpenter NodePool `app`, m7i.2xlarge class, Spot / On-Demand (Spot only for burst share), 6–40 per cell | none | grain-advisor, model-gw, mcp-gateway, BFF, ml-scoring, eval-worker, existing services |
| `gpu-l4` | Karpenter NodePools `gpu-l4-spot` (higher weight) and `gpu-l4-od` (lower weight, gated, see fallback policy), **scale from 0**, NodePool `limits: nvidia.com/gpu: 1` (never more than one GPU in the demo). g6.xlarge (1× NVIDIA L4, 24 GB), g6.2xlarge allowed as the same GPU | same pools, min 0, `limits` sized per cell; `g6e`/`p4d` only on measured need (ADR-0024) | `nvidia.com/gpu=present:NoSchedule` | vLLM **generation only** (quantized 7–8B class model + LoRA adapters) and scheduled GPU eval windows (T1) |
| `train` | Karpenter NodePool, g6.4xlarge (1× L4) **Spot**, scale from 0, `limits: nvidia.com/gpu: 1` (shares the demo GPU budget with `gpu-l4`; a training Job and vLLM do not run together) | g6.4xlarge Spot; larger g6 sizes only on measured QLoRA need, 0–1 | `gg/train=true:NoSchedule` | QLoRA Jobs (I11), batch embedding backfills |
| `sandbox` | gVisor (`runsc`) nodes from a **custom AMI**, m7i.xlarge On-Demand, **scale from 0** (a node exists only while a sandbox Job runs); EC2NodeClass pins the approved AMI ID | same AMI and pin, 1–N | `gg/sandbox=true:NoSchedule`, RuntimeClass `gvisor` | Sandboxed code/tool execution (I10). No AWS identity, no IMDS. |

**Demo infrastructure subtotal (all pools, managed lines, NAT, S3, EKS control plane, GPU hours) must stay <= $600/month (README R22; I00 §5.1 plan of record $492.92 of infrastructure lines, $593.77 in a 24x7 certification month; `cost_model.json`).** This is a hard planning limit: any change that pushes the I0 cost model past $600 is rejected or paid for by removing something. The full-target column is a design reference and is **not** costed against the demo cap.

- **GPU rules (README R21):** models needed on every turn run on **CPU in the `app` pool** (or a hosted equivalent): Prompt Guard 2 86M, a small embedding model, a small reranker, and a small quantised output-safety classifier chosen and verified in I10 (Llama Guard 4 12B does not fit an L4 and is not used). The GPU pool serves only generation, fine-tune adapters and evals, so it can be at zero without blocking guardrails or retrieval. `self_hosted_only` tenants see a bounded wait (≤ 15 min, shown in the UI) when generation needs a cold GPU.
- **Cluster shape:** demo is one single-AZ EKS cluster. No free tier is assumed: the control plane is billed per cluster-hour (list price to be confirmed in I0). Stateless pools use Spot. Prod is multi-AZ (3 AZs) with PodDisruptionBudgets and `topologySpreadConstraints` on in-cluster stateful sets.
- **Why Karpenter on standard EKS, not EKS Auto Mode:** explicit control of the GPU and sandbox NodePools, DaemonSet collectors, the DCGM exporter, and above all a **custom AMI for the sandbox pool** (I understand Auto Mode's node image is AWS-managed and does not accept custom AMIs; verify before finalising in ADR-0024 follow-up). Auto Mode is the recorded alternative for pools that need no custom AMI.
- **Managed services versus in-cluster (ADR-0024).** The contract suites are identical for both forms.

| Concern | Demo (Lean) | Staging / full target (prod) | Notes |
| --- | --- | --- | --- |
| Postgres | In-cluster Postgres with pgvector on the data node (PVC on EBS gp3); PgBouncer in-cluster. **No managed RDS in the demo.** | RDS for PostgreSQL (single-AZ staging), RDS Multi-AZ in prod | `wal_level=logical` for Debezium. **After an RDS Multi-AZ failover or restore, logical replication slots may be lost** (unverified): assume the slot is gone, re-snapshot, and rely on inbox idempotency (review R1). Outbox pruning rule below. |
| Kafka | Strimzi (KRaft) in-cluster, single broker on the data node | MSK Provisioned across 3 AZs (MSK Serverless only if it passes the ADR-0010 and Debezium requirements; unverified) | Debezium on EKS or MSK Connect; Schema Registry per ADR-0010, not Glue. In-cluster Kafka in prod is rejected: it puts a stateful quorum on Spot-adjacent capacity and adds on-call load. Revisit if MSK cost or quotas fail Stage 13. |
| Redis | In-cluster Redis on the data node (Redis is never an authority, R22) | ElastiCache, cluster mode, Multi-AZ | limiter and embedding cache only |
| Vector store (knowledge) | **Pinecone Standard, serverless, AWS us-east-1** (ADR-0029); keys in Secrets Manager, egress allow-listed for `knowledge-service` only, public TLS. Dev/CI: `opensearch` adapter or Starter | Pinecone per placement and cell, **PrivateLink (Enterprise plan, $500/month minimum, outside the demo budget) as an I13 hardening item**; BYOC only by owner decision (README §8 Q21) | Third-party processor; text never sent; region fixed at index creation |
| Search | In-cluster OpenSearch, single node on the data node (telemetry search, Stage 05d/10a, and the local `VectorStore` adapter). **No managed OpenSearch Service in the demo.** | OpenSearch Service, 3 data nodes over 3 AZs plus dedicated manager nodes (sizes at Stage 12) | telemetry search only after ADR-0029; knowledge vectors are in Pinecone |
| Object storage | S3 | S3 (+ cross-Region replication where DR needs it) | SSE-KMS, versioning |
| Cassandra, RabbitMQ | K8ssandra (single node), RabbitMQ Cluster Operator, on the data node | same, or Amazon Keyspaces / Amazon MQ if Stage 13 favours them | not on the AI critical path |

- **Pinecone hardening items (ADR-0029, I13):** (1) API keys (tenant writer, tenant reader, public reader, public curator) in AWS Secrets Manager, synced by External Secrets into `knowledge-service` pods only; never in the parser sandbox, agent pods, CI logs or developer machines; a scan asserts no other workload mounts them. (2) Egress: a NetworkPolicy (FQDN-capable policy or an egress proxy allow-list, chosen in I13) lets only `knowledge-service` reach the Pinecone data-plane and control-plane hostnames; the NAT allow-list is the second layer. (3) **PrivateLink** (Private Endpoints) replaces public TLS in production; it needs the Pinecone **Enterprise** plan ($500/month minimum, verified 2026-09-29), so it is outside the demo budget and an owner decision (README §8 Q23). (4) Spend: a monthly projection alarm at 50% and 90% (GGVectorStoreSpend) and per-tenant daily read-unit budgets. (5) A scheduled check that lists Pinecone backups and collections and alarms on any. (6) DPA, subprocessor listing and deleted-data retention confirmed before I7c.
- **Outbox pruning waits for CDC confirmation.** A relay may delete or archive an `outbox_events` row only after Debezium's confirmed flush position (the slot's `confirmed_flush_lsn`, exported as a metric) has passed that row's commit LSN, never on age alone. A Multi-AZ failover or restore can lose the logical slot, and unpruned rows are then the re-snapshot source; pruning past an unconfirmed position would lose events. After any slot loss, pruning stays paused until the re-snapshot completes and the new position passes the oldest retained row. Test: force a slot drop (chaos C9), assert no row newer than the last confirmed LSN was deleted and all rows are re-emitted with unchanged event IDs.

- **Scale-to-zero:**
  - A KEDA `ScaledObject` on the vLLM Deployment uses a Prometheus trigger `gg_model_gateway_queue_depth{route="vllm"}` plus a `cron` trigger for demo hours, with `minReplicaCount: 0`, `cooldownPeriod: 900` and **`fallback.replicas: 0`** (for every GPU scaler in every environment: a Prometheus or metrics outage must never pin an L4 on; the route falls back to Claude, and warm demand resumes when metrics return). Only non-GPU scalers in prod may use `fallback.replicas: 1`.
  - A Pending GPU pod makes Karpenter launch a g6 node. Karpenter removes it when empty: `consolidationPolicy: WhenEmpty`, `consolidateAfter: 10m` on the GPU NodePools (this replaces the cluster-autoscaler `scale-down-unneeded-time`). **Reconciled idle timing:** KEDA `cooldownPeriod: 900` removes the pod 15 min after demand ends, then `consolidateAfter: 10m` removes the node, so the pool is at 0 nodes about 25 min (plus a few minutes of node termination) after the last demand; the I13-G3 threshold is set to 30 min.
  - **Demo GPU-hour arithmetic (~80 GPU-hours/month assumption, I00 §5.1, UNMEASURED).** The `cron` trigger warms one replica in a fixed demo window of 3.5 h on 20 days/month = 70 h, plus about 0.4 h of cooldown tail per window = about 8 h, total about 78 h, which is the ~80 h budget. Scheduled T1 eval windows and QLoRA Jobs draw from the same 80 h (not additional). Demand-driven scale-ups outside the cron window (self_hosted_only turns, warming demand) count against it too; the GPU-hour metric is compared with 80 h daily.
  - **Hard spend limits (defence in depth, all three required):** (1) Karpenter NodePool `limits: nvidia.com/gpu: 1` on `gpu-l4-*` and `train` in the demo, so no runaway can launch a second GPU; (2) KEDA `fallback.replicas: 0`; (3) an **AWS Budgets action plus a CloudWatch alarm** on Karpenter GPU node-hours (alarm at 80 h/month, and at a GPU spend of $60/month, so an On-Demand fallback cannot breach the cap: 80 h On-Demand at $0.805 is $64.40; the GPU share of the infrastructure budget per I00 §5.1) that runs an automation to set the GPU NodePools' `limits` to 0 and scale vLLM to 0. Billing data lags, so the alarm on node-hours is the timely control and Budgets the backstop.
  - **Cold-start budget (provisional, to be measured in I13-G3).** Third parties report 5–10 min before image and weight optimisation; we budget **p95 ≤ 10 min from Pending pod to first validated 1-token generation**, split as: node request to Ready with GPU driver and device plugin ≤ 4 min; image available ≤ 2 min (≤ 30 s with the pre-baked image below); weights load from S3 ≤ 3 min; engine warm-up plus readiness probe ≤ 1 min. These phase numbers are targets, not measurements. Exceeding the p95 by more than 20% in G3 triggers the mitigations in order (a), (b), then a warm floor of 1 node during demo hours.
  - **Mitigations:** (a) a pre-baked image and weights on an **EBS snapshot** attached through the EC2NodeClass block-device mapping, or a pinned GPU AMI that already holds the image (pattern documented by AWS for containers on pre-warmed volumes; feasibility for our AMI choice is unverified); (b) weights from S3 through the Mountpoint for Amazon S3 CSI driver or an init container, verified by sha256; (c) for **generation**, the model gateway never makes a turn wait on a cold GPU: it routes to Claude with `gg.route.reason=cold_gpu` and puts warming demand on the queue metric. There is no cached-answer fallback (README R20). Exception: `self_hosted_only` tenants cannot use Claude (either channel), so they get the bounded wait (≤ 15 min, shown in the UI) or an explicit "assistant warming up" response (R21).
  - Rejected: the KEDA HTTP add-on holding requests until warm, which breaks the TTFT SLO and ties up connections for minutes.
- **GPU Spot capacity is not guaranteed, so the fallback is defined, not assumed:**
  1. The `gpu-l4-spot` NodePool allows every g6 size that carries one L4 across all AZs of the cell (in single-AZ demo, several sizes are the only diversification). Karpenter handles the 2-minute Spot interruption notice and rebalance recommendations through its SQS interruption queue fed by EventBridge; do not run a second interruption handler beside it.
  2. If the pod stays Pending > 5 min after an insufficient-capacity result, the `gpu-l4-od` NodePool may serve it **only** for demand that has no Claude route (`self_hosted_only` tenants, scheduled T1 eval windows, adapter validation), and only while the GPU-hour budget guard allows. On-Demand capacity is also not guaranteed; an On-Demand Capacity Reservation for a prod floor of 1 is added only if measured stockouts justify its cost.
  3. Generic turns never trigger On-Demand spend: they stay on the Claude route (chaos C4).
  4. If neither pool can serve, `self_hosted_only` turns wait at most 15 min and then get an explicit "assistant unavailable" answer. Nothing hangs silently.
  5. Stockout frequency, time-to-fallback and Spot interruption rate for g6 in the chosen Region and AZs are measured over the 30-day demo run (I13-G3, G9) and recorded; no availability claim is made before that.
- **Sandbox node group (gVisor): a maintained artifact.** AWS offers no managed gVisor, so the AMI is ours (ADR-0024). Proposed home: `infra/ami/sandbox`.
  - **Build:** Packer in CI from a pinned EKS-optimised base AMI; `runsc` and `containerd-shim-runsc-v1` at a pinned release with verified checksums; a containerd `runsc` runtime handler and the `gvisor` RuntimeClass; AMI tagged with the git SHA, base AMI, gVisor and containerd versions, and signed manifest. I use gVisor's `systrap` platform (no nested virtualisation); confirm on the chosen instance family.
  - **Test, per AMI, before any pool may reference it:** (1) boot, join and kubelet health; (2) gVisor compatibility smoke for the sandbox images; (3) the I10 **escape suite** (privileged and hostPath denied, `/proc`, `/sys`, mount, ptrace and known breakout attempts); (4) the I10 **egress suite** (default-deny, IMDS 169.254.169.254 unreachable, DNS exfiltration limits, VPC CIDRs blocked, only the allow-listed proxy reachable); (5) resource-limit and noisy-neighbour checks; (6) p95 tool-execution latency no worse than the previous AMI by a set margin. **Escape and egress suites re-run for every new AMI, with the report stored as that AMI's evidence.**
  - **Cadence (proposed):** monthly baseline rebuild; out-of-band rebuild within 7 days of a critical gVisor, containerd or kernel advisory; a rebuild on every EKS minor-version upgrade, validated in staging before prod. Maximum AMI age 45 days (`GGSandboxAMIStale`).
  - **Upgrade path:** staging first; prod via the EC2NodeClass AMI change (Karpenter drift replaces nodes under a NodePool disruption budget; sandbox jobs are short-lived). The previous two AMIs are kept for rollback, then deregistered. An admission policy requires `runtimeClassName: gvisor` in `gg-sandbox`, and a node without `runsc` never gets the `gg/sandbox` taint removed.
- **Network:** private subnets in each AZ; NAT gateways with Elastic IPs (one per AZ in prod, one in demo) so Anthropic API egress comes from known IPs; VPC endpoints for S3, ECR, STS, KMS and Secrets Manager (and `bedrock-runtime` if that channel is enabled). North-south traffic enters through an ALB (AWS Load Balancer Controller) with AWS WAF and Shield in front (review O4). NetworkPolicies are default-deny per namespace, which requires network-policy enforcement enabled in the VPC CNI (or Cilium). Only `model-gw` may reach the LLM providers. VPC CNI policies match IPs, not names, and DNS-name rules on EKS are unverified, so `api.anthropic.com` egress goes through an allow-listed egress proxy in `gg-platform` reachable only from `model-gw` (AWS Network Firewall domain lists are an alternative to evaluate at Stage 12).
- **Namespaces:** `gg-platform`, `gg-ai` (copilot, model-gw, MCP, eval), `gg-ml` (scoring, forecast, MLflow), `gg-gpu` (vLLM), `gg-train`, `gg-sandbox`, `gg-obs`. There is one ServiceAccount per workload.

## 2.3 IaC, identity, secrets, supply chain

- **Terraform (AWS provider):** `infra/terraform/aws/` modules (proposed layout):
  - `network` (VPC, private subnets per AZ, NAT gateways, VPC endpoints), `eks` (cluster, `system` managed node group, access entries, OIDC), `karpenter` (controller IAM, interruption SQS queue and EventBridge rules, NodePools and EC2NodeClasses), `pod_identity`, `ecr` (immutable tags, scan on push, lifecycle), `kms` (per-environment CMKs: `gg-<env>-content`, `gg-<env>-sops`, `gg-<env>-s3`, `gg-<env>-signing`), `s3` (buckets: mlflow-artifacts, model-weights, eval-datasets, tempo, loki, opensearch-snapshots, backups; versioning, lifecycle, SSE-KMS, block public access, TLS-only policy), `secrets` (Secrets Manager), `rds`, `elasticache`, `msk`, `opensearch`, `edge` (ALB, WAF web ACL with rate rules, Shield tier decided on cost), `budgets`.
  - `budgets`: AWS Budgets alerts at 50/80/100% of the monthly cap, an AWS Budgets action and a CloudWatch alarm on GPU node-hours (see §2.2), then SNS, then a Lambda kill-switch that scales the `gpu-l4-*` and `train` NodePools to 0 and sets the model-gw hard cap. AWS billing data lags, so the model-gw hard cap in Postgres (§2.4) is the real-time enforcement and Budgets is the backstop.
  - Remote state is in S3 with locking (native S3 lockfile or a DynamoDB lock table, per the pinned Terraform version); the state bucket is versioned and KMS-encrypted with a restricted role. Every module has `terraform test` plus `tflint` and `checkov`/`trivy config` gates in CI.
- **EKS Pod Identity (IRSA):** Pod Identity is the default (association of namespace and ServiceAccount to an IAM role); IRSA (OIDC) only where a component does not support Pod Identity (check each add-on at Stage 12; unverified). Least privilege: `model-gw` gets `secretsmanager:GetSecretValue` on `anthropic-api-key` only (plus `bedrock:InvokeModel*` on named model or inference-profile ARNs if that channel is enabled); `vllm` gets `s3:GetObject` on the `model-weights` prefix and `kms:Decrypt` on its key only; `mlflow` gets read/write on `mlflow-artifacts` only. No long-lived access keys: an SCP or permissions boundary denies `iam:CreateAccessKey` for workload roles. **Sandbox pods get no identity:** no ServiceAccount token automount, no Pod Identity association, IMDS unreachable (metadata hop limit 1 and a NetworkPolicy deny to 169.254.169.254).
- **Secrets:** External Secrets Operator reads AWS Secrets Manager through Pod Identity. EKS secrets use envelope encryption with a KMS CMK. The Anthropic key is rotated every 90 days with a two-key overlap, and rotation is tested (DEP-E14). SOPS is used only for non-secret-but-sensitive Helm values.
  - Rejected: sealed-secrets, because its key lives in-cluster and complicates DR. The Secrets Store CSI driver with the AWS provider is the recorded equivalent.
- **Images:**
  - Built in GitHub Actions, pushed to **ECR** by digest (immutable tags), with an SBOM (syft) and vulnerability scan (trivy/grype; blocking on fixable HIGH/CRITICAL). ECR scan-on-push is an extra signal, not the gate.
  - Signed with **Cosign keyless (GitHub OIDC) plus a SLSA provenance attestation.**
  - Admission: a **Kyverno `verifyImages` policy** in enforce mode on prod (audit mode on staging for the first two weeks). It requires the CI attestation, uses digest-only references, and blocks `:latest`.
  - Keyless verification needs the cluster to reach the public Sigstore endpoints, or a mirrored trust root. Signing with an AWS KMS key (`awskms://`) is the fallback if that egress is not acceptable. The choice, and Kyverno versus the Sigstore `policy-controller`, is decided in ADR-AI-D4 after a spike.
- **Model artifact provenance:**
  - Weights, LoRA/QLoRA adapters, embedding models and sklearn/LightGBM models are content-addressed (`sha256`) in S3 (SSE-KMS) with object versioning; S3 Object Lock retention only on the non-tenant model-release bucket, never on tenant data (ADR-0024, Intelligence R6).
  - Each has a **signed model manifest** (`cosign sign-blob` / in-toto attestation) containing: source (HF repo + revision), licence ID and acceptance, training data snapshot hash, MLflow `run_id`, git SHA, training image digest, eval report hash (I9) and quantization method.
  - The vLLM/scoring init container verifies the manifest signature and each file's sha256 before serving, and fails closed.
  - **Model deployment authority is Git (README R10):** a per-cell deployment manifest in `infra/gitops` (Argo) is the only source of which model version is champion or canary for each cohort. MLflow aliases (`champion`, `challenger`; not deprecated stages) are a **reconciled projection** of that manifest: the reconciler writes Git → MLflow only. Nothing else writes MLflow aliases, and there is no `ml.model_deployment.v1` event or `model_deployments` table.

### 2.3.1 Observability plane on AWS (decision)

**Decision:** keep OTel → Tempo, Loki, Prometheus, Grafana **self-hosted on EKS** with S3 backends (O-D2). Amazon Managed Prometheus (AMP) and Amazon Managed Grafana (AMG) are not used now. Reasoning:

1. The plane would be split. AMP replaces only Prometheus and AMG has no trace or log store, so Tempo and Loki stay ours. Two stacks cost more on-call attention than one.
2. Local and CI parity. `promtool test rules`, kube-prometheus-stack and the dashboard linter are the same everywhere (I12-G4, G8). A managed ruler adds a second delivery path for rules; its packaging differences are unverified.
3. The metric catalogue depends on pinned OTLP translation, exemplars and native histograms. AMP support for exemplars and native histograms is unverified.
4. The cardinality budget (60k AI series per cell, §1.4) keeps self-hosted cost small at Tier 1. AMP is billed by ingested samples; I have not verified current AWS prices.
5. **Costs accepted:** we run and patch Prometheus HA (2 replicas, 35-day retention on gp3 volumes), and the observability plane has its own failure modes. The Watchdog dead-man's switch (OBS-E02) therefore alerts through an external heartbeat receiver, for example a CloudWatch alarm on a heartbeat metric or a third-party service, so it does not depend on the cluster.
6. **Revisit trigger (Stage 11 ADR-AI-O2):** if per-cell series or the plane's on-call load outgrow one Prometheus HA pair, or at Tier U per-cell scaling, evaluate AMP plus AMG (still with self-hosted Tempo and Loki).

**CloudWatch scope (deliberately narrow):**
- Pinecone is not an AWS-managed service and its usage is metered by our own `vectorstore_*` metrics (and `kb_vector_usage`), not scraped from CloudWatch; compare the monthly total with the Pinecone console invoice in I13.
- Metrics from AWS-managed services that have no Prometheus endpoint of their own: RDS, ElastiCache, OpenSearch Service, ALB/NLB, NAT gateway, WAF, S3 request metrics, and the Karpenter interruption queue. MSK is scraped through its Prometheus open-monitoring endpoints where available. Pull CloudWatch data into Prometheus with YACE or the CloudWatch exporter on a bounded allow-list (API cost and series count), so alert rules, SLO recording rules and dashboards stay in one place. These `aws_*` series are outside the AI cardinality budget and tracked under their own limit.
- CloudWatch alarms only where Prometheus cannot be the detector: the external heartbeat above and the AWS Budgets kill-switch path.
- Logs: application logs go OTel → Loki, never to CloudWatch Logs. EKS control-plane audit logs and RDS, OpenSearch Service and MSK broker logs exist only through CloudWatch Logs or S3, so they are kept 30 days, with security events routed to the audit path.
- Access is through Grafana RBAC (team `sre`); the AWS console is not a source of truth for dashboards.

### 2.3.2 LLM channels: first-party API primary, Claude on Bedrock optional

- **Primary:** the Anthropic first-party API (owner decision 2026-09-29). Every number in this document (price table, cache fields, TTFT, the $300/month product cap, T2 evals through the Message Batches API) assumes this channel.
- **Optional second channel:** Claude on Amazon Bedrock. It is **disabled by default** and enabled per environment or tenant policy in gateway config only after the capability table below is confirmed against the live service by contract tests (I13-G12). Reasons to enable it: AWS procurement needs, IAM-only authentication (no API key), PrivateLink. **It is not a data-residency option:** Sonnet 5.5 on Bedrock is offered only through the `global.` inference profile, which routes across Regions and does not pin data to one. Residency options to evaluate instead (both unverified here): the first-party API's `inference_geo` parameter, and Claude Platform on AWS.
- **model-gw treats Bedrock as a separate provider:** its own `gen_ai.provider.name`, price-table version, model-ID or inference-profile mapping, rate limits, circuit breaker and budget scope. It is never a transparent alias for the first-party channel. Auth is an IAM role through Pod Identity for `model-gw` only, scoped to named model or profile ARNs, over a `bedrock-runtime` VPC endpoint. `self_hosted_only` tenants use neither Claude channel.
- **Parity claims.** Verified only to the level of search-result summaries of public AWS and Anthropic pages on 2026-09-29; the primary pages were not fetched. Nothing marked unverified may be relied on.

| Capability | Status |
| --- | --- |
| Extended thinking | Reported available on Bedrock; per-model behaviour unverified |
| Tool use (JSON-schema tools) | Reported available; streaming `tool_use` event shape and parallel-call behaviour unverified |
| Prompt caching | Available. **Sources conflict on TTL:** one says a fixed 5 minutes, an AWS Insider item (Jan 2026) says 1-hour caching is supported. **Unverified; do not assume 1 hour.** Cache read/write usage fields on Bedrock responses unverified |
| Automatic top-level `cache_control` | Reported to return HTTP 400 on legacy Bedrock (Opus 4.6 and earlier); current models unverified |
| Anthropic-hosted features (web search, Skills, Managed Agents) | Reported not available on Bedrock; this design uses none of them |
| Message Batches API (T2 evals) | **Not available** on Bedrock (Anthropic's availability table says No; Bedrock's own batch inference is a different mechanism and is not used). T2 evals stay first-party |
| Sampling-parameter rejection on 5.5 routes (README R19) | Unverified on Bedrock |
| Provider-side `fallbacks` (ADR-0024 mention) | **Not available** on Bedrock (Anthropic availability table: No). model-gw implements fallback itself and does not rely on any provider feature |
| Model IDs, inference profiles, quotas, latency | Differ from first-party. Sonnet 5.5 is only the `global.` profile (cross-Region routing; **no Region pinning, so no residency claim**). Record the profile ID and quotas per environment |
| Data residency | **Not provided by Bedrock for Sonnet 5.5** (`global.` profile only). Evaluate first-party `inference_geo` and Claude Platform on AWS before promising any residency |
| "Claude Platform on AWS" (a separate AWS offering with its own feature-support page) | Residency option to **evaluate** (not evaluated yet); feature support to be read from its own page |

The mock-llm (§2.7) gains a Bedrock request/response shape only when the channel is enabled.

## 2.4 Environments and promotion

| Env | Where | LLM | GPU | Data | Purpose |
| --- | --- | --- | --- | --- | --- |
| local | Docker Compose (`infra/staging/compose.yaml` + `compose.ai.yaml`) / kind | **mock-llm** (default), optional real Claude with the developer's own key, capped at ≤ $60/month across all developers (the local share of the $300 product cap, R22) | none (vLLM CPU or mock) | synthetic | dev, unit/integration, Phoenix |
| ci | GitHub Actions + kind | mock-llm | none | fixtures | contract tests, eval smoke (I9 fast set), promtool, helm lint/kubeconform, conftest |
| staging | EKS demo cluster, ns `*-staging` (**not built yet, waits for Stage 12**; meanwhile the local/Compose profile is the staging stand-in) | Claude (low budget cap) + vLLM | Spot g6 (L4) scale-to-zero, gated On-Demand fallback | synthetic tenants only | canary rehearsal, chaos, load slices |
| prod(demo) | (**not built yet**) same cluster, ns `*-prod`, **or** separate single-AZ cluster when budget allows | Claude + vLLM | L4 | demo tenants | public demo |
| cert | (**not built yet**) **ephemeral** multi-AZ cluster from the same Terraform, created for Stage 13 runs and destroyed after | mock-llm + small real slice | on demand | Tier 1 population fixtures | certification evidence |

Promotion goes image digest → staging (auto) → prod (PR to `infra/gitops/envs/prod`, requires green analysis + evals + manual approval). Prompts, routing tables, guardrail policies and model aliases are **versioned config artifacts** promoted the same way: a ConfigMap checksum annotation triggers a Rollout, so config changes get canary analysis too.

Honest cost note: the whole GreenGuard platform (Kafka, Cassandra, Postgres, OpenSearch, Redis, RabbitMQ) plus AI on one always-on cluster is the dominant cost driver, not the GPU. A per-component monthly estimate belongs to the I0 cost section. I13's contribution is the spot/scale-to-zero policy, the budget kill-switch and ephemeral cert clusters.

**Budgets (README R22, owner decision §8 Q5).** Total budget is **$1,000/month** (infrastructure ≤ $600, product Claude **≤ $300** hard cap, eval Claude **≤ $100**). Evals: T0 recorded responses per PR ($0); T1 self-hosted during scheduled GPU windows; **T2 Claude weekly via the Message Batches API ≤ $12 per run** (≈ $52/month), plus a $30/month release-candidate reserve and $18/month for online-eval judge calls, canary evals and judge recalibration (total $100). Load-test real slices and I13 canary eval Jobs draw from these caps, never from an uncapped key. Budget exhaustion is always **429 `budget_exhausted` with `Retry-After`**. Money is authoritative in Postgres (`greenguard_ai_usage`) on sharded budget rows: `FOR UPDATE NOWAIT` on a random shard, move to the next on conflict, deny only when all shards are busy or exhausted (ADR-0002 money/quotas row). Prometheus budget gauges are a view of that state, never the enforcement point.

## 2.5 Argo CD and Argo Rollouts with AI-aware analysis

- **Argo CD:** app-of-apps per environment, sync waves (CRDs → platform → data → AI), `ApplicationSet` per cell for Tier U readiness. Drift detection is on; manual kubectl in prod is disallowed.
- **Stateless request services** (grain-advisor, model-gw, mcp-gateway, BFF) use a **canary with weighted ALB traffic routing** (Argo Rollouts native ALB integration, IP-mode target groups; the Gateway API plugin is the alternative once AWS Load Balancer Controller Gateway API support is verified at Stage 12): steps 5% → 25% → 50% → 100%, with a background `AnalysisRun` and inline analysis at each pause.
- **AnalysisTemplates:**

| Template | Provider | Success condition (canary vs stable, same window) |
| --- | --- | --- |
| `ai-error-rate` | Prometheus | canary 5xx+failed-task ratio ≤ max(1%, 1.2 × stable) |
| `ai-ttft` | Prometheus | canary TTFT p95 ≤ 1.15 × stable and ≤ SLO |
| `ai-cost-per-task` | Prometheus | canary `cost/successful task` ≤ 1.2 × stable (catches prompt bloat, loops) |
| `ai-steps` | Prometheus | canary p95 agent steps ≤ stable + 2 |
| `ai-guardrail-rate` | Prometheus | block rate within ±50% of stable (both directions: a drop can mean a disabled guardrail) |
| `ai-online-eval` | Prometheus (`gg_eval_score{mode="canary"}`) | groundedness mean ≥ stable − 0.03 and ≥ 0.85, n ≥ 200 judged turns (else **inconclusive → pause**, not pass) |
| `ai-offline-eval` | **Job** provider: runs I9 golden suite against canary Service via header `x-gg-canary: 1` | suite pass rate ≥ threshold in I9; no regression on safety/tenant-leak cases (zero tolerance) |

- Canary pods receive 100% eval sampling (`gg.eval.sampled`) so n accumulates quickly. At demo traffic volumes the rollout adds synthetic traffic from the I9 replay set (header-tagged, excluded from business SLIs), otherwise statistical power is too low. This is documented as a known limitation.
- **ml-scoring (Kafka consumer)** separates code rollout from model rollout:
  - (1) **Code rollout:** `Rollout` with basic canary replica steps plus analysis on consumer lag, `ml.scored_through.v1` watermark lag, error rate and inbox duplicate anomalies.
  - (2) **Shadow (README R8):** the challenger runs in the same pods on the same batch (`gg.shadow=true`) and writes **only** to `greenguard_ml.ml_shadow_predictions`; shadow rows never enter the outbox and cannot reach Kafka.
  - (3) **Model canary (README R10):** a **flag cohort inside ml-scoring** (Stage-10 feature flags, GG-10b) selects which devices/bins are scored by the canary version named in the Git manifest. Canary predictions commit to `ml_predictions` and the outbox like champion ones (advisory only, R7). Cohort steps (e.g. 5% → 25% → 100%) are manifest commits; promotion requires shadow agreement ≥ threshold, backtest MAE ≤ champion and precision not worse over the matured label window, analysed per cohort.
  - (4) **Rollback fast path:** set the canary flag cohort to **0%** (seconds, no redeploy), and an **automatic Git revert PR** of the manifest change is opened. The MLflow reconciler then projects the reverted manifest; it never reverts a rollback and nothing writes MLflow aliases directly.
  - Rejected: a separate canary consumer group, which double-processes events with side effects unless fully sandboxed.
- **vLLM model changes:** blue/green (`Rollout` blueGreen with `prePromotionAnalysis` running the offline eval Job against the preview Service). GPU capacity limits mean blue and green cannot both be warm on a 2-node demo cap, so the prePromotion step scales the pool to 2 temporarily; the budget impact is recorded.
- **Automatic rollback triggers:** any failed analysis; the `GGGroundednessBelowFloor` alert (Argo Rollouts abort through the `argo-rollouts` notification webhook or a manual runbook step in demo); the budget kill-switch. For ML models, rollback is always the flag-cohort-0% + automatic Git revert path above.

## 2.6 Workload tiers and the certification envelope

The I0 section owns the tier definitions. I13 certifies only at a measured tier.

| | Tier 1 (certify in Stage 13, UNMEASURED) | Tier U (10M design target; not certified) |
| --- | --- | --- |
| Platform base | `CAPACITY_MODEL.md` Tier 1: 10k concurrent users, 20k/50k events/s, API p95 < 300 ms | 10M/10M/10M legacy model |
| Copilot | **the single Tier 1 copilot rate from the I0 charter (reference "I0 A-copilot")**, steady and peak turns/s; this file does not define its own number and the k6 profile must match I0 exactly (a CI check compares the k6 config to the I0 value). ≤ 8 tool calls and ≤ 60 s per turn (README R16); **mock LLM** | proportional arithmetic only; binding limit is provider rate limits/quotas (G7) and GPU supply, not our code |
| Real-model slice | small fixed rate of real Claude + vLLM turns, sized so the whole run stays inside the $300/month product cap (README R22; its share is set with the local $60 and I6 E2E shares), to validate the mock's realism | — |
| ML scoring | Rates from the I0 binding numbers (UNMEASURED) times an explicit **headroom multiplier of 3×** (the same 3× burst as the copilot test): 1,111 device scores/s → **3,333/s**; 69 bin forecasts/s → **207/s**. Lag returns to baseline within 30 min recovery (same rule as pipeline). **The '50k events/s ML gate is blocked on README §8 Q18** (I0 §8 Q8): the platform envelope of 20k/50k events/s and the R5 sensor model (1,111 readings/s) disagree, and until the owner answers, no ML gate is set at 50k events/s. | per-cell scaling of consumer groups/partitions |
| RAG and embeddings | Embedding calls = questions: 6.7/s × 3× = **20/s** (I0 binding number). Retrieval rate is I0's retrievals-per-question × 6.7 questions/s × 3×; I0 does not yet state retrievals per question, so **no retrieval-per-second gate is set** (the earlier 60/s is dropped as underived) until I0 does. Vector leg: Pinecone limits are 100 RPS per namespace for queries and upserts (verified); one index per cell placement, namespaces per tenant (I7, ADR-0029). The Postgres FTS leg is sized in I13 (GIN on about 20M chunks per cell is UNMEASURED). | index placement strategy (I7) |

Tier U claim language: "designed for", with the arithmetic in I0. **Summed per-cell AI capacity is a forecast.** Provider quotas are a Stage 14/G7 commercial gate.

## 2.7 Load-test design

- **Tool:** **k6** (consistent with Stage 13's matrix), built with the pinned **xk6-sse** extension to measure streaming TTFT and chunk timing at the client. Open-loop `constant-arrival-rate` / `ramping-arrival-rate` executors report `dropped_iterations` (coordinated omission).
  - Rejected: Locust. It is a second tool and a second evidence format, although its Python fits LLM testing. It is allowed for exploratory tests only.
- **One combined run** with the Stage 13 scenarios plus these:
  - `ai_copilot_turns`: at the I0 A-copilot rate; SSE, validated-TTFT measured at the client (README R18), weighted prompt mix from the I9 dataset, including 5% adversarial and injection prompts, 10% approval-requiring actions and 3% client aborts.
  - `ai_approvals`: approver virtual users.
  - `ml_scoring`: driven by the existing telemetry scenarios, with lag measured.
  - `rag_only`: search API.
  - `admin_eval`: a background eval backlog.
  - Tenant skew: one hot tenant generates 20% of copilot load (review R5; verifies per-tenant rate limits and token budgets, with the hot tenant receiving 429 `budget_exhausted` + `Retry-After`).
- **mock-llm server** (`tools/mock-llm`, Go):
  - Implements the Anthropic Messages API (streaming SSE events, `tool_use` blocks, usage incl. cache fields, `request-id`; rejects sampling parameters on 5.5 routes with 400, matching README R19) and the OpenAI-compatible API (the vLLM route).
  - Configurable per route: TTFT distribution, tokens/s, output length, error injection (429 with `retry-after`, 529 overloaded, 500, connection reset, stall mid-stream, malformed SSE, truncated `tool_use` JSON), and deterministic seeded answers that cite provided doc IDs so groundedness checks are meaningful.
  - Exposes its own injected-latency histogram. **Platform overhead = e2e − injected provider time.** That is what we certify: "the platform adds ≤ X ms p95 and loses zero turns at N turns/s", independent of the provider.
- **Real slice:** a separate short run with the real Claude and a warm vLLM, cost-capped (`k6` stops at the budget via the model-gw hard cap). It compares mock-vs-real TTFT and token distributions to calibrate the mock. Numbers are reported separately and never merged with mock results.
- **Pass criteria (AI part of STAGE_13 evidence `STAGE_13_TIER_1_AI.json`):**
  - platform overhead p95 ≤ 150 ms to first validated token (excluding provider time and the buffered validation window, which is reported separately) and ≤ 300 ms total per turn;
  - validated TTFT p95 ≤ 5 s (provisional SLO, README R18) with the mock's calibrated provider latency;
  - copilot availability ≥ 99.5% in each phase;
  - zero lost approvals and zero duplicate write-tool executions (reconciled by `gen_ai.tool.call.id` idempotency keys);
  - ml-scoring lag recovers within the pipeline rule;
  - no base platform SLO regresses when AI load is added (A/B run without the AI scenarios);
  - no unbounded memory (24 h soak includes the AI scenarios at the steady rate);
  - collector drop = 0;
  - the ledger reconciles against mock token counts exactly.

## 2.8 Chaos experiments (Chaos Mesh, plus AWS Fault Injection Service and the AWS CLI for node, Spot and AZ actions)

| ID | Fault | Expected degradation | Must never happen | Measured |
| --- | --- | --- | --- | --- |
| C1 | Anthropic API outage (mock 100% 529 / network blackhole egress) | circuit opens ≤ 30 s; routes to vLLM (cold → scale-up, meanwhile an explicit "degraded: limited assistant" template response; no cached answers, README R20); copilot availability counts degraded answers as good only if explicit | hung requests > timeout; retry storm (retries capped, jittered, budgeted: ≤ 10% extra calls) | time to open circuit, fallback TTFT, extra calls |
| C2 | Anthropic 429 rate limit | token bucket per tenant/plan in model-gw backs off; queue; lower plan tiers shed first | one tenant starving others | per-tier success |
| C3 | GPU node loss / Spot interruption (2-minute notice, or none on hardware failure) during generation | Karpenter cordons and drains on the notice but in-flight streams are not migrated; in-flight vLLM streams fail → gateway retries once on Claude if no tokens were streamed yet; if partially streamed, ends with explicit "response interrupted" (no silent splice) | duplicate tool executions | turns affected, recovery time |
| C4 | g6 Spot capacity unavailable (insufficient capacity) or a Spot interruption storm | pod Pending; alert; Claude route continues; Karpenter widens across g6 sizes and AZs, then the gated On-Demand NodePool per the §2.2 fallback policy (never for generic turns) | cost overrun (budget guard) | time in degraded |
| C5 | MSK broker loss (Strimzi pod loss in demo) / consumer lag injection | ml-scoring lag rises; `ml.scored_through.v1` watermark stops advancing, so every read-side freshness check (advisor staleness, SLO, missing-prediction guardrail) marks ML output stale (README R9); risk-engine alerts are unaffected because ML is advisory only (R7); lag recovers | offset commit before effect; duplicated `ml.prediction.v1` events (inbox); a shadow row reaching Kafka | lag and watermark recovery time |
| C6 | **Pinecone unavailable** (egress to the Pinecone hostnames blocked by NetworkPolicy, plus a fault proxy injecting 429 storms and latency) | breaker opens; retrieval runs lexical-only (Postgres FTS) with `degraded_vector=true`; if the lexical leg is also failed the copilot answers "cannot access knowledge base" with sensor-only tools; `retrieval.empty` never treated as "no knowledge"; recovery closes the breaker without a thundering herd; per-tenant read-unit budgets hold | ungrounded answer claimed as grounded; cross-tenant results from a degraded path; retry storm burning read units | groundedness and citation validity in degraded mode; vector-leg SLI |
| C7 | MLflow down | serving continues on locally cached model (loaded at startup with verified sha); promotions blocked; training jobs fail fast | serving outage because registry is down | serving availability = 100% |
| C8 | ElastiCache/Redis primary failover or outage | tenant-keyed embedding cache bypassed (no answer/semantic cache exists, README R20); rate limiter falls back to in-process conservative limits (ADR-0007 pattern); sessions degrade gracefully | unlimited spend without limiter (budget stays authoritative in Postgres `greenguard_ai_usage`, R22, so Redis loss cannot lift the cap) | extra cost during fault |
| C9 | RDS Postgres (checkpointer/content store) Multi-AZ failover, including Debezium slot handling | in-flight turns fail with retryable error; checkpoints resume from last committed step; approvals intact | lost approval; double execution of approved write tool | reconciliation |
| C10 | Collector/Tempo/Prometheus down | covered in OBS-E01/E02 | request impact | — |
| C11 | Eval judge down | backlog; canary promotions pause (inconclusive) | promotion passing without eval | — |
| C12 | AZ failure (prod profile; FIS or a subnet/NACL blackhole of one AZ) | Karpenter reprovisions in surviving AZs; RDS Multi-AZ fails over; ElastiCache promotes a replica; MSK and OpenSearch Service keep quorum on 2 of 3 AZs; GPU may be unavailable → Claude route | acknowledged-write loss | RTO per component |
| C13 | Poisoned KB document / prompt injection via tool result | guardrail blocks; alert; trace retained | tool executing injected instructions without approval | block rate |
| C14 | Clock skew / DNS failure for provider | timeouts with clear `error.type`; circuit | hang | — |
| C15 | New sandbox AMI fails the escape or egress suite, or boots without `runsc` | AMI not promoted; the pool stays on the previous AMI; `GGSandboxAMIStale` fires if the old one ages out | a sandbox pod running under `runc`; a sandbox pod with IMDS access or an AWS identity | suite result per AMI |

## 2.9 Disaster recovery

| Asset | Source of truth / method | Proposed RPO / RTO (to measure) | Restore test |
| --- | --- | --- | --- |
| MLflow backend (Postgres) | RDS for PostgreSQL: automated backups with PITR (retention set per environment, at most 35 days), snapshots, a daily logical dump to S3, and cross-Region snapshot copy in prod | 5 min / 1 h | restore to new instance, verify aliases and run lineage match manifest in Git |
| MLflow artifacts, model weights, adapters | S3 versioned (SSE-KMS); Object Lock only on the non-tenant release bucket; optional cross-Region replication in prod | 0 (object versioning) / 30 min | re-deploy from manifest with sha verification |
| Per-cell model deployment manifests | **Git** `infra/gitops` (authoritative, README R10); MLflow aliases are a reconciled projection | 0 / minutes | Argo re-sync; reconciler re-projects aliases |
| ml-scoring online window state (`greenguard_ml`, README R2) | Postgres PITR; also rebuildable by replaying retained input topics through `packages/ml-features` | 5 min / 2 h | PITR restore, then replay; features equal the parity sample |
| Offline corpus (Parquet, S3) | derived from the simulator and consented exports (R4, R24); S3 versioning with a noncurrent-version lifecycle | inherits Stage 14 | — |
| Pinecone KB indexes (tenant namespaces per placement index; separate public index and project; README R11, ADR-0029) | **No Pinecone backups or collections** (an alarm fires if one appears); the index is a rebuildable projection: recreate the index and namespaces, re-embed from Postgres chunk text under the platform indexing budget, run the retrieval eval, flip `knowledge_index_placement`; retrieval runs lexical-only meanwhile. Rebuild time and cost measured in I13 | rebuild time and cost UNMEASURED (set the target from I13) | drill: delete a test index, rebuild, recall@k equal to the pre-loss eval; measure lexical-only quality during the rebuild |
| OpenSearch (telemetry search and the local adapter; Stage 05d/10a) | as Stage 05d/10a | as Stage 14 | not part of the AI critical path |
| `greenguard_advisor` (checkpoints, `action_proposals`, `ai_interaction_content`), `greenguard_ai_usage` (`ai_usage_ledger`, budgets), eval results | Postgres (tenant tables) PITR; ledger also flows to billing via `greenguard.ai.usage.v1` | 5 min / 1 h | PITR restore + deletion-ledger replay (§2.9.1) + reconcile ledger with billing inbox |
| Kafka topics (MSK; Strimzi in demo) | MirrorMaker 2 to the DR Region (Stage 14 decision; MSK Replicator to be evaluated); AI topics carry IDs and predictions re-derivable from Postgres sources | inherits Stage 14; not claimed here | replay after restore; inbox ignores deleted tenants |
| ElastiCache | not backed up (cache and limiter state only; budget authority is Postgres) | accepted loss | documented |
| Cluster and platform state | Terraform + Argo CD from Git; the EKS cluster is recreated, not restored | minutes to hours (measured) | `terraform destroy` then apply, Argo re-sync |
| Eval datasets, judge prompts | S3 versioned + Git | 0 / minutes | — |
| Grafana dashboards/rules | Git | 0 | — |
| Tempo/Loki data | not backed up (operational telemetry, 14 d) | accepted loss | documented |
| Secrets | AWS Secrets Manager (multi-Region replica secrets in prod) | 0 | rotation drill |

Restore drills are part of Stage 14 incident exercises. Evidence: `evidence/STAGE_I13_DR.md` with the measured RPO/RTO. No target is claimed unmeasured.

### 2.9.1 Tenant-deletion inventory and delete → restore → zero test (README R26)

The authoritative inventory lives in I00 §3 (edited at I0); this table is I13's view of it and must match. Tenant deletion = **crypto-shred the tenant DEK + hard delete in every store + deletion-ledger replay after any restore**. The platform tenant-deletion event (review O2) is a tenant-control-plane prerequisite of I10.

| Store | Holds | Deletion mechanism | After a restore |
| --- | --- | --- | --- |
| Postgres `greenguard_advisor` (threads, `run_events`, checkpoints, proposals, `ai_interaction_content`) | tenant content, per-user threads | DEK crypto-shred + hard delete | PITR/backup can resurrect rows → deletion ledger replayed before the DB serves traffic |
| Postgres `greenguard_ml`, `greenguard_knowledge`, `greenguard_ai_usage` | predictions, shadow rows, window state, documents/chunks, usage | hard delete; `ai_usage_ledger` pseudonymised per billing retention | deletion-ledger replay |
| RDS automated backups/PITR, snapshots (including cross-Region copies), logical dumps | all of the above | age out by retention; ciphertext unreadable after DEK shred | restored instance replays deletion ledger |
| Pinecone tenant namespaces (vectors + minimal metadata; no text) | embeddings and IDs (semantic information about text) | `delete_ids` per document; `delete_namespace` for tenant offboarding or policy change; verify by fetch-by-ID and namespace listing; Pinecone-side retention is contractual (README §8 Q21) | after a Postgres restore, ledger replay, then rebuild the index from restored text; assert no namespace and zero hits for the deleted tenant before serving |
| OpenSearch adapter indexes and snapshots (local/CI, synthetic fixtures only) | test data | deleted with the environment | n/a |
| S3 Parquet (tenant-pseudonym partitions), MLflow artifacts, eval datasets | training rows, artifacts | delete tenant partitions; **S3 versioning:** noncurrent versions and delete markers expired by lifecycle within a documented window, or purged explicitly for the tenant prefix | restored objects re-deleted by ledger replay |
| Kafka topics (`ml.prediction.v1`, `knowledge.*.v1`, `advisor.action.v1`, `ai.interaction.completed.v1`, `ai.usage.v1`, …) | IDs (and predictions) keyed by tenant | **topic retention** expiry (documented maximum); consumers drop events for deleted tenants | replayed events for deleted tenants are ignored by inbox checks |
| Redis | tenant-keyed embedding cache, rate-limit state | key-prefix delete + TTL | — |
| Tempo / Loki | tenant ID as span attribute / structured metadata | age out ≤ 14 d (not erased individually) | not backed up |

**Test IT-05 (delete → restore → zero):** seed two tenants in every store above; delete tenant A; restore Postgres (PITR) and S3 object versions taken *before* the deletion; replay the deletion ledger; **rebuild the Pinecone index from the restored Postgres text** (no Pinecone backup exists to restore); assert **zero rows, zero hits, no Pinecone namespace and zero decryptable content for tenant A in every store**, and tenant B intact. Evidence under `evidence/`. Kafka and Tempo/Loki are asserted by documented maximum retention plus the inbox-ignore check, not by erasure.

## 2.10 Edge cases and failure modes (deployment)

| ID | Situation | Expected behaviour |
| --- | --- | --- |
| DEP-E01 | Rollout of a prompt change passes metrics but judge sample n too small | Analysis inconclusive → pause, not promote |
| DEP-E02 | Canary is cheaper because it silently fails tool calls | `ai-error-rate` + `ai-steps` + offline eval catch it; cost alone never passes a canary |
| DEP-E03 | Guardrail disabled by config typo | `ai-guardrail-rate` two-sided check fails; conftest policy requires guardrail config present |
| DEP-E04 | Model weights tampered in S3 | sha/manifest verification fails → pod CrashLoop, old ReplicaSet keeps serving; alert |
| DEP-E05 | Unsigned image / tag instead of digest | Kyverno `verifyImages` denies; CI kubeconform/conftest also rejects |
| DEP-E06 | Model licence not accepted / changed upstream | manifest licence field required; pinned HF revision; no auto-pull at runtime |
| DEP-E07 | GPU driver/CUDA mismatch after an EKS or AMI upgrade | the GPU EC2NodeClass pins an explicit AMI version (no `latest` alias) + maintenance window; staging upgraded first; vLLM readiness probe runs a 1-token generation |
| DEP-E08 | Spot interruption storm (2-minute notice) | PDBs are best-effort under Spot reclamation; gateway fallback; prod keeps on-demand floor for app pool |
| DEP-E09 | KEDA scaler can't reach Prometheus | GPU scalers: `fallback.replicas: 0` in every env (the Claude route serves; no GPU is pinned by a metrics outage); non-GPU scalers may use 1 in prod — explicit per scaler |
| DEP-E10 | Scale-to-zero flaps (bursty traffic) | cooldown 15 min + cron warm window; flap metric |
| DEP-E11 | Budget kill-switch fires during a demo | GPU pool 0, model-gw hard cap: answers become explicit "assistant paused (budget)"; platform unaffected |
| DEP-E12 | Argo CD out of sync due to manual hotfix | self-heal reverts; hotfix must go via Git; audit |
| DEP-E13 | Terraform drift (console change) | nightly `terraform plan` detects, ticket |
| DEP-E14 | Anthropic key rotation | ESO refresh + two-key overlap; model-gw reloads on secret change without restart; test revokes old key; the Bedrock channel has no key (IAM role), so its test removes the role's `bedrock:InvokeModel` grant and checks the circuit |
| DEP-E15 | EKS Pod Identity (IRSA) misbinding grants vLLM access to content bucket | IAM policy test (IAM Access Analyzer or `aws iam simulate-principal-policy`, plus Terraform tests) asserts exact bindings |
| DEP-E16 | MLflow alias moved in UI outside Git | the reconciler projects Git → MLflow only: it overwrites the drifted alias with the Git manifest value and alerts. It never writes Git, never reverts a rollback (rollback = flag cohort 0% + Git revert PR, README R10), and serving reads the Git manifest, not the MLflow alias |
| DEP-E17 | Schema change in LangGraph checkpoint format with in-flight interrupted runs | checkpoint version field; old runs resumed by old graph version or explicitly migrated; approval rows reference graph version |
| DEP-E18 | Blue/green vLLM doubles GPU → budget exceeded | prePromotion scaling step checks budget first; otherwise off-peak window |
| DEP-E19 | Provider API version deprecation | pinned `anthropic-version` header / SDK; contract test against mock + weekly real smoke |
| DEP-E20 | Cert cluster left running | TTL label + scheduled destroy job + budget alert |
| DEP-E21 | Sandbox node boots an AMI outside the approved list | EC2NodeClass pins the AMI ID; a nightly check compares running nodes to the list; mismatch → node cordoned, ticket |
| DEP-E22 | Sandbox pod scheduled without `runsc` | Admission policy requires `runtimeClassName: gvisor` in `gg-sandbox`; the taint keeps other pods off; test asserts denial |
| DEP-E23 | g6 Spot and On-Demand both unavailable | Claude route continues; `self_hosted_only` turns wait ≤ 15 min then get an explicit unavailable answer; `ai-gpu-capacity.md` |
| DEP-E24 | Bedrock model ID, inference profile or feature differs from the capability table | Channel stays disabled; contract test against the real service fails first; provider capability table updated before enabling |
| DEP-E25 | RDS Multi-AZ failover or restore loses the logical replication slot | Outbox pruning was gated on Debezium's confirmed flush LSN, so no unconfirmed row was deleted; re-snapshot re-emits with unchanged event IDs; inbox idempotency absorbs duplicates (§2.2 outbox pruning rule) |

## 2.11 Tenant-isolation tests (I13)

| ID | Test |
| --- | --- |
| DEP-T01 | Under load with the hot-tenant profile, tenant B's copilot availability and TTFT SLO hold while tenant A exceeds its token budget (A gets 429 with `Retry-After`; B unaffected). |
| DEP-T02 | NetworkPolicy test: only `model-gw` can reach the provider egress; mcp-gateway can only reach read-api/command APIs with the caller's tenant token (no service-wide superuser token). |
| DEP-T03 | After a Pinecone index rebuild from restored Postgres, the I7 isolation tests (TI-K1, TI-K11, TI-K12, TI-K15) rerun and pass; after PITR restore, RLS two-tenant tests rerun and pass; IT-05 (§2.9.1) passes after both restores. |
| DEP-T04 | During chaos C6 (Pinecone unavailable) and C8 (Redis down), cross-tenant retrieval and cache tests still deny. |
| DEP-T05 | A replay/eval Job running in `gg-ai` cannot read another tenant's content without that tenant's context (RLS), even with the eval service role. |
| DEP-T06 | The mock-LLM load run seeds two tenants' secret facts; no response to tenant B contains tenant A's fact (automated string check over 100% of load responses). |

## 2.12 Acceptance gates (I13)

| Gate | Criterion |
| --- | --- |
| I13-G1 | `terraform apply` from an empty AWS account (a dedicated sandbox account under the Organization) → working staging cluster with all pools; `terraform destroy` clean; both in CI evidence. |
| I13-G2 | Signed-image enforcement: unsigned image rejected in prod namespace (evidence of denial). Model manifest verification rejects a tampered weight file. |
| I13-G3 | GPU scale-to-zero (**generation only**, README R21): pool at 0 nodes within 30 min of the last demand (KEDA cooldown 15 min + `consolidateAfter` 10 min, §2.2), and a Prometheus outage does not keep a GPU node up (`fallback.replicas: 0`); measured cold start (p50/p95 over 10 trials, split into node-ready, image, weights and engine-ready phases) recorded against the §2.2 provisional budget (p95 ≤ 10 min), and the Spot-unavailable path (time to gated On-Demand or to the explicit unavailable answer) measured separately; no non-`self_hosted_only` turn waits on a cold GPU for generation (served via the Claude route, verified in traces); `self_hosted_only` turns wait ≤ 15 min with the UI notice. Guard, embedding and reranker models run on CPU and are unaffected by the GPU pool being at zero. Needs the Stage 12 EKS platform. |
| I13-G4 | Argo Rollouts: a deliberately bad prompt (drops citations) is auto-aborted by `ai-online-eval`/`ai-offline-eval`; a cost-bloat prompt is aborted by `ai-cost-per-task`; a good change promotes. Three recorded AnalysisRuns. |
| I13-G5 | ML rollout per README R10 end to end: shadow (table-only, zero shadow rows on Kafka) → flag-cohort canary inside ml-scoring driven by a Git manifest commit → promotion; a worse challenger is refused; rollback sets the cohort to 0% within seconds and opens an automatic Git revert PR, and the MLflow reconciler follows Git. |
| I13-G6 | k6 combined Tier 1 AI run at the I0 A-copilot rate passes §2.7 criteria; evidence `STAGE_13_TIER_1_AI.json` plus the real-slice report. |
| I13-G7 | All chaos experiments C1–C13 executed with results table, none of the "must never happen" observed. |
| I13-G8 | DR drills for every row in §2.9 with measured RPO/RTO, and IT-05 delete → restore → zero (§2.9.1) passes. |
| I13-G9 | Budget (README R22): 30-day demo run within the owner's caps (infrastructure ≤ $600, product ≤ $300, eval ≤ $100) and product LLM spend ≤ $300/month (local real-Claude ≤ $60 of it) and eval Claude ≤ $100/month in total; weekly T2 eval runs ≤ $12 each (R22); exhaustion returns 429 `budget_exhausted` with `Retry-After`; kill-switch tested once (AWS Cost and Usage Report or Cost Explorer export as evidence; billing data lags, so the model-gw hard cap is the real-time enforcement). The EKS part needs the Stage 12 platform. |
| I13-G10 | Launch checklist (§2.13) signed off. |
| I13-G11 | Sandbox AMI: every AMI in use has a stored escape-suite and egress-suite report, an age ≤ 45 days, and the build, test and upgrade pipeline of §2.2 has run once end to end (including a rollback to the previous AMI). |
| I13-G12 | LLM channels: if the Bedrock channel is enabled, every row of the §2.3.2 capability table is confirmed or explicitly marked unsupported by contract tests against the real service, with recorded model IDs and quotas; otherwise the channel is verified disabled. |

## 2.13 Production launch checklist (AI layer)

1. All I12 and I13 gates are green, and the evidence is linked in `docs/MILESTONES.md`.
2. Threat model for the AI layer (prompt injection, tool abuse, data exfiltration, cost DoS). The external penetration test includes the copilot and MCP surfaces (review O4, G2).
3. Data classification for prompts and content (the existing `docs/DATA_CLASSIFICATION.md` is extended). Retention is configured. The crypto-shred proof passes.
4. Provider agreements: data-use and retention settings for the Anthropic API org are confirmed. Rate-limit tier and quota are sufficient for the certified tier (G7).
5. Model licences are recorded in manifests.
6. Budget caps and alerts are configured and the kill-switch has been tested.
7. On-call: every AI alert has a runbook, and the runbooks have been rehearsed at least once (tabletop).
8. User-facing disclosure: AI-generated content is labelled, approval is required for write actions, and there is a feedback control.
9. Rollback rehearsed for the image, prompt/config, vLLM model and ML model alias.
10. DR drills done. Backups are verified by restore, not just by existence.
11. SLOs are published internally, with an error-budget policy agreed with the owner.

## 2.14 Senior topics covered (I13)

EKS/Karpenter GPU capacity engineering (Spot with gated On-Demand fallback, scale-to-zero, cold-start budget, stockouts), custom-AMI gVisor sandbox lifecycle, event-driven autoscaling (KEDA), progressive delivery for non-deterministic systems (eval- and cost-aware analysis, statistical power, inconclusive handling), shadow deployment for streaming ML, supply-chain security for images and **models** (signing, SLSA provenance, manifest verification, licences), EKS Pod Identity (IRSA) least privilege, GitOps for config and model aliases, open-loop load testing with provider mocking (certify platform not provider), chaos engineering with explicit invariants, DR with measured RPO/RTO for ML assets, FinOps guardrails.

## 3. ADRs to write

| Placeholder | Decision |
| --- | --- |
| ADR-AI-O1 | GenAI telemetry schema: OTel GenAI semconv pinned to `semantic-conventions-genai@e57c543`, `gg.*` namespace, content opt-in local only |
| ADR-AI-O2 | Observability backend: self-hosted LGTM (shared with Stage 11); Phoenix local/staging only; Langfuse rejected; AMP/AMG as Tier U option; CloudWatch only for AWS-managed service metrics |
| ADR-AI-O3 | Single encrypted tenant content store in grain-advisor, per-tenant HMAC for content hashes, crypto-shred (README R20, R23, R26; links review O1/O2) |
| ADR-AI-O4 | Tail-sampling policy and async-boundary linking (extends ADR-0004) |
| ADR-AI-O5 | AI SLOs and error-budget policy (judged SLIs) |
| ADR-AI-O6 | AI usage ledger via outbox as the billing source (with Stage 09 billing-service) |
| ADR-0024 (fixed number, README R30) | **Accepted 2026-09-29:** AWS/EKS as the production platform (supersedes an earlier GCP draft; matches the `infra/terraform` README). Open follow-ups inside it: EKS Auto Mode versus Karpenter on standard EKS, MSK versus Strimzi, MSK Serverless suitability. I13 EKS work waits for the Stage 12 platform |
| ADR-AI-D2 | GPU scale-to-zero with KEDA + gateway fallback (no request hold) |
| ADR-AI-D3 | Progressive delivery for prompts/models/config with AI-aware analysis; ML models: Git manifest authority, table-only shadow, flag-cohort canary and rollback (README R8, R10) |
| ADR-AI-D4 | Image and model artifact signing/provenance and admission (Kyverno `verifyImages` vs Sigstore policy-controller; keyless vs KMS key) |
| ADR-AI-D5 | Load certification with mock LLM (platform overhead definition) and real-slice calibration |
| ADR-AI-D6 | Secrets: ESO + AWS Secrets Manager + EKS Pod Identity (IRSA where Pod Identity is unsupported) |
| ADR-AI-D7 | Sandbox node group: custom-AMI gVisor build, test, upgrade cadence, per-AMI escape/egress suites |
| ADR-AI-D8 | GPU Spot capacity: Karpenter NodePools, gated On-Demand fallback, cold-start budget |
| ADR-AI-D9 | Claude on Bedrock as an optional, separately-capabilitied provider |

## 4. Claude skills to load when implementing

`wshobson-distributed-tracing`, `addyosmani-observability-and-instrumentation`, `wshobson-python-observability`, `wshobson-slo-implementation`, `wshobson-prometheus-configuration`, `wshobson-grafana-dashboards`, `wshobson-incident-runbook-templates`, `wshobson-llm-evaluation`, `ecc-cost-tracking` / `ecc-cost-aware-llm-pipeline`, `wshobson-gdpr-data-handling`, `wshobson-helm-chart-scaffolding`, `wshobson-gitops-workflow`, `wshobson-k8s-security-policies`, `wshobson-k8s-manifest-generator`, `ecc-kubernetes-patterns`, `ecc-canary-watch`, `wshobson-terraform-module-library`, `wshobson-secrets-management`, `wshobson-deployment-pipeline-design`, `wshobson-ml-pipeline-workflow`, `wshobson-cost-optimization`, `wshobson-postmortem-writing`, `wshobson-architecture-decision-records`, `claude-api` (for Anthropic usage/caching fields and pricing, never from memory), `context7--find-docs` (KEDA, Argo Rollouts, vLLM, EKS versions at implementation time).

## 5. Sources consulted

- OTel GenAI semantic conventions, `github.com/open-telemetry/semantic-conventions-genai` @ `e57c543` (2026-09-24): `docs/gen-ai/*.md`, `reference/reports/*`, `docs/gen-ai/mcp.md`.
- [Amazon EKS best practices: AI/ML compute and autoscaling](https://docs.aws.amazon.com/eks/latest/best-practices/aiml-compute.html); [EC2 Spot Instance interruption notices](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html); Karpenter interruption handling as summarised by search results (Karpenter docs not fetched); KEDA docs (not re-fetched); [scale-to-zero GPU POC (cold-start measurements, cloud-agnostic)](https://github.com/abdulfahad66-png/scale-to-zero-gpu-inference-poc). Third-party L4 prices and any g6 Spot price or capacity figure must be re-verified at I0/I13; none is asserted here.
- Bedrock parity (search-result level only): [Claude Platform on AWS, feature support](https://docs.aws.amazon.com/claude-platform/latest/userguide/feature-support.html); [Claude on Amazon Bedrock (Opus 4.6 and earlier)](https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock-legacy); [AWS Insider on 1-hour prompt caching](https://awsinsider.net/blogs/awsinsider-release-radar/2026/01/amazon-bedrock-now-supports-one-hour-prompt-caching.aspx).
- Repository: `packages/otel/src/index.ts`, `docs/adr/0004-tracing.md`, `docs/CAPACITY_MODEL.md`, `docs/SCALE_AND_PRODUCTION_READINESS.md`, `docs/runbooks/saga-alerts.rules.yml`, `infra/*/README.md`, `infra/staging/compose.yaml`.
