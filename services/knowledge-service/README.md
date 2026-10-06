# Knowledge service

Status: **local RAG pipeline, authenticated HTTP surface, and encrypted source
object adapter implemented; live acceptance and production identity/deployment
remain pending**.

The upload request stores an immutable original in SSE-KMS S3, then commits a
queued document version and an ID-only transactional outbox row in PostgreSQL.
The relay publishes `greenguard.knowledge.document.index.requested.v1` to Kafka
and marks the outbox row published after broker acknowledgement. The indexer
validates the tenant-scoped event, fetches and hash-checks the S3 PDF, parses it
with PDFium, writes canonical chunks/outlines, embeds in bounded batches, and
upserts vectors to Pinecone. The version becomes `ready` only after projection
succeeds. Kafka offsets are committed after successful processing or durable quarantine.
Temporary failures retry in-process for up to five attempts, with waits of
15, 30, 60 and 120 seconds. A crash before completion causes Kafka redelivery.
The event handler is idempotent and parked events can be replayed by an operator.

Suggestion usage follows the same outbox pattern: relay events go to
`greenguard.knowledge.assistant.suggestion.used.v1`, then the separate
`suggestion-analytics` consumer deduplicates by tenant/event ID and upserts
per-tenant UTC-day/suggestion PostgreSQL counts in one transaction. Kafka
delivery is at-least-once; duplicate events do not increment the count twice.
The BFF remains responsible for incrementing tenant Redis ranking after the
durable usage endpoint succeeds.

Queries retrieve candidates from Pinecone, PostgreSQL FTS, PageIndex-style
outline search, and reviewed graph search. RRF merges candidates; request-time
hydration rechecks RLS, role, principal ACL, current version, and deletion state
before reranking and answer generation. Citations are validated against the
selected passages.

## HTTP API

Run `PYTHONPATH=services/knowledge-service python services/knowledge-service/serve.py`
with the configuration below. Place it behind a trusted TLS ingress; the default
bind is loopback. The API supports:

- `POST /v1/documents/{document_uuid}` with `application/pdf` and
  `X-Document-Version`. Requires an `operator` or `admin` binding. It stores the
  source and queues indexing, returning `202` with the event ID and `queued` status.
- `GET /v1/documents/{document_uuid}/versions/{version}` returns processing status.
- `POST /v1/query` with `{"question":"..."}` and optional `candidate_k` and
  `context_k`. Returns an answer, validated citations, and retrieval counts.
- `POST /v1/assistant/suggestions/{suggestion_id}/used` records use of one of
  `grain_moisture`, `storage_checks`, `mold_risk`, `grain_drying`, or
  `document_summary`. It requires the authenticated user's `Idempotency-Key`
  UUID and current tenant membership. The tenant comes only from verified
  membership; no user ID, question, or answer is recorded. A retry with the
  same tenant/key/suggestion returns the original event; reusing the key for a
  different suggestion returns `409 idempotency_conflict`.
- `GET /v1/assistant/conversations` lists the authenticated user's recent chats.
- `POST /v1/assistant/conversations` creates an empty chat after the user begins
  the first send. `GET /v1/assistant/conversations/{conversation_uuid}` loads
  messages and validated source citations. `POST
  /v1/assistant/conversations/{conversation_uuid}/messages` runs the authorized
  RAG flow, then atomically stores the user message, answer, and citations.
- `DELETE /v1/assistant/conversations/{conversation_uuid}` soft-deletes a chat
  immediately from the user's history. Rows are tenant- and principal-scoped by
  forced RLS; IDs supplied by the client never select a different owner. The
  conversation-retention worker hard-deletes rows after the retention window;
  see the "Conversation deletion" section.
- `GET /healthz`.
- `GET /readyz` checks PostgreSQL connectivity and performs a bounded,
  authenticated Control Plane membership lookup using a reserved non-user
  readiness subject. The expected owner response is 404; this confirms the
  service credential and lookup route without requiring a real user or logging
  identity data. Missing/invalid credentials, denied lookup, timeout, or owner
  outage keep the pod unready. `/healthz` remains a process-only liveness check.

API calls require an IdP RS256 bearer token and `X-Tenant-ID: <tenant-uuid>`.
The tenant header is only a selector. After issuer/audience/signature/expiry
verification, the production/default service obtains that membership from the
Tenant Control Plane on every authenticated operation and requires its returned
tenant to match the untrusted `X-Tenant-ID` selector. Roles never come from the
IdP or the local Knowledge membership mirror. Missing, revoked, foreign-tenant,
or ambiguous membership is denied; invalid tokens mean 401; Control Plane/JWKS
outages fail closed with 503. Long-running RAG/summary operations recheck the
owner and current role before returning or beginning another provider call.
Knowledge also keeps a bounded per-process membership-version high-water mark:
owner responses that regress or replay changed roles at the same version fail
closed; a missing lookup fences the last observed version until a newer owner
version appears. This supplements the uncached owner lookup and is not a shared
revocation cache across replicas.
The local PostgreSQL membership table remains for explicitly enabled local
synthetic tests; production user authorization does not depend on rows there.

`serve.py` has no static-token mode or registry fallback. Digest bindings remain
only for explicit loopback fixture servers used by existing acceptance helpers.
Do not use those helpers as production entry points.

## Runtime configuration

Required environment variables:

- `KNOWLEDGE_DATABASE_URL` for PostgreSQL, using a non-owner `knowledge_app`
  role with forced RLS policies active.
  Kubernetes HTTP API receives this DSN from `greenguard-knowledge-runtime`;
  background worker Deployments receive a separate `knowledge_worker` DSN from
  `greenguard-knowledge-worker-runtime`. The latter is a distinct non-owner,
  `NOBYPASSRLS` login with only the documented consumer grants from migration
  `000019_worker_database_role`; tenant/user RLS remains enforced for each job.
- `CONTROL_PLANE_URL` and `CONTROL_LOOKUP_TOKEN` for authoritative membership
  reads. The lookup credential must be at least 32 bytes and is never logged.
  The default `KNOWLEDGE_MEMBERSHIP_SOURCE=control-plane` makes a bounded
  two-second HTTPS request to the owner for each user operation. Internal
  service-mesh HTTP is accepted only when `CONTROL_PLANE_MESH_MTLS=true` and
  the URL is exactly `http://tenant-control-plane.greenguard.svc.cluster.local:3010`.
  Redirects, other cleartext URLs, missing/revoked memberships, foreign tenant
  selectors, malformed responses and owner outages fail closed. The same owner
  credential is required by the asynchronous summary worker to recheck queued
  user authority before each batch.
- `KNOWLEDGE_MEMBERSHIP_SOURCE=postgres` is available only when
  `KNOWLEDGE_ENVIRONMENT=local-synthetic`; it uses the local membership table
  for fixture acceptance and cannot be enabled in production.
- `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL`: configured HTTPS IdP/API
  audience and JWKS endpoint. Tokens need `iss`, `aud`, `sub`, integer `iat`/`exp`,
  maximum one-hour lifetime, and valid optional `nbf`. Identity tokens marked
  `token_use=id` are rejected. Configure an API access-token audience at the IdP.
- Optional MCP owner trust: set `DELEGATED_ISSUER` and
  `DELEGATED_JWKS_URL` together. The service keeps the Dex verifier for direct
  user traffic and falls back to a separate `knowledge-service` audience only
  for a valid delegated token. The delegated path requires `token_use=delegated`,
  exact `knowledge:read` scope, the `grain-advisor` actor, and current
  tenant-scoped membership; issuer/JWKS endpoints must be HTTPS outside the
  explicit local-synthetic test mode.
- Relay only: `KNOWLEDGE_RELAY_TENANTS_FILE`, a protected JSON array of tenant
  UUIDs assigned to the relay. It no longer reads caller token bindings.
- `KNOWLEDGE_MODEL_GATEWAY_TOKENS_FILE`, a JSON mapping tenant UUIDs to
  tenant-bound task tokens known by the model gateway.
- `KNOWLEDGE_MODEL_GATEWAY_URL` and logical model names
  `KNOWLEDGE_EMBEDDING_MODEL`, `KNOWLEDGE_RERANKER_MODEL`, and
  `KNOWLEDGE_ANSWER_MODEL`.
- `PINECONE_INDEX_HOST`, `PINECONE_API_KEY`, and
  `KNOWLEDGE_NAMESPACE_HMAC_KEY` (at least 32 bytes represented as hex).
- `KNOWLEDGE_S3_BUCKET`, `KNOWLEDGE_S3_REGION`, and
  `KNOWLEDGE_S3_KMS_KEY_ID`. AWS credentials come from the SDK default chain
  (prefer workload identity). Optional `KNOWLEDGE_S3_ENDPOINT` is for a local
  S3 compatible emulator only.
- `KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS` for relay and indexer processes. Optional
  `KNOWLEDGE_KAFKA_SECURITY_PROTOCOL` enables SASL and requires
  `KNOWLEDGE_KAFKA_SASL_MECHANISM`, `KNOWLEDGE_KAFKA_SASL_USERNAME`, and
  `KNOWLEDGE_KAFKA_SASL_PASSWORD`.

The app binds to `KNOWLEDGE_LISTEN_HOST` (`127.0.0.1` by default) and
`KNOWLEDGE_LISTEN_PORT` (`8080`). See `migrations/` for schema changes.

Suggestion-use events are committed to the append-only, forced-RLS
`assistant_suggestion_usage_outbox` table in the same PostgreSQL transaction
as the idempotency check. `Idempotency-Key` is the event UUID; the CDC row has
only `tenant_id`, `event_id`, `suggestion_id`, and `created_at`. The relay
publishes this content-free event to Kafka after leasing the row and marks it
published after broker acknowledgement. The `suggestion-analytics` consumer
checks that the event matches the tenant-scoped outbox record, deduplicates it,
and updates the PostgreSQL daily aggregate in one transaction. The BFF updates
the expiring Redis ranking after durable acceptance; Redis is a ranking cache,
not the analytics source of truth.

## Local checks

```sh
make knowledge-rag-test
make model-gateway-test
```

The first target runs unit tests and launches/removes its own disposable
PostgreSQL 16 acceptance container. It covers actual PDF parsing, canonical
storage, RLS/ACL, indexing outbox, FTS, dense retrieval doubles, PageIndex,
reviewed graph, RRF, authorized hydration, reranking, citation validation, and
the HTTP boundary. The second target tests the Go model-gateway request and
provider boundary.

Run `PYTHONPATH=services/knowledge-service python services/knowledge-service/worker.py`
with `KNOWLEDGE_WORKER_ROLE=relay`, `indexer`, or `suggestion-analytics` to start
the Kafka processes. `KNOWLEDGE_SUGGESTION_ANALYTICS_GROUP_ID` optionally sets
the consumer group (default `greenguard-knowledge-suggestion-analytics-v1`).
The local PostgreSQL acceptance invokes the indexing handler after upload; it
does not connect to a live Kafka broker, S3, model provider, or Pinecone service.

Conversation deletion is soft-delete first. The `conversation-retention` worker
hard-deletes only rows whose `deleted_at` is older than
`KNOWLEDGE_CONVERSATION_RETENTION_DAYS` (default 30 days). It reads a protected
JSON allowlist of `{tenant_id,user_id}` scopes from
`KNOWLEDGE_RETENTION_SCOPES_FILE`, applies forced-RLS settings for each scope,
and deletes at most `KNOWLEDGE_CONVERSATION_RETENTION_BATCH_SIZE` (default 100)
rows per scope per sweep. The default sweep interval is one hour. Message and
citation rows cascade from the conversation delete. Configure principal scopes
from the authoritative membership source; never populate this file from
untrusted request data. Migration `000009` adds a partial index for the sweeps.
Start it in the opt-in compose profile with
`docker compose -f infra/knowledge/compose.yaml up -d knowledge-conversation-retention`.

Before deploying the analytics worker, provision
`greenguard.knowledge.assistant.suggestion.used.v1` and
`greenguard.knowledge.assistant.suggestion.used.v1.quarantine`, configure
producer/consumer ACLs, and apply migrations through `000008`. The relay needs
produce access to the usage topic; analytics needs consume access to that topic
and produce access to its quarantine topic. Give the consumer a stable group ID
(`KNOWLEDGE_SUGGESTION_ANALYTICS_GROUP_ID`). The current worker configuration
uses the shared `KNOWLEDGE_DATABASE_URL` and Kafka credentials; production
should scope topic ACLs to each process and can use a narrower analytics DB
identity with the table grants defined in migration `000008`.

## Still required before production

- Finish external IdP/browser-session acceptance through the BFF, with real
  memberships provisioned in the Tenant Control Plane; Knowledge now resolves
  membership from that owner per operation rather than requiring local row sync.
- Complete I6 gateway controls: PostgreSQL budget reservations, durable usage
  ledger and outbox, provider-specific routing, revocation, entitlements, and
  rate limits.
- Run acceptance with real model provider credentials, a provisioned Pinecone
  index, an S3 bucket/KMS key, and production PostgreSQL roles. No provider
  credentials or live cloud resources were available for this local run.
- Complete document deletion/retention workflows, OCR for scanned PDFs if in
  scope, deployment manifests, and production telemetry. Conversation soft-delete
  and delayed hard-delete are implemented; configure authoritative retention scopes
  in the deployed runtime. Durable indexing
  failure quarantine and operator replay are implemented below.
- Wire authenticated API routes into read-api/BFF and verify ingress/network
  policy before any user exposure.

## Index failure recovery

Migration `000003` stores failure attempts under forced tenant RLS. Invalid
PDFs are parked immediately; temporary failures are retried with exponential
backoff and parked after five failed attempts. The worker commits the offset
only after either successful indexing or durable failure persistence. Malformed
indexing and suggestion-use messages are acknowledged only after a
coordinate-only receipt reaches their respective `.quarantine` topics. Provision
`greenguard.knowledge.assistant.suggestion.used.v1` and
`greenguard.knowledge.assistant.suggestion.used.v1.quarantine` with producer,
consumer, and operations-only ACLs alongside the existing indexing topics.

After correcting a provider outage, requeue a failed document with:

```sh
PYTHONPATH=services/knowledge-service python services/knowledge-service/replay.py \
  --tenant <tenant-uuid> --event <event-uuid>
```

Run `PYTHONPATH=services/knowledge-service .local/knowledge-venv/bin/python
services/knowledge-service/kafka_acceptance.py` for disposable real Kafka and
PostgreSQL acceptance. S3/model/Pinecone use local adapters in that run.

The opt-in `infra/knowledge/compose.yaml` runs separate API, relay, indexer, and
suggestion-analytics processes with read-only filesystems, a non-root user and restart policies.
Set `KNOWLEDGE_RUNTIME_ENV_FILE` and `KNOWLEDGE_SECRET_DIRECTORY`; secret file
paths in runtime configuration must use `/run/secrets/...`. Provision database
roles/migrations, encrypted S3, Kafka topics and provider configuration before
starting it. Only the loopback API port is exposed. This deployment profile
still requires the platform authenticated BFF integration before user exposure.

## Parser isolation and malware scanning

The deployed indexer requires `KNOWLEDGE_PARSER_IMAGE` (an image digest) and
`KNOWLEDGE_CLAMAV_HOST`. It obtains a clean ClamAV INSTREAM verdict before
launching PDFium in a fresh `runsc` container. The container receives PDF bytes
on stdin, has no network or source credentials, and returns passage content
only. The trusted indexer validates output sizes, pages, headings and fields,
then reconstructs tenant/document identity and canonical chunk IDs.

The sandbox launcher currently uses the Docker runtime on a dedicated Linux
host with gVisor installed. It must run as a host-owned supervisor; do not mount
the Docker socket into the indexer Compose container. The Compose profile needs
a remote sandbox adapter before it can deploy this indexer configuration. A
Kubernetes gVisor pod launcher, malware scanner deployment, workload IAM and
secret-manager integration remain required for the EKS design. Local tests
validate output rejection and binding, not gVisor escape or egress isolation.

Kubernetes prerequisites and required pod security settings are recorded in
`infra/knowledge/parser/`. Applying a RuntimeClass alone does not install gVisor
or prove isolation; the dedicated-node acceptance suite remains pending.

## Kubernetes secure parser runtime

Production indexer defaults `KNOWLEDGE_PARSER_BACKEND=kubernetes`. It requires
a reviewed kubectl binary (build `Dockerfile.indexer` with digest-pinned knowledge
and kubectl images), in-cluster identity and the parser launcher RoleBinding.
`docker` remains an explicit dedicated-host option. Each PDF launches a runsc pod
in `greenguard-parser`, waits for readiness, streams bytes to parser_worker via
exec, validates output and reconstructs IDs from trusted event identity, then
deletes the pod. No PDF/source URL/tenant identity enters pod metadata or logs.
The pod receives no service-account token, secret, host mount or cloud IAM role.

Apply namespace/RBAC and default-deny policy before enabling the worker. Limit
concurrency with parser ResourceQuota (eight pods) and worker replica counts.
Resource-exhaustion/scheduling/API errors stay retryable. Deadline stops orphan
execution; the separate janitor removes terminated parser pods. The janitor runs in the
knowledge namespace so a full parser pod quota cannot block cleanup. RBAC allows pod
creation in the dedicated namespace, so indexer identity is a trusted boundary:
namespace security admission and deny-all network enforcement must be verified.
Do not put secrets or workload identity associations in the parser namespace.

ClamAV is a separate private service. Configure `KNOWLEDGE_CLAMAV_HOST` to
`knowledge-clamav.greenguard-knowledge.svc`. Its manifest permits ingress only
from `app=knowledge-indexer` in the same namespace. No clean verdict means no
PDFium invocation. Signature updates require restricted public HTTPS egress;
readiness withdraws at 48h. This staging design uses TCP without transport TLS,
inside the private cluster; production mTLS remains a separate hardening gate.

Future Linux/EKS smoke: `staging_security_acceptance.py --help`. Do not execute
with `--execute` until deployment is authorized. It probes runtime, token absence,
egress denial, read-only filesystem and clean PDF scan/parse. Full security and
RAG staging acceptance remains pending; this smoke does not prove all gates.

## OIDC deployment and membership authorization

Apply `000004_auth_memberships` through the reviewed staging migration pipeline
before switching traffic. The local migration helper remains restricted to the
disposable local database. No production migration has been applied.

The Tenant Control Plane is the authoritative owner of tenant membership and
roles. Its protected `/v1/internal/memberships` endpoint resolves exact
issuer/subject identity, and `/v1/internal/delegated-memberships` resolves the
stable identity UUID for delegated and queued work. Knowledge validates the
bounded response, rejects non-active state and tenant mismatch, and derives the
same stable principal UUID as the owner for existing document ACLs. No local
membership rows are fabricated or trusted for production requests. The RAG
database role cannot create, modify or revoke memberships. The local mirror and
its provisioner remain for isolated synthetic fixtures only.

JWKS requests use only the configured URL, no redirects or token-supplied key
URLs. Fetches use a five-second socket timeout and 256KiB/32-key bounds; RS256/RSA keys must
be public and at least 2048 bits. Cached keys expire after ten minutes; kid-miss
refresh has a 30-second cooldown. Expired caches never authorize during outages.
JWT bodies are bounded to 16KiB, algorithm confusion/unsupported critical headers
are rejected, and clock tolerance is five seconds. Use TLS at ingress and IdP.
JWKS caching is process-local; gateway/ingress rate limits are still required.

Upload authorization is checked under the existing document row lock; HTTP
version uploads preserve its role/ACL policy. Status reads enforce both document
and version roles/ACLs and hide deleted sources. Query hydration keeps its
existing document-role/ACL and forced-RLS checks; tenant membership and role are
checked against the Control Plane on admission and again at completion for
long-running operations. The API returns no credential details.
The BFF must forward the bearer and tenant selector; browser session/BFF wiring
and live provider/RLS/key-rotation/revocation acceptance are still pending.

Request-body reads have a 30-second total deadline. Once shutdown starts, new
upload/query POSTs return draining; active handlers get the configured bounded
drain period before the process exits. In-flight work beyond that deadline may
be interrupted; source/object cleanup and retry/idempotency must cover this.
Configure an ingress header-read deadline as well. Recursive graph retrieval
authorizes each edge before traversal, and indexing requires Pinecone to
acknowledge every vector in each batch before READY promotion.

## Live provider acceptance

`live_provider_acceptance.py --execute` exercises a generated synthetic PDF through
PDFium/chunking, the Go gateway, Voyage embeddings, Pinecone upsert/search, Voyage
reranking and Claude citation validation. It uses a unique synthetic namespace
and deletes uploaded vectors in finally. No private document is uploaded.
This probe does not prove PostgreSQL, BFF/OIDC, Kafka, S3 or gVisor integration.
The separate `postgres_acceptance.py` exercises PostgreSQL with local provider doubles.

Both serve.py and worker.py support `PINECONE_API_KEY_FILE` (protected regular
file, no group/other permissions), with existing environment-key configuration
retained for secret-manager injection. The local provider settings are stored
outside Git at ~/.config/greenguard/secrets/knowledge-provider.env. They still
need the authenticated runtime's database, namespace and object-store settings.

## Local authentication acceptance and provisioning

`postgres_acceptance.py` now also runs `auth_acceptance.py`: a real HTTPS JWKS
server with a temporary locally trusted certificate, signed RS256 JWTs, the
actual HTTP authenticator and disposable PostgreSQL. It checks first-party
membership lookup, ignored forged roles/tenant claims, document ACL denial,
cross-tenant denial, runtime inability to mutate membership, immediate revocation,
stale revision conflicts and transactionally written audit rows. It uses local
model/object/vector doubles; it does not prove external IdP login or browser/BFF
integration. Production HTTPS validation is unchanged.

`knowledge_provisioner` must be provisioned separately as LOGIN NOSUPERUSER
NOBYPASSRLS before migration 000005; the migration grants its membership
SELECT/INSERT/UPDATE and audit SELECT/INSERT permissions. No audit UPDATE/DELETE
is granted. Runtime knowledge_app stays read-only for memberships and has no
audit access. Provisioning uses expected_revision=0 for creation and exact
revision comparison for updates, with audit in the same transaction.

`provision_membership.py --request-file <json>` uses
KNOWLEDGE_PROVISIONING_DATABASE_URL and is restricted to local-synthetic loopback
PostgreSQL and the dedicated role. Request keys: tenant_id, issuer, subject,
principal_id, roles, active, expected_revision, actor_id, reason. This trusted
operator CLI is not an HTTP user endpoint or automatic IdP membership grant.


### Local Dex shared identity acceptance

The local dashboard and RAG use the same Dex issuer, signed access token and
`greenguard-dashboard` audience. Configure `AUTH_ISSUER=http://127.0.0.1:5556/dex`,
`AUTH_JWKS_URL=http://127.0.0.1:5556/dex/keys`,
`AUTH_AUDIENCE=greenguard-dashboard`, `AUTH_ALLOW_LOCAL_HTTP=true`, and
`KNOWLEDGE_ENVIRONMENT=local-synthetic` when running on the host. HTTP is accepted
only with both explicit opt-ins and a literal loopback hostname. Production keeps
HTTPS mandatory. A container cannot reach the host's Dex through its own loopback;
use HTTPS with a routable issuer for container deployments.

Trusted provisioning must use the exact verified Dex `sub` (the opaque connector
subject, not its username), the configured issuer, and a dedicated
`knowledge_provisioner` role. The local provisioning CLI accepts loopback HTTP only
with the same environment settings. `X-Tenant-ID` selects an authorized membership;
caller role/principal headers have no authority. Membership revocation is checked
on every request.

Run the disposable real login gate with no provider credentials:

```bash
KNOWLEDGE_ENVIRONMENT=local-synthetic KNOWLEDGE_DEX_ACCEPTANCE=true \
  .local/knowledge-venv/bin/python services/knowledge-service/postgres_acceptance.py
```

`dex_acceptance.py` starts a pinned disposable Dex on a random loopback port,
uses authorization code plus PKCE with the dashboard client, verifies Dex's real
JWKS, provisions the verified identity, uploads and indexes a synthetic PDF, and
queries grounded citations over HTTP. It also denies a different audience,
missing membership, cross-tenant selectors, forged role/principal headers,
restricted retrieval and immediately revoked membership. Docker containers and
synthetic credentials are removed on exit. Model, vector and object ports remain
local doubles; this proves identity and database authorization, not provider
quality or production deployment. `local_dex.py` exposes the same fixture for the
Advisor acceptance.

## Complete selected-PDF summaries

`POST /v1/query` and `POST /v1/assistant/conversations/{id}/messages`
accept `mode: "document_summary"` with a canonical `document_id` and positive
`document_version`. The normal `question` field remains required. Conversation
ownership is checked before any source/model work; tenant and user identity
continue to come exclusively from authentication.

This mode bypasses embedding, vector top-k, and reranking. It loads **every
ordered canonical chunk** of exactly the selected current, ready version under
Postgres RLS plus tenant, role, ACL and active-membership checks. Each batch is
summarized separately, preserving original ordering and source page metadata;
there is no lossy final reduction. Every supplied chunk must appear in the
validated citation contract. Source text is scanned and redacted before calls,
and access plus the complete source snapshot is checked before each provider
call and after generation. Unsafe evidence or changed access fails the entire
summary rather than quietly omitting a page.

The synchronous operation is explicitly bounded to 64 chunks, 8 provider calls,
8 passages per call, 32,000 UTF-8 text bytes per call, and the existing Gateway's
12,000-byte passage limit. The assembled answer must fit 12,000 characters.
Documents exceeding these limits fail with `document_summary_too_large`; the
service never slices the input or output. Missing batch citations fail with
`document_summary_incomplete`. Summary responses disclose the indexed page
coverage and explain that blank pages and image-only content without extracted
text are not summarized. OCR is disabled in the default parser path; the opt-in isolated OCR worker described below is now available.

`document_summary_source_changed` returns 409; size, safety and completeness
failures return 422; inaccessible, stale or unready versions return 404. Failed
summaries do not persist a conversation turn. Trace metadata records counts of
summary chunks, batches and covered pages without source text.

Summary requests receive a 280-second shared Gateway deadline (normal questions
retain 20 seconds); individual HTTP/provider calls keep their configured timeout.
The per-part output budget divides the remaining 12,000-character allowance,
including headings and coverage text, across all remaining batches.

### Assistant PDF library

Authenticated GET `/v1/documents` returns up to 200 authorized latest PDF versions,
including filenames and processing status. Both tenant RLS and explicit tenant/role/ACL
filters apply. Operator/admin DELETE `/v1/documents/{id}` uses a document row lock and
sets `deleted_at`: retrieval, summaries, source reads and listing deny the document
immediately. This is a soft delete; physical S3/Pinecone retention cleanup remains
a separate pending lifecycle deliverable.

### Durable larger-PDF summaries and OCR

`POST /v1/assistant/summary-jobs` accepts a selected ready PDF version, a bounded
question and UUID idempotency key. It returns `202` immediately. Poll
`GET /v1/assistant/summary-jobs/{jobId}` for `queued`, `running`, `completed`,
`failed`, or `cancelled`, plus completed/total batch counts. `DELETE` cancels and
clears private results. The BFF derives tenant/user identity from authentication.
No user JWT or provider credential is stored in a job.

Run `PYTHONPATH=services/knowledge-service python services/knowledge-service/summary_worker.py`
with the existing Knowledge DB and model gateway environment. The existing
protected gateway token file explicitly bounds the tenants the worker can serve.
A narrowly scoped SECURITY DEFINER discovery function returns at most 100 pending
principal UUIDs for the trusted tenant setting; it returns no content and is
not executable by PUBLIC. Every claim/update/result query is then subject to
forced tenant+user RLS and explicit tenant/user predicates. Migration ownership
must retain permission to perform this discovery (local migration role is the
DB administrator). Claims use `FOR UPDATE SKIP LOCKED`, 5-minute lease tokens,
and a maximum of 3 crash recoveries. Per-batch validated checkpoints resume
without repeating successful model calls. Cancelled/stale worker results are
fenced; current membership and document ACL/version are checked between batches
and again when reading the completed result. Failed providers surface safe codes.
Seven-day job expiry is purged during worker discovery/claim; job output is capped
at 1.5 MB, 2,000 chunks/250 batches and a one-hour execution deadline. This is a
Postgres durable queue, not a DB+Kafka dual write. Deploy multiple workers to scale.

OCR is opt-in: `KNOWLEDGE_PARSER_OCR=true` on the indexing worker. The parser image
includes pinned Tesseract 5.3.0-2 and English language data 1:4.1.0-2. Its only
launcher-visible flag is the fixed non-secret OCR boolean. Text-light pages are
rasterized/OCRed inside the existing network-free non-root parser sandbox, never
in the HTTP process. Bounds: 25 MB/250 PDF pages, 20 OCR pages, 4 million pixels
per raster, 20 seconds per OCR page and 120 seconds per parser session. Documents
above these bounds fail explicitly; no truncated summary is called complete.
Deploy the newly built digest-pinned parser image to enable OCR; existing parser
images do not gain OCR just by changing the flag. gVisor/EKS acceptance remains
a separate Linux/cloud gate.

`summary_quality_evaluation.py` builds a clearly marked 96-page/16-section
synthetic manual, parses its real PDF bytes, summarizes all 96 canonical chunks
with a deterministic model double, and checks expected section/fact anchors and
citation coverage/metadata. Missing-section/missing-citation negative controls
must fail. These checks measure deterministic contract coverage; semantic
faithfulness still requires independently calibrated model/human review and a
reviewed real corpus before a production baseline can be established.

### Explicit Docker Desktop indexing profile

For local feature acceptance where Linux gVisor is unavailable, `local_indexer.py`
provides a separately named `local-synthetic` profile. Production `worker.py` and
its strict runsc/Kubernetes launchers remain unchanged. This profile refuses
remote Postgres (database must be localhost `greenguard_knowledge`), remote
Kafka/S3/Model Gateway endpoints, mutable parser image tags and missing explicit
bounded test-tenant allowlists. It scans with localhost ClamAV, parses/OCRs in a
non-root, network-free, read-only, resource-bounded container using the immutable
local image ID, then uses the same canonical storage and real Voyage/Pinecone
indexing path. No tenant/user credential or provider key enters the parser.

Build `docker build -f services/knowledge-service/Dockerfile.parser -t greenguard-parser:ocr-local .`.
Set `KNOWLEDGE_LOCAL_PARSER_IMAGE_ID` to the built image's immutable Docker ID,
`KNOWLEDGE_RELAY_TENANTS_FILE` to the protected JSON test-tenant allowlist and
`KNOWLEDGE_WORKER_ROLE=relay` or `indexer`, then run the local profile with the
existing protected Knowledge environment. The two processes exercise
transactional outbox → Kafka → scanner → parser/OCR → canonical chunks → Voyage
→ Pinecone → READY. This is local Docker Desktop feature evidence, **not** Linux
gVisor/EKS security acceptance or production deployment.

### Document lifecycle and retention

Migration 017 adds a forced-RLS lifecycle outbox. Document deletion locks the
parent, checks current active operator/admin membership and ACL, then tombstones
and schedules all version vector IDs atomically. Retrying an authorized delete is
idempotent. Retrieval and private PDF source reads deny a tombstone immediately.
Indexing holds the same parent lock through provider calls and publication;
obsolete-vector deletion is a durable intent rather than best-effort cleanup.
Provider failures leave jobs pending with exponential backoff (maximum one hour).

Run `python services/knowledge-service/lifecycle_worker.py` with the existing
private object-store/Pinecone/database settings and
`KNOWLEDGE_LIFECYCLE_TENANTS_FILE` (a protected tenant UUID JSON array). Source
retention is disabled unless `KNOWLEDGE_DELETED_SOURCE_RETENTION_DAYS` explicitly
specifies the existing authorized policy (1–3650 days). Never set this to shorten
an existing policy. After expiry and successful vector cleanup, source deletion
and canonical version cascades execute; immutable IDs/keys remain in the outbox
for crash recovery. Object stores with versioning/legal holds need separate
provider-policy acceptance: deleting a key alone does not prove physical erasure.

`reindex_redacted_document(connection, tenant_id=..., document_id=...,
expected_version=...)` is an explicit operator maintenance operation. It rejects
stale versions and tombstones, sanitizes historical canonical passages and outline
titles, invalidates chunk fingerprints, and schedules the current version through
the normal index outbox. Original PDFs retain their existing policy. Run only
against an approved scope; this operation is not invoked automatically at startup.

Uploads commit an immutable object-key reservation before contacting storage.
The upload transaction locks this reservation through adoption into the source
and index outbox; provider/DB crashes leave it pending. The lifecycle worker
reconciles pending reservations after one hour and removes only unreferenced
keys; adopted source versions are preserved. This also handles idempotent-upload
duplicates without best-effort compensation. Graph facts for a historical
sanitization scope are invalidated because offsets and entity labels require
extraction/review against the sanitized content before reuse.

Local acceptance (disposable pinned PostgreSQL; fake provider ports):
`PYTHONPATH=services/knowledge-service .local/knowledge-venv/bin/python services/knowledge-service/lifecycle_acceptance.py`.
Cloud object versioning/hold enforcement, provider outage recovery and Pinecone
visibility of delete acknowledgments remain external acceptance gates.

Explicit historical maintenance entry point: run
`python services/knowledge-service/reindex_redacted.py` with the database settings
and `KNOWLEDGE_REDACTION_REINDEX_SCOPES_FILE`, a mode-0600 JSON array of approved
`tenant_id`, `document_id`, and `expected_version` objects (maximum 1000). Each
scope commits independently, rejects stale/deleted documents, and emits an index
event ID; the configured normal relay/indexer must process those tenant events
before the version becomes ready again. This command is not run at startup.

For an existing local runtime, `apply_lifecycle_migration.py` accepts only a
mode-0600 `KNOWLEDGE_MIGRATION_DATABASE_URL_FILE`, validates the loopback
`greenguard_knowledge` DSN and prior migration records, and applies/records only
additive migration017 under the standard migration advisory lock. It schedules
no lifecycle work and modifies no document or membership data.

### RAG operations cache and synthetic evaluations

Operator/admin `/v1/ops/cache` returns authenticated-tenant retrieval/embedding lookup counters from this service process, configured TTLs, and a null ratio until there are lookups. Counters are bounded to1000 recent tenants and are neither Redis-health probes nor distributed totals. No prompt, answer, vectors or connection URL is exposed.

Optional `KNOWLEDGE_SYNTHETIC_EVALUATION_REPORT_FILE` points to the required answer-contract CI report. `/v1/ops/evaluations` validates a bounded synthetic report and returns only counts, result, hash and timestamp. The dashboard labels it as platform synthetic contract checks and does not establish a reviewed production baseline. Invalid/missing reports are unavailable.
