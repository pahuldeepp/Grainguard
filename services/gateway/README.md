# GreenGuard Gateway

The public edge verifies an OIDC RS256 bearer token and forwards the original token to the internal service, which also verifies it. It never accepts tenant identity from a query parameter or caller-supplied `X-Tenant-*` headers. Upstreams must be private; only this gateway should be exposed by the TLS ingress.

Routes:

| Method | Path | Upstream |
| --- | --- | --- |
| GET/POST | `/graphql` | BFF |
| GET | `/api/v1/read/search`, `/api/v1/read/sites/:id/devices`, `/api/v1/read/devices/:id[/latest|readings|rollups]` | Read API |
| POST | `/v1/provisioning`, `/v1/provisioning/:id/redrive` | Saga API |
| GET | `/v1/provisioning/:id` | Saga API |
| GET | `/healthz`, `/readyz` | Gateway |

`/graphql` is the only WebSocket upgrade route. A browser first sends its bearer token to `POST /api/v1/subscription-ticket` and receives a 30-second, single-use ticket. It then opens `/graphql` with subprotocols `graphql-transport-ws` and `ticket.<ticket>`. The gateway binds the ticket to the request Origin, revalidates the bearer during upgrade, strips the ticket subprotocol, and forwards the bearer to the BFF. Query-string tokens are rejected. Native clients may use an Authorization header directly.

## Local run

Build and test with `npm run test -w services/gateway`. Set `AUTH_ISSUER`, `AUTH_AUDIENCE`, and `AUTH_JWKS_URL`, plus `GATEWAY_BFF_URL=http://127.0.0.1:4000`, `GATEWAY_READ_URL=http://127.0.0.1:4001`, and `GATEWAY_SAGA_URL=http://127.0.0.1:8092`. Optional `AUTH_MEMBERSHIP_FILE` maps IdP subjects to GreenGuard tenant memberships. Run `node services/gateway/dist/main.js`. The default bind is `127.0.0.1:4002`.

For machine credentials, configure `CONTROL_PLANE_URL` with the private control
plane endpoint and `CONTROL_LOOKUP_TOKEN` with its internal lookup token (see
`.env.example`). The gateway derives tenant and service-principal identity from
that lookup and fails closed if it is unavailable. Do not publish the lookup
token to clients or logs.

For a TLS Saga API, configure `GATEWAY_SAGA_URL=https://...`, `GATEWAY_SAGA_CA`, and optionally `GATEWAY_SAGA_CLIENT_CERT` and `GATEWAY_SAGA_CLIENT_KEY` for mTLS. TLS verification stays enabled. The gateway checks each upstream for readiness, including Saga `/healthz`.

`GATEWAY_TIMEOUT_MS` defaults to 15000 (maximum 30000); `GATEWAY_MAX_BODY_BYTES` defaults to 1048576 (maximum 10485760); `GATEWAY_HOST` and `GATEWAY_PORT` control the listener. Place a TLS terminator in front of the gateway and restrict direct access to the BFF, Read API, and Saga API. The browser ticket store is process-local, so WebSocket upgrades must reach the same gateway replica that issued the ticket until a shared ticket store is configured. Configure ingress rate limiting before internet exposure.

For Docker, build from the repository root: `docker build -f services/gateway/Dockerfile -t greenguard-gateway .`. Mount the membership and mTLS files read-only when used, and use internal service DNS names for the upstream URLs.
