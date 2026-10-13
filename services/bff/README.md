# GraphQL BFF

Stage 08 is in progress. The first slice exposes Stage 07 provisioning status,
start, and operator redrive through authenticated GraphQL. The saga service
remains the command owner; the BFF forwards the verified end-user bearer and
does not accept a tenant ID argument. The saga API enforces tenant RLS and
returns `not_found` for an inaccessible saga. BFF role checks deny mutations
before calling the owner.

Run `npm run test -w @greenguard/bff` or
`npm run coverage -w @greenguard/bff`. For local development set
`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL`, and `SAGA_API_URL` (HTTPS or
loopback HTTP), then run `node services/bff/dist/main.js`. The default port is
4000 and `/graphql` accepts POST requests with an RS256 bearer token.
For a Cognito user pool, opt in with `AUTH_TOKEN_MODE=cognito-access` and
`AUTH_COGNITO_CLIENT_IDS` listing the public web/mobile client IDs. Configure
`AUTH_ISSUER` and `AUTH_JWKS_URL` from that pool. Set `AUTH_AUDIENCE` only when
access tokens use Cognito resource binding, to its exact API resource. This
mode requires trusted GreenGuard membership mapping, preferably
`AUTH_MEMBERSHIP_SOURCE=control-plane`, and rejects ID tokens, wrong clients,
machine-shaped tokens and unrecognized `aud` values. The default remains the
strict audience verifier for Dex.
For Stage 09 machine credentials, set `CONTROL_PLANE_URL` to the private control
plane endpoint and `CONTROL_LOOKUP_TOKEN` to the same internal lookup token
configured on that service. Machine authentication fails closed if the lookup
cannot be completed. Keep this token out of browser configuration and logs.
To secure the BFF-to-saga connection with mutual TLS, set `SAGA_API_URL` to an
HTTPS URL and set `SAGA_MTLS_CA_FILE` (trusted server CA),
`SAGA_MTLS_CERT_FILE` (BFF client certificate), and `SAGA_MTLS_KEY_FILE`
(matching client key) together. Startup rejects partial configuration or a
cleartext saga URL. The client certificate is scoped to saga requests; the
end-user bearer token is still forwarded so the saga API can enforce RBAC and
tenant isolation. Local loopback HTTP remains available when these variables
are absent.

The HTTP endpoint accepts only the checked-in operations in
`src/query-policy.ts`: send `extensions.persistedQuery.sha256Hash` as the
SHA-256 hash of the exact operation text, plus variables. An optional `query`
must match that text exactly. Ad-hoc documents, fragments, multiple operations,
and documents above six field levels or 40 selected fields are rejected before
execution. Authentication runs before operation resolution. When adding a
frontend operation, add and test its exact document in the registry.

Bin readings and trends use the tenant-scoped Read API. Alert v2 detail/list
and transition history forward the caller token to workflow-alerts. Operator
notification history first verifies alert visibility, then composes the
jobs-worker intent page with notification-service delivery details; critical
delivery history remains explicitly `not_configured` until its owner API and
tenant IAM denial proof are available. Configure `JOBS_NOTIFICATION_API_URL`
and optionally `NOTIFICATION_DELIVERY_API_URL` for the owner routes. The BFF
stores no notification database or DynamoDB credentials.

The Read API client has an 8-second overall deadline per call. Safe GET reads
make at most three attempts, each capped at 2 seconds, with 50 ms then 100 ms
backoff for transient HTTP 500/502/503/504, network, or timeout failures.
Other HTTP responses are returned without retry. POST batch reads make one
attempt because an ambiguous POST must not be replayed automatically. Three
exhausted transient calls open a per-ReadClient-instance circuit for 5 seconds; calls
during that interval fail with `read_circuit_open` (503) before contacting the
Read API. After cooldown one probe is allowed; success closes the circuit and
a transient failure reopens it. BFF main currently constructs separate ReadClient
instances for request handling and subscriptions; these breakers do not share state. Mesh
traffic policy still needs separate cluster acceptance.

For distributed rate limits, set `BFF_RATE_REDIS_CLUSTER_NODES` to comma-separated
`redis://` or `rediss://` startup URLs; local development can set
`BFF_RATE_REDIS_URL`. An atomic Redis token bucket applies both tenant and user
budgets after authentication and persisted-operation validation. Read queries
have a default 100-token user burst with 10 tokens/second refill; search, bin
latest, alert lists, and alert history cost 2; bin trends cost 5; composed
notification history costs 5; device history costs 5 or 10. Unknown operations
fail closed. Provisioning mutations use a separate 5-token
user bucket with 5 tokens/minute refill. Exceeded budgets return HTTP 429 and
`Retry-After`; a configured Redis failure returns HTTP 503 rather than sending
unbounded work downstream. These are starting values to tune from load tests.
Alert acknowledgements use an independent 60-token tenant bucket refilling at
1 token/second and a 20-token user bucket refilling at 1/3 token/second. When a
machine principal carries `keyId`, reads also debit a 40-token machine-key
bucket refilling at 4 tokens/second; provisioning and alert acknowledgements
use 5-token and 10-token machine-key buckets respectively. Subscription setup
costs one read token before any owner lookup. A replica accepts at most 100 live
WebSocket connections and runs at most 25 subscription polls concurrently;
fallback poll intervals receive jitter to spread database reads.
The CLI requires Redis unless `BFF_ALLOW_NO_RATE_LIMIT=true` is explicitly set
for local development; production requires cluster startup nodes even if that
local override is present.

With `READ_API_URL` configured, `/graphql` also accepts
`graphql-transport-ws` WebSocket upgrades. The upgrade must carry a verified
bearer token; browser clients obtain a short-lived, single-use ticket from the
gateway, which forwards the bearer. Only the persisted `DeviceChanged`
subscription is accepted. Each subscription checks device visibility through
the Read API and sends the current projection on connect. The BFF then listens
for Redis live hints from the cache invalidator and refetches only affected
devices. Set `BFF_LIVE_REDIS_CLUSTER_NODES` or `BFF_LIVE_REDIS_URL` to the
Read API's Redis cluster (the BFF also accepts `READ_REDIS_*`). During a Redis
outage, it falls back to bounded polling; reconnects always read current durable
state. The connection closes when the bearer expires. Up to five subscriptions
may run per connection and two connections per caller on each BFF replica.
Connections must send `connection_init` within 10 seconds. The server pings
every 30 seconds and terminates peers that fail to answer; closed sockets
release their connection slot, timers and feed listeners.

Set `ALERT_API_URL` to the alert service's HTTPS URL (or loopback HTTP for local
development) to enable GraphQL alert list/detail and acknowledgement. The BFF
forwards the verified bearer, `Idempotency-Key`, and the alert version as
`If-Match`; the alert owner enforces tenant RLS and command concurrency. Alert
lists accept a bounded page size and owner cursor.

For an Istio deployment, set `GG_MESH_INTERNAL_HTTP=1` to permit `READ_API_URL`,
`ALERT_API_URL`, and `SAGA_API_URL` to use HTTP only at Kubernetes Service DNS
names such as `read-api.greenguard.svc.cluster.local`. Deploy this option only
after the namespace and workloads have Istio sidecar injection, STRICT mTLS,
source-specific AuthorizationPolicy, and default-deny NetworkPolicy with
explicit service peers. The live acceptance gate must verify those policies and
show plaintext/unauthorized pod traffic is denied. A successful Helm render
does not prove that gate.

PostgreSQL read fields accept `minimumConsistency: String` and expose the admitted
Read API watermark as `consistencyToken`. Validation binds minima to the verified
principal tenant before forwarding; tokens cannot authorize or choose a route.
Each request/alias carries its own minimum through retries. Live hints with
projection identity and sequence raise the subscription's minimum before latest
is read. Higher epochs advance identity and lower hints are discarded; controlled
409 identity mismatches permit one authoritative reset. Empty results retain the
actual request-local GraphQL response certificate. Persisted DeviceCurrent shares
one aggregate HTTP request and one device/latest SQL snapshot. Reads share the
request deadline and disconnect signal; cancellation does not count as circuit
failure. `streamVersion`
remains the independent event stream version. History/search keep their owning
store semantics and reject unsupported strict PostgreSQL minima. See the
[consistency contract](../../docs/api/bff-read-consistency.md).

Set `ML_OPERATIONS_URL` to the internal ML scorer URL to enable the operator-only
`mlOperations` GraphQL query. The BFF supplies the verified tenant ID from the
end-user principal; the browser cannot choose a tenant. If `ML_OPERATIONS_TOKEN`
is configured, the BFF sends it as `X-Internal-Token` and the scorer rejects
unauthenticated operations snapshots.

### Complete PDF summaries

`POST /v1/knowledge/query` and `POST /v1/assistant/conversations/{id}/messages`
accept `{ "question": "Summarize every section", "mode": "document_summary",
"document_id": "<canonical lowercase UUID>", "document_version": 1 }`.
All three scope fields are required together; versions are positive PostgreSQL
integers. Ordinary questions remain compatible with `{ "question": "..." }`.
The BFF rejects tenant/user overrides and derives tenant identity from the
verified principal. The Knowledge owner enforces document/version authorization
and full source coverage. Summary calls have a bounded 300-second upstream
timeout. Unavailable versions, changed sources and summary safety/size failures
are returned without exposing internal errors.


### Clickable PDF citations

`KNOWLEDGE_API_URL` enables Knowledge/Assistant routes; suggestions additionally
require the rate-limit Redis client. Missing dependencies leave those endpoints
unavailable. Protected `GET /v1/assistant/documents/{id}/versions/{version}/source-info`
returns the stored filename. `/source` proxies at most 25 MiB of PDF bytes after
owner authorization, with `no-store` and `nosniff`. No object keys, presigned URLs
or bearer tokens are embedded in browser links. Filenames on new uploads use an
encoded `X-PDF-Filename` header; the owner validates and stores them per version.
