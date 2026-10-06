# grain-advisor

Status: **Local proposal approval, authorized Alerts execution and durable approval pause/resume are implemented; cloud and complete user-to-agent acceptance remain pending.** `advisor_security` provides bounded tool policy, proposal version/hash, human decision, idempotent owner execution and atomic audit/outbox persistence. The optional PostgresSaver workflow pauses on the already-authorized MCP proposal, resumes only after current delegated identity validation, and receives the owner token as request-local context rather than checkpoint state.

## Ownership

- Datastore: `greenguard_advisor` (tenant-scoped application records and proposals).
  PostgresSaver checkpoints require a separate restricted runtime role and are
  a documented RLS exception; a dedicated checkpoint database is preferred.
  Any MCP proposal tool calls this service's proposal API; model tools cannot
  execute or directly mutate domain state.
- Inputs: authenticated BFF turns and delegated identity; read-only evidence from
  Read API, Knowledge Service, and MCP Gateway under the verified caller's tenant.
- Outputs: grounded answers with citations and `greenguard.ai.interaction.completed.v1`;
  proposed actions are persisted for human decision and, after approval, executed
  by the owner API with ETag/idempotency checks and a durable receipt.
- Security boundary: one bounded LangGraph policy, per-user thread ownership, and
  read-only model tools by default. The model never receives write credentials.

Implementation is gated on I5/I7, GG-08, and the I9/I10 security gates for any
proposal/action path. Add source, migrations, delegated-token tests, tenant-isolation
tests, dependency locks, Sonar/coverage entries, and grounded-answer evidence in I8.

## Delegated HTTP receiver

`advisor_security.receiver.configured_server` configures the receiver using a
public HTTPS JWKS URL, issuer, owning control-plane membership URL and service
token, runtime database DSN, and an explicit Alerts ownership/ETag adapter.
The verifier refreshes authoritative membership on every admission and immediately
before mutation. It intersects the delegated roles with current owner roles.
The caller must provide exactly one Authorization and X-Tenant-ID header;
ambiguous body framing and duplicate JSON fields fail closed. Tokens must be
RS256, at+jwt, one audience and exact route scope, and expire within five minutes.
The adapter exposes proposal, human decision and authorized execution retry routes.
When `ADVISOR_WORKFLOW_DATABASE_URL` is configured, it also checkpoints the exact
proposal before returning and resumes the same tenant/user/run thread after the
BFF approval request. Owner credentials are supplied only to the resume call and
never enter PostgresSaver state. Execution retry remains guarded by current
membership, approval version/hash and the original owner idempotency key.

Run `python services/grain-advisor/serve_delegated.py` with:

- `ADVISOR_DELEGATED_ISSUER`: configured HTTPS BFF delegation issuer.
- `ADVISOR_DELEGATED_JWKS_URL`: configured HTTPS public BFF delegation keys.
- `CONTROL_PLANE_MEMBERSHIP_URL`: owning control API origin (HTTPS, or loopback HTTP).
- `CONTROL_PLANE_MEMBERSHIP_SERVICE_TOKEN`: owner API service credential.
- `ADVISOR_DATABASE_URL`: provisioned Advisor runtime DSN.
- Optional `ADVISOR_WORKFLOW_DATABASE_URL`: restricted runtime role for durable LangGraph checkpoint tables. Before enabling, run `make advisor-workflow-checkpoint-migrate` with the separate schema-owner `ADVISOR_WORKFLOW_MIGRATION_DATABASE_URL` and the already-provisioned `ADVISOR_WORKFLOW_RUNTIME_ROLE`; this creates the saver schema and grants only the checkpoint CRUD needed by the runtime role.
- `ADVISOR_ALERTS_ORIGIN` and `ADVISOR_ALERTS_SERVICE_TOKEN`: owning Alerts HTTPS origin (loopback HTTP locally) and dedicated lookup credential, set together.
- Optional `ADVISOR_HTTP_HOST` and `ADVISOR_HTTP_PORT` (defaults 127.0.0.1:8088).
- Optional `OTEL_EXPORTER_OTLP_ENDPOINT` enables bounded OTLP/HTTP trace export
  (for example, the in-cluster collector URL ending in `:4318`). HTTP is allowed
  only for loopback and `.svc.cluster.local`; other collector endpoints require
  HTTPS. If unset, the service still creates local spans but exports none.

The configured owner adapter checks the current membership, open alert and exact
quoted decimal ETag through Alerts before proposal persistence. The receiver
reverifies delegated membership after this call. Missing owner configuration
returns `503 alert_authorization_unavailable`; partial or unsafe configuration
fails startup. Human decisions retain the durable proposal store semantics.
No migrations or credentials are provisioned at startup. Without the optional
workflow DSN, the legacy HTTP approval path remains available, but does not create
LangGraph checkpoints. This receiver is not an MCP SDK transport or a production
deployment.

`tests/test_security_receiver.py` uses actual locally trusted HTTPS requests for
JWKS and owner membership. It proves role downgrade/removal, owner outage,
cross-tenant owner-response rejection, certificate verification, bounded key
cache, redirect rejection and malformed/private JWKS denial. HTTP tests prove
ambiguous headers/framing and duplicate JSON denial, membership revocation before
mutation and the approved-proposal execution retry route. This is an owner retry
endpoint; it does not accept arbitrary actions or bypass the approval hash/version,
current membership or owner idempotency checks. Proposal expiry is enforced when
the human decision is committed; already approved actions may be retried after
expiry so transient owner failures can recover.

Local ownership acceptance: load the existing local stack `.env`, build
`npm run build -w @greenguard/workflow-alerts`, then run
`PYTHONPATH=services/grain-advisor .local/knowledge-venv/bin/python services/grain-advisor/ownership_acceptance.py`.
This starts actual Alerts on the existing RLS runtime database, a configured
control membership HTTP fixture and signed delegated Advisor HTTP on disposable
PostgreSQL. It proves persistence plus stale/missing/revoked and post-owner
revocation denial. It requires local Docker and migrated Alerts; it uses a
control membership fixture rather than a live control service or production IdP.
Evidence: `evidence/intelligence/alerts-ownership/`.

The synthetic runtime acceptance verifies PostgresSaver worker restart. The
full Dex→BFF→RAG/Agent→MCP→approval UI→owner flow and AWS/EKS deployment remain
open. Track the deployment prerequisites and remaining gates in
[Assistant runtime deployment](../ASSISTANT_RUNTIME_DEPLOYMENT.md).

Ownership HTTP uses a reaped child process to enforce a two-second total deadline
including DNS, TLS, headers and body. A timeout terminates network resources;
slow drips cannot retain an Advisor request slot indefinitely. This adds process
startup overhead per owner lookup. The standard library retains default TLS
verification and rejects redirects; no new HTTP dependency is introduced.

### Tracing

Advisor emits fixed-name HTTP server spans, LangGraph plan/tool/approval spans,
and fixed-name owner/identity client spans. It extracts only a validated W3C
`traceparent`; request baggage and tracestate are not accepted. Internal owner
calls propagate a child `traceparent`; the external JWKS request is traced but
does not receive GreenGuard trace context. Attributes are limited to numeric HTTP
status and a fixed outcome enum. Prompts, response bodies, identities, tenant or
document IDs, tokens, owner URLs, paths and exception text are not recorded.
Trace export uses the pinned OpenTelemetry HTTP exporter with a bounded batch
queue and five-second export/shutdown limits. The AI runtime chart must supply
`OTEL_EXPORTER_OTLP_ENDPOINT` and matching network policy before deployed export
can be claimed.
