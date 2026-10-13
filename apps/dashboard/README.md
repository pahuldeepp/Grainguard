# apps/dashboard

Status: **Stage 01 foundation complete; Stage 08 provisioning slice in progress**.

Stages: 08.

Technology: React, Vite, TypeScript, Tailwind, Apollo Client, TanStack Query.

Responsibility: Tenant dashboard, device telemetry, risk, alerts, administration and billing.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.

## Stage 01 implementation

Local foundation is implemented. See [setup](../../docs/SETUP.md) for commands, current scope and verification. Domain features described above remain planned.

## Stage 08 provisioning slice

The dashboard now has a provisioning form, status and audit timeline, and a
repair-required redrive action. It sends SHA-256 persisted-operation IDs to the
BFF's `/graphql` endpoint through the gateway on port 4002 via
the local Vite and Nginx proxies. `App` accepts an asynchronous
`getAccessToken` provider; the provider must return a current end-user OAuth
access token. The dashboard does not persist the token or choose a tenant.
Without a configured sign-in/session provider, the production entry point
shows a sign-in integration notice and does not issue provisioning requests.
The BFF and saga API enforce role and tenant access. An administrator role is
required for redrive.

## Browser sign-in

The entry point uses authorization-code PKCE through `oidc-client-ts`. Configure
`VITE_OIDC_AUTHORITY` with the issuer URL, `VITE_OIDC_CLIENT_ID` with a public SPA
client, and `VITE_OIDC_AUDIENCE` with the API audience. Register
`http://127.0.0.1:5173/auth/callback` as the redirect URI and
`http://127.0.0.1:5173` as the post-logout URI for local development. The client
must allow authorization code with PKCE and issue access tokens for the API
audience. Enable refresh tokens for sessions that should renew silently.

Local Vite builds can use those three public `VITE_OIDC_*` values. A production
container loads `/config.json` from its own origin with `Cache-Control:
no-store` before creating the auth manager. It fails closed if that file is
missing or invalid. This lets one immutable image work after Terraform learns
the CloudFront hostname. The dashboard Helm chart can mount the public JSON
from `publicOidc` values and sets `CSP_CONNECT_EXTRA` to the issuer origin.
The file contains only issuer URL, public client ID, token mode, and optional
audience/resource URL; never put secrets in it.

For Cognito set `tokenMode` to `cognito-access`, omit `audience`, and optionally
set `resource` to request a resource-bound access token. If `resource` is set,
the API verifier's `AUTH_AUDIENCE` must match it exactly. Local Docker builds
may still use the `VITE_OIDC_*` build args for development; a production build
must have the deployed `/config.json` available at runtime.

For local testing, Keycloak can supply the IdP: create a realm, a public client
with standard flow enabled, and an API audience mapper. Point the three variables
at that realm, client and audience. The Vite SPA fallback handles the callback.
The dashboard keeps its OIDC user and tokens in memory only; session storage
holds only PKCE redirect state, verifier and nonce. A reload requires sign-in again. It clears query data and
selections when the authenticated session changes. The BFF and Read API must
verify signature, issuer, audience and tenant claims on every request. Live
browser evidence with a configured IdP remains to complete this slice.

## Interface and design

The interface follows [docs/DESIGN_SYSTEM.md](../../docs/DESIGN_SYSTEM.md): a
"field instrument" look with neutral surfaces, one spruce green for identity and
colour spent on severity. Tokens are CSS custom properties at the top of
`src/style.css` (light, and dark through `prefers-color-scheme`); type is in rem
on the system font stack, and there is no web font, image or icon dependency
(a small inline SVG set lives in `src/ui.tsx`). Reduced motion and forced-colors
modes are handled in the same file.

- Severity is always a glyph plus a word (`StatusMarker`), never colour alone.
- Navigation is a top bar from 768 px and a bottom tab bar below it; the current
  page carries `aria-current`.
- Alerts (`/alerts`): open first by severity then age, an Open, Acknowledged,
  Resolved and All filter with counts (counted from the first 25 alerts of each
  state, shown as `25+` when more exist), score and age per row. The filter,
  cursor and selected alert live in the URL (`?state=`, `?after=`, `?alert=`), so
  the browser Back button, links and reloads behave. The list keeps its scroll
  position and returns focus to the row you left. Acknowledging shows a polite
  live confirmation with Back to alerts and Next open alert.
- Overview lists the open alerts (worst first) and service readiness; a banner
  appears only when a service is unavailable or the browser is offline.
- Routes other than Overview load on demand; readiness polling pauses while the
  tab is hidden.

The alert detail shows only what the BFF returns today (score, rule, escalation
level, version, opened and acknowledged times). Bin and site names, thresholds,
sensor readings for a bin, transition history and the notification log need new
BFF queries; see `evidence/STAGE_UI_DASHBOARD_VALIDATION.md`.
`node evidence/stage-ui-dashboard/contrast-check.mjs` verifies every token pair
against WCAG AA.

ReadApi retains the greatest observed PostgreSQL consistency token on its own
instance and supplies it to refreshes of supported read fields. Live DeviceChange
tokens are observed before refetch. Higher epochs advance the identity; late
lower epochs are discarded. Controlled identity409 permits one tenant-bound fresh
snapshot reset within the original deadline, including empty responses certified
by GraphQL response extensions. Outages retain the old minimum. App creates a fresh instance for every
`sessionId` change; `clearConsistency()` invalidates pending context responses.
Cassandra history and search remain eventual unless the caller explicitly
requests a minimum, which unsupported stores reject. See the
[consistency contract](../../docs/api/bff-read-consistency.md).

## ML operations

Operators and administrators can open `/ml` for the ML operations view. It reads
the operator-only `mlOperations` persisted GraphQL query and shows scorer
readiness, prediction volume, inference latency, canary percentage, model
metadata, PSI drift and retraining status. The page refreshes every 15 seconds.
The UI always labels synthetic/shadow models as not production validated and
does not expose promotion or retraining controls to ordinary tenant users.
Set the BFF `ML_OPERATIONS_URL` to enable the query; an unavailable scorer is
shown as a bounded error state rather than replaced with demo data.
