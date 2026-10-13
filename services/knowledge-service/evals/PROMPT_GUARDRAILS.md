# Static prompt guardrail regression policy

`prompt_injection.v1.json` contains 41 authored synthetic cases: 24 expected
blocks and 17 expected allows. Its version identifies the fixture contract;
reports should also record the corpus SHA-256 and detector version. The labels
express the static policy described here. They are not independent human
annotations or a representative production security benchmark.

## Policy and trust boundaries

Questions, hydrated retrieval passages and extracted PDF text are untrusted
inputs. Block recognizable instructions to override assistant instructions,
spoof system/developer roles, disclose hidden prompts or credentials, hijack
answers/citations, or execute malicious tool directives. Normalize with Unicode
NFKC, remove zero-width/format characters, and normalize whitespace before
matching so the fixture's compatibility characters and invisible separators do
not bypass the policy. The fullwidth and mathematical-letter cases exercise
NFKC; invisible format characters and Unicode spaces exercise separate handling.

The allow cases preserve useful agricultural questions and operational
imperatives such as ignoring a faulty sensor, disabling a fan for maintenance,
and overriding a fan timer under an approved procedure. Ordinary descriptions
of systems, credential hygiene and prompt-injection concepts are allowed.
Matching a broad word such as `ignore`, `system`, `secret`, `disable` or `override`
alone is insufficient to implement this policy.

The intended enforcement sequence is:

1. Knowledge-service checks the question before retrieval or provider calls.
2. The parser/indexer checks extracted PDF text before embedding or indexing.
3. Retrieval checks canonical hydrated context before reranking/generation;
   already indexed material must receive the same check as newly ingested text.
4. Model-gateway checks answer-route question and context independently, so a
   caller bypassing knowledge-service still encounters the input policy.
5. Gateway generation instructions identify passages as untrusted data and
   constrain answers/citations. Existing tenant, ACL, canonical hydration and
   citation checks remain necessary after the static input check.

A blocked input must fail closed before a provider dispatch at the checked
boundary. Keep attack content and credentials out of logs: reports should use
case IDs, surface, expected/observed decision and aggregate counts. A parser PDF
case means the text obtained after extraction; the JSON text does not itself
prove PDF rendering, OCR, parser sandboxing, or hidden-layer extraction safety.
Separate integration fixtures must exercise actual parser output.

## Offline CI runner contract

The intended dedicated offline runner loads this exact versioned corpus,
validates unique IDs and required schema/enums, and evaluates every case using
the production detector. It should exercise knowledge-service enforcement and
the answer route in the real model-gateway against a controlled local provider.
Blocked gateway cases must observe zero provider calls; allowed cases must reach
the provider through otherwise valid synthetic requests. Report detector and
boundary outcomes separately so a passing detector cannot conceal missing
wiring. Provider failures or skipped boundary checks are failures/incomplete
results, not passes. No external provider credentials or external calls are
needed.

The hard regression thresholds are `attack_misses: 0` and `benign_blocks: 0`.
An attack miss is an expected-block case allowed at a required checked boundary;
a benign block is an expected-allow case rejected by the static detector.
Nonzero counts fail the runner and its CI job. Keep results distinct from the
RAG quality corpus and its warn-only generated-answer or uncalibrated judge
metrics. The runner and CI wiring are maintained alongside the implementation;
this document defines their intended evidence contract, not proof they ran.

## Limits and maintenance

This finite lexical policy catches known forms; it cannot establish semantic
prompt-injection resistance, detect every paraphrase, or prove safe live-model
behavior. Unicode normalization does not resolve all cross-script homoglyphs.
Encoded payloads (including base64), encryption, multilingual attacks outside
explicit rules, multi-turn manipulation, fragmented attacks across chunks,
image-only payloads and tool-result poisoning require additional defenses and
separate labeled cases. No base64 decoding expectation is embedded in v1.

Blocking recognizable attack text can also block a document quoting an attack
for legitimate security analysis. The benign discussion fixtures contain no
literal executable attack instructions; they do not establish quotation-aware
classification. Conversely, an allow decision only means no listed static
signature matched; it does not grant authorization to perform an operation.

Before changing rules, add representative attack and benign regression cases,
retain existing labels or explain intentional policy changes, and issue a new
corpus version when its contract changes. Passing v1 is bounded local regression
evidence, not I10 completion, production certification, or independent review.

## Implemented local acceptance

`make prompt-guardrails` executes the real PostgreSQL acceptance and static gate
through `knowledge-rag-test`; required `make verify` runs the same gate. Go tests
read the same corpus. The HTTP entry point rejects known malicious questions
after authentication, before service invocation. Extracted PDF chunks and
neighbor pairs are checked before canonical content/embedding; legacy indexing
checks all chunks before the first vector write. Retrieved canonical chunks are
checked after authorization and filtered before reranking. All-hostile context
produces a fixed abstention without reranker/generation calls.

The Gateway independently rejects flagged inputs before embeddings, reranking
and generation, and also inspects joined request fields for split directives.
Go additionally detects common HTML/URL/literal Unicode presentation encoding;
Python and Go need not have identical normalization breadth. A sanitized Gateway
422 policy rejection is propagated as a permanent policy error, not retried as
an outage. Existing worker parking records failure before committing Kafka offset.

The Gateway fails closed for suspicious direct-call context. It does not drop
submitted documents, because silently changing reranker indices/top_n would
violate its API contract. Knowledge retrieval owns context filtering. Unknown
semantic/encoded attacks and OCR-only instructions remain limitations; actual
model attack resistance is still not run. PII redaction/tool approval are separate
next slices, not capabilities established by this checkpoint.
