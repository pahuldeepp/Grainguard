# Local tool and approval security foundation

## Implemented and executable

`ai/policy/tools.yaml` is the one policy file (JSON syntax, valid YAML). Only
`search_knowledge` and `propose_acknowledge_alert` are enabled in this slice.
Undeployed read tools and aeration recommendations fail closed until their owner
adapters are implemented. There is no shell, URL, SQL, work-order, execute or
hardware-control tool. Schemas reject caller identity and unknown arguments.
Verified adapters must supply tenant/user/role/audience/expiry; none comes from
the model. Read requests use a caller-supplied Knowledge adapter which must enforce
its own current authorization and output policy. Request-local budgets serialize
admission and allow at most 8 calls / 60 seconds, including failed calls. Read
results require the Knowledge answer/citations/retrieval shape and a 32 KiB JSON
bound; owning-API authorization and content safety still apply. Owner adapters
enforce a two-second total deadline covering DNS, TLS, headers and response body.

`advisor_security/proposals.py` persists exact canonical action/target/params/
ETag hashes, deterministic proposal IDs scoped to run/tenant/user, and 15-minute
expiry. Human decisions require an operator/admin principal for Grain Advisor,
matching hash and expected version. UPDATE uses optimistic comparison. A
transaction-scoped advisory lock serializes the same user/idempotency key;
different keys compete through the version check. Lock wait is bounded to 1 s,
SQL to 5 s. Approved/rejected/expired receipts replay exactly; request-key payload
changes conflict. Four-eyes is supported by the policy, off for this v1 action.
Runtime cannot edit immutable proposal payload or expiry columns.

Audit and outbox writes are in the same transaction as state changes. Audit/outbox
payloads contain only IDs and enums, never notes, credentials or model text.
Runtime cannot update/delete audit, outbox or receipt records. The proposal note
is private application content, not emitted in events. Audit denial is durable
only for valid adapter-supplied identities; malformed/unverified identity must
be rejected before this library is called.

`migrate_security.py` checks an already provisioned non-superuser NOBYPASSRLS
`advisor_app` role before applying idempotent migrations. It refuses non-loopback
DSNs and databases other than `greenguard_advisor`; staging migration/deployment
configuration is still pending. It creates no credentials.

The application-owned Advisor tables belong to the separate `greenguard_advisor`
database and use explicit tenant filters and forced RLS; proposals additionally
enforce user ownership with operator/admin decision visibility. LangGraph's
PostgresSaver tables are a documented exception: its saver schema does not
currently support the service's tenant RLS policies. They must use a dedicated,
restricted checkpoint runtime role (preferably a separate checkpoint database),
and the service enforces tenant binding in proposal-scoped thread IDs plus a
verified tenant check on every resume. Checkpoints contain the proposal action,
so database access to them is sensitive. Provisioning a role/identity remains an
adapter responsibility; setting a role in SQL is not authentication.

## Verification

`make advisor-security-test` runs unit policy/concurrency/hash tests and a pinned,
isolated disposable PostgreSQL acceptance. Tests cover cross-tenant denial,
viewer/wrong-audience/expired identity, changed action hash, concurrent decisions,
idempotent retries, expiry replay, four-eyes, read dispatch, immutable records
and rollback if the outbox insert fails. `make verify` requires this target.

## Remaining integration gates

This is a tested local library and persistence foundation, not a deployed agent
or MCP server. Local Advisor proposal, approval, Alerts execution, execution
receipt, and optional PostgresSaver pause/resume are now connected. The saver
requires its explicit schema migration and separate runtime DSN. Production
BFF/Alerts deployment, full Dex→BFF→RAG/Agent→MCP→approval-UI acceptance, durable
distributed per-run budgets, encrypted private interaction content, outbox
CDC/Kafka publishing and retention/export remain open. The configured workflow
passes the approver's fresh audience-bound owner token only in request-local
context; the owner still checks live membership, ETag and idempotency. Model
doubles suffice for these security tests; live Claude evaluation remains
separate. AWS remains untouched.

The local delegated HTTP receiver and current owning control membership adapter
are implemented in `advisor_security/{delegated,jwks,membership,http_api,receiver}.py`.
Receiver tests use real local HTTPS JWKS/owner requests and prove revocation,
owner outages, tenant mismatch and ambiguous HTTP/JSON rejection. See the service
README for explicit configuration. The standalone entrypoint permits proposals when the configured Alerts
ownership/ETag adapter authorizes the current open alert and membership. Absent
owner configuration remains fail closed. Both owner adapters enforce a total
two-second deadline including DNS, TLS, headers and body. These tests
establish receiver behavior; they do not establish deployed Dex/BFF/MCP transport.
