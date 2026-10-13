# GreenGuard MCP Gateway

Status: bounded JSON-RPC transport, fixed owner adapters, disposable Helm
profile, and BFF endpoint wiring are implemented and covered by offline tests.
A live multi-service owner acceptance remains an integration gate; tests with injected owners do not prove
the complete Dex → BFF → owner-service production path.

The BFF authenticates the user and sends two classes of signed credentials:

1. `Authorization`: a short-lived `greenguard-mcp` token carrying only
   `tools:read` or `tools:propose`.
2. `X-GG-Owner-Delegations`: a bounded JSON map with only the token required by
   this tool call. The gateway verifies each owner token's BFF signature,
   audience, scope, MCP actor, tenant, subject, roles and expiry binding before
   forwarding it. The gateway has no signing key and no owner service token.

Owner mapping is fixed in code. Knowledge calls use audience
`knowledge-service` / `knowledge:read`; telemetry uses `read-api` /
`telemetry:read`; alert reads use `workflow-alerts` / `alerts:read`; proposal
creation uses `grain-advisor` / `advisor:propose`. Alerts ACK execution is not a
tool. Proposals create approval records only; a separate human approval path is
required to perform an ACK.

The current Control Plane membership is checked before any tool dispatch, and
each owning API independently revalidates the same delegated identity. The
gateway forwards only fixed API paths; model/tool arguments cannot choose URLs,
tenant IDs, SQL, or mutation routes. Owner HTTP calls have a hard two-second
total deadline including DNS/TLS/body via a killable worker process.

## Owner route mapping

- `search_knowledge`, `query_structured_knowledge` → Knowledge `POST /v1/query`
- `get_alert` → Alerts `GET /v1/alerts/{alert_id}` (ETag returned with result)
- `query_device_facts:telemetry_latest` → Read API latest device route
- `query_device_facts:device_alerts` → Alerts filtered read route
- `query_device_facts:risk_history`, `get_risk` → bounded Read API risk route
- `query_device_facts:telemetry_rollups` → bounded Read API rollups route
- `propose_acknowledge_alert` → Advisor `POST /v1/advisor/proposals`; never the
  Alerts acknowledgement endpoint

Read API risk payloads retain the owning service's `validity=unverified` and
`actionable=false` warning. Knowledge/alerts/device facts are returned only
from their owners; no local shadow implementation fabricates responses.

## Configuration

All settings are required at runtime; there are no default credentials:

- `MCP_DELEGATED_ISSUER`, `MCP_DELEGATED_JWKS_URL`
- `CONTROL_PLANE_URL`, protected `CONTROL_LOOKUP_TOKEN`
- `MCP_KNOWLEDGE_URL`, `MCP_READ_API_URL`, `MCP_ALERTS_URL`, `MCP_ADVISOR_URL`
- `MCP_HOST` (default `0.0.0.0`), `MCP_PORT` (default `8090`)
- `MCP_MESH_INTERNAL_HTTP=true` only when STRICT Istio mTLS and the matching
  network policy are enabled; it admits the exact internal service DNS and
  ports above. Otherwise owner and Control Plane URLs must use HTTPS or
  loopback tests.

`/healthz` is process liveness. `/readyz` refreshes and validates the delegated
JWKS and checks the authenticated Control Plane readiness endpoint; failures
return 503 so the deployment does not receive traffic before auth dependencies
are available.

Production owner endpoints must be HTTPS or the exact fixed in-cluster service
authority and port (`knowledge-service.greenguard.svc.cluster.local:8080`,
`read-api.greenguard.svc.cluster.local:4001`,
`workflow-alerts.greenguard.svc.cluster.local:3004`,
`grain-advisor.greenguard.svc.cluster.local:8088`). The Control Plane uses
`tenant-control-plane.greenguard.svc.cluster.local:3010`. HTTP loopback URLs exist for offline tests only. The
container base is digest pinned; publish and deploy only the resulting immutable
image digest. Runtime is non-root and designed for read-only root filesystem.

## Verification

Run `make test`. Tests cover delegated-token audience/actor/expiry and owner
binding, JWKS refresh throttling/backoff and bounded stale-key grace, current
membership and tenant/role isolation, selected-owner forwarding, approval-only
alert proposals, argument bounds, UTF-8 owner responses, startup/readiness,
shutdown admission, and a total slow-header deadline. They use local fixture
owners and do not substitute for live owner acceptance.
