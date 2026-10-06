# Synthetic RAG eval v3

## Order and code

1. Active `golden.v3.json` (`rag-guarded-synthetic-v3`): twelve quality questions with synthetic author labels, graded relevance 1–3,
   eight answerable source documents plus role, principal-ACL and foreign-tenant
   distractors, plus five realistic fictional documents and six behavior cases.
   All content is synthetic and version/hash identified. Labels are not independently
   human-reviewed. `golden.v2.json` and `golden.v1.json` are retained as comparison baselines.
   The injection document and explicit override behavior case are expected to block.
2. `knowledge_extensions/evaluation.py`: Recall@K, graded nDCG@K, numeric support
   checks and fail-closed threshold evaluation. Ranking duplicates are rejected.
3. `run_local.py`: parse PDFs, persist/index canonical chunks, then execute the
   **production** FTS/PageIndex/graph/RRF/hydration/reranking path against real
   disposable PostgreSQL. Local hash embeddings, overlap reranking and extractive
   generation are explicit test doubles; this is not a Voyage/Claude quality run.
4. Citation checks compare every ID, document/version and page with the canonical
   fixture and require citations to reference authorized selected context.
5. Deterministic support: reference phrase coverage and unsupported numeric claims
   in cited passages. These are necessary checks, **not semantic faithfulness**.
6. Security: poisoned vector hits for foreign/role/ACL-protected chunks, forged,
   duplicated citations, fixed abstention for missing citations, forced-RLS cross-tenant reads and empty-tenant
   abstention. Any security failure blocks the whole suite.
7. `make verify` runs the eval through `knowledge-rag-test` and its disposable
   Postgres acceptance. CI's required quality job runs the same command; nonzero
   threshold failures block it. Reports are `.local/rag-evals/report.json` and
   `summary.md`; override `RAG_EVAL_OUTPUT_DIR` for artifact collection.

Run the full local gate with `make rag-evals`. No credentials, provider calls or
AWS deployment are required. Docker must run for real PostgreSQL/Redis fixtures.

## Thresholds and interpretation

Recall@10 ≥ .85 on authorized pre-rerank candidates, nDCG@5 ≥ .80 on selected
reranked context, citation metadata accuracy ≥ .98, reference phrase coverage
1.0, zero unsupported numbers and zero security failures. Relevance is evaluated
at document level; repeated chunks of the same document cannot inflate metrics.
The nDCG floor is an initial local regression policy, not a production SLO.
Citation metadata accuracy does not demonstrate semantic citation entailment.

The corpus is small and every question shares a single smoke configuration. It
cannot support statistical non-inferiority, model comparisons or real-domain
accuracy claims. It contains no labelled graph facts, so graph-assisted quality
must be evaluated with a later labelled graph slice; graph safety has separate
Postgres acceptance. Semantic unanswerability with plausible but irrelevant
retrieval is not proven by the empty-tenant test.

## Next funded phase

Add a blinded, held-out labelled corpus with difficult negatives, multi-document
claims, stale versions, answerable/unanswerable slices and human annotations.
Record exact model routes, prompts, prices, fixture hashes and judge calibration.
Run live Voyage/reranker/Claude through the gateway with a capped eval budget.
Use an independent calibrated judge for claim support, semantic citation
entailment and prompt-injection robustness. Per I9, judged metrics remain
warn-only until calibration and sample-power gates justify blocking. Local reports
explicitly mark these as `not_run`; credentials are never silently substituted by
stubs and reported as a live quality run.

## Expanded realistic synthetic corpus (v2)

`golden.v2.json` retains the 12 smoke questions and adds 6 behavior cases:
scoped/ambiguous bin procedures, two conflicting dispatch notices, unknown
insurance and inventory questions, protected-secret extraction, and a malicious
PDF instruction. The runner creates actual PDF fixtures and a combined
`fixtures/synthetic-operations-manual.pdf` beneath the report directory.
These are authored fictional scenarios. Labels have not been independently
human-reviewed; the representative production baseline remains pending.

The local hard gate checks retrieval of both conflicting/scoped sources,
normalization of insufficient-evidence output to fixed abstention, foreign/role/
ACL rejection, document access revocation and stale-version vector rejection.
Case-conditioned answer doubles exercise the contract only: they do not prove
that a model recognizes ambiguity, conflict or malicious instructions. These
behavior results explicitly carry `answer_quality_status: not_run`.

### Real Voyage/Pinecone

`make rag-evals-live` uses the active guarded v3 corpus and production Postgres retrieval
with the configured Go Gateway's `embed-v1` and `rerank-v1` routes and Pinecone.
It requires the protected local staging secret files and a running controlled
Gateway. Synthetic content is sent to providers. Random HMAC namespaces isolate
the workload; attempted vector writes are tracked for cleanup even after an
ambiguous upsert failure. Cleanup errors fail the command and report namespaces
for retry. The disposable PostgreSQL container is removed by acceptance cleanup.
No live credentials are required in ordinary CI; the local hard gate stays mandatory.

### Generated answers and independent review

`RAG_EVAL_CLAUDE=1 make rag-evals-live` additionally calls `answer-v1` for every
quality and behavior case. Generated answer failures are initially warn-only,
recorded separately from retrieval gating. Reports preserve synthetic answer,
authorized context, citations and missing required facts/sources, forbidden
outputs, unsupported numbers and abstention failures. Provider unavailability
marks the run incomplete; it does not turn skipped cases into passes.

`calibration.py` compares explicit independent human and judge claim labels. It
rejects missing/duplicate labels and reports insufficient samples or absent label
classes. Agreement and false-support rate are measured only when both classes
and the configured minimum claim count are present. It never invents human
reviews or equates lexical support with semantic faithfulness. Reviewers should
label each answer claim against cited evidence; distinguish supported,
unsupported, ambiguous and conflicting answers before promoting any judge to a
blocking CI gate. A funded independent judge route and reviewed material remain
external acceptance gates.

Live runs batch/cache embeddings and pace Voyage calls (default 21 seconds) for the free-trial limits documented at https://www.mongodb.com/docs/voyageai/api-reference/overview/. Set RAG_EVAL_PROVIDER_SPACING_SECONDS only to match the configured account limit. Cached vectors and rankings are provider results within one run; each report still records its provider mode.

Run offline calibration after independent annotations exist:

```sh
PYTHONPATH=services/knowledge-service .local/knowledge-venv/bin/python -m evals.calibration \
  --input reviewed-claims.json --output calibration-report.json
```

Each input record needs unique `case_id`/`claim_id`, `human_label` and
`judge_label` (both `supported` or `unsupported`). No prefilled human labels
are shipped. CLI validation rejects absent labels and duplicate claims.

## Prompt-injection enforcement checkpoint

The active retrieval corpus is now `golden.v3.json`, retaining v2 for the historical
live comparison. Its deliberate malicious PDF is expected to be rejected before
indexing and its explicit override question is expected to be blocked. Safe
quality and ambiguity/conflict cases retain their original thresholds. Reports
record the policy version and rejected synthetic documents.

`make prompt-guardrails` runs the required Knowledge Service tests, real disposable
PostgreSQL boundary acceptance and the 41-case authored static attack/benign gate.
`guardrails.json` is preserved beside the RAG reports and uploaded by required CI.
See [PROMPT_GUARDRAILS.md](PROMPT_GUARDRAILS.md) for enforcement and limitations.

## Answer contract regression controls

`knowledge-rag-test` (and required `make verify`) runs
`run_answer_contract.py` against `answer_contract.v1.json`. The 16 authored
synthetic controls include two accepted answers and 14 rejected outputs: missing
sources, numbers borrowed from a different source, duplicate/foreign citations,
forged or absent canonical document/version/page metadata, unsupported numbers,
private canary disclosure, and abstention with nonempty context. Expected errors
must match exactly; disabling checks or overblocking the positive controls fails.
CI preserves `answer-contract.json`, including the corpus SHA-256.

`check_answer` also accepts authored `supported_claims` lexical anchors with
allowed source chunk IDs. The opt-in live Claude evaluation now binds each
expected reference fact to the retrieved chunks containing that anchor and
requires a citation to one of those chunks. This detects missing fact citations
and citation laundering. Exact lexical coverage is a necessary contract check;
it cannot establish entailment, factual truth, or prompt-injection resistance.
No human labels, production baseline, or semantic faithfulness result is invented.
Existing Postgres RAG security acceptance and Advisor policy/approval tests remain
the executable tenant, role, tool, and approval boundary gates.

## Agent tool and authorization contract

`agent_golden.v1.json` contains 12 authored synthetic scenarios: structured PDF
counts, PDF search, latest telemetry, explicit bounded telemetry rollups and risk
history, mixed sequential reads, missing device/readings, revocation before the
second tool and after generation, and acknowledgement requiring approval. Labels
have **no independent human review** and are **not a production baseline**.

`run_agent.py` gates externally observed traces against exact ordered tool names
and arguments, HTTP status, required lexical facts/abstention, forbidden output,
approval state and absence of execution. It requires every case exactly once;
missing, duplicate and unexpected cases fail. Each trace is an object containing
`case_id`, `status`, `calls` (ordered `{tool,args}` planned invocations, excluding
backend evidence replay), `answer` (empty for denied responses),
`approval_required` (boolean), and `executed` (must be false). Credentials and
headers must never be placed in traces. Run:

```sh
PYTHONPATH=services/knowledge-service python -m evals.run_agent \
  --traces observed-agent-traces.json --output .local/agent-evals/report.json
PYTHONPATH=services/knowledge-service python -m unittest discover \
  -s services/knowledge-service/tests -p test_agent_evaluation.py
```

The unit suite supplies explicit evaluator controls, then mutates tool order,
operation/authority arguments, denied answers, approval, missing data and positive
responses. It verifies that disabling boundaries and overblocking allowed reads
both fail. Its constructed controls are **not model results**. The separate
product BFF `assistant-agent-evaluation.test.ts` executes real route orchestration
with scripted planner/tool providers for six sequential/missing-data/authorization
scenarios. Neither suite measures real planner tool-selection accuracy, semantic
faithfulness or production accuracy. Only a separately recorded live trace run
can measure planner selection for this corpus; provider failures/incomplete runs
must remain failures rather than fabricated results. Ordinary CI has no paid
calls or provider credentials.

The existing required `knowledge-rag-test`/`knowledge-test` unittest discovery
(`test_*.py`) includes `test_agent_evaluation.py`; the suite is therefore part of
`make verify` without a separate optional gate or a CI security change.

### Bounded answer/security probes

`run_answer_contract.py` now gates 29 authored controls: canonical citation metadata,
claim-to-source anchors, explicit forbidden nonnumeric/contradictory claims,
answerable and unanswerable abstention, malformed outputs/context, and synthetic
secret canaries (plain, invisible separators, compatibility Unicode, base64 and hex).
These checks detect specified regressions; forbidden claim patterns and lexical
anchors do not establish general semantic faithfulness or citation entailment.

`PYTHONPATH=services/knowledge-service python -m evals.run_answer_live OUTPUT_DIR`
makes at most four `answer-v1` Gateway requests with synthetic context, without
vector writes. Existing protected scoped tokens can be selected using
`RAG_EVAL_GATEWAY_TOKENS_FILE` plus `RAG_EVAL_GATEWAY_TENANT` and an already
authorized funded `RAG_EVAL_GATEWAY_PRINCIPAL`; provider keys are
never read. Reports contain case IDs, contract errors and safe failure codes,
not prompts, responses or credentials. Gateway guardrail rejection remains an
unmeasured model case. Provider/budget failures fail this probe and cannot become
model-security passes. A reviewed real corpus and independent semantic review
remain pending. The broader live retrieval report now also omits raw generated
answer/context text by default.
