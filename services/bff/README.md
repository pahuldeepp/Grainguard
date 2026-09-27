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
