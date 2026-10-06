# Stage 08 OIDC validation

Date: 2026-09-24. Local, uncommitted checkout; CI has not run on this. Design:
[ADR-0014](../docs/adr/0014-oidc-identity.md) (Proposed).

## Environment

- Provider: Dex `ghcr.io/dexidp/dex:v2.43.1@sha256:0881d3c9359b436d585b2061736ce271c100331e073be9178ef405ce5bf09557`
  (digest from `docker buildx imagetools inspect`), `mem_limit: 128m`, started with `make oidc-up`.
- Real BFF (`services/bff/dist/main.js`, :4100 scripted and :4000 browser) and Read API
  (`services/read-api/dist/main.js`, :4101) processes. Both use live Postgres through PgBouncer,
  Cassandra and Elasticsearch, and both verify Dex tokens against `http://127.0.0.1:5556/dex/keys`.
  Test tuning: `AUTH_JWKS_CACHE_MS=20000`, `AUTH_JWKS_COOLDOWN_MS=2000`,
  `AUTH_CLOCK_TOLERANCE_SEC=5`. Saga URL is an unreachable stub (mutations stop at the
  role gate or fail upstream).
- Membership: `infra/oidc/memberships.json`. alice is admin and victor is viewer in tenant
  `0a0a…000a`; bob is operator in tenant `0b0b…000b`. Two `device_views` rows are seeded and then removed.

## Commands and results

`make oidc-test` runs the browser-less authorization code + PKCE flow, with state and nonce checked
by the script. Full log: [stage08-oidc/oidc-test.log](stage08-oidc/oidc-test.log).

```
PASS authorization code + PKCE login (state and nonce validated) :: alice, victor (tenant A) and bob (tenant B)
PASS BFF valid Dex token accepted (alice, tenant A) :: HTTP 200 device=0a0a0a0a-1111-4000-8000-00000000000a
PASS Read API valid Dex token accepted :: HTTP 200 tenant=0a0a0a0a-0000-4000-8000-00000000000a
PASS BFF tenant A cannot read tenant B device :: HTTP 200 device=null
PASS Read API tenant A cannot read tenant B device :: HTTP 200 data=null
PASS tenant B reads only tenant B :: own=0b0b0b0b-1111-4000-8000-00000000000b crossHTTP=200
PASS viewer cannot run a mutation :: HTTP 200 error=insufficient_role
PASS operator passes the role gate (saga stub unreachable) :: error=upstream_unavailable
PASS reject wrong audience (real Dex token for greenguard-cli) :: BFF 401 invalid_token; Read API 401 invalid_token
PASS reject wrong signature (payload re-signed by attacker, Dex kid) :: BFF 401 invalid_token; Read API 401 invalid_token
PASS reject tampered payload with original signature :: BFF 401 invalid_token; Read API 401 invalid_token
PASS reject wrong issuer (forged iss) :: BFF 401 invalid_token; Read API 401 invalid_token
PASS reject alg=none :: BFF 401 invalid_token; Read API 401 invalid_token
PASS reject HS256 signed with the Dex public key :: BFF 401 invalid_token; Read API 401 invalid_token
PASS reject unknown kid (bounded refresh, then 401) :: BFF 401 invalid_token; Read API 401 invalid_token
PASS reject missing token :: BFF 401 missing_token; Read API 401 missing_token
PASS genuine Dex signature but unexpected issuer rejected :: 401 invalid_token
PASS unknown kid refresh is bounded by the cooldown :: 5 unknown-kid verifications -> invalid_token,invalid_token,invalid_token,invalid_token,invalid_token; JWKS fetches=2 (1 initial + exactly 1 kid-miss refresh; the rest fall inside the 2000ms cooldown)
PASS JWKS down: cached key still verifies inside the stale window :: HTTP 200 at +251ms
PASS JWKS down: kid miss inside the cooldown does not hit the key server :: HTTP 401 invalid_token
PASS JWKS down: kid miss needs the key server -> 503 :: HTTP 503 auth_unavailable
PASS JWKS down past the bounded window -> 503 auth_unavailable :: BFF 503 auth_unavailable; Read API 503 auth_unavailable at +21518ms (window 20000ms)
PASS key rotation: new-key token accepted after JWKS refresh :: old kid a58e1f46 -> new kid eb0fad3e; HTTP 200
PASS key rotation: token signed by the removed key rejected :: HTTP 401 invalid_token
PASS expired Dex token rejected :: BFF 401 expired_token; Read API 401 expired_token
PASS refresh-token renewal restores access :: HTTP 200
ALL OIDC CHECKS PASSED
```

`make oidc-browser-test` drives the dashboard's `oidc-client-ts` flow in real Chromium (Playwright,
browsers already installed), then replays the bearer the page actually sent. Log:
[stage08-oidc/oidc-browser-test.log](stage08-oidc/oidc-browser-test.log). Screenshots:
`stage08-oidc/alice-signed-in.png`, `stage08-oidc/bob-signed-in.png`.

```
PASS alice: browser used code + PKCE S256 with state and nonce :: response_type=code method=S256
PASS alice: dashboard GraphQL call authenticated :: BFF HTTP 200
PASS alice: token not in localStorage/sessionStorage :: storage keys: 0
PASS alice: browser token reads own tenant only :: own=0a0a0a0a-1111-4000-8000-00000000000a other=null
PASS sign-out returns to the sign-in screen :: sign-in visible=true
PASS bob: browser used code + PKCE S256 with state and nonce :: response_type=code method=S256
PASS bob: dashboard GraphQL call authenticated :: BFF HTTP 200
PASS bob: token not in localStorage/sessionStorage :: storage keys: 0
PASS bob: browser token reads own tenant only :: own=0b0b0b0b-1111-4000-8000-00000000000b other=null
PASS reload drops the in-memory session (sign-in required) :: sign-in visible=true
PASS forged callback state rejected by the client :: alert="No matching state found in storage"
ALL BROWSER OIDC CHECKS PASSED
```

Workspace checks, same checkout: `npm run test` for tenant-auth (30/30), bff (16/16),
read-api (14 passed, 1 live test skipped) and dashboard (30/30); `npm run lint`,
`npm run typecheck` and `npm test` are clean. Coverage for `tenant-auth` `oidc.ts` is 100%.
`make verify` stopped at `format:check` on `scripts/stage07-e2e.mjs`. That untracked file belongs
to another workstream and is not part of this change. The Go and `make build` steps after that
point were not run by `make verify` here.

## Notes and bugs found

- jose's kid-miss handling is bounded by the cooldown. A kid miss during a JWKS outage returns
  401 (not 503) while the cooldown is active, and 503 after it expires. This is expected
  behaviour and is recorded as a check.
- Dex has no `end_session_endpoint`. Before this change, `signoutRedirect()` would fail and leave the
  local session in place. Sign-out now always clears it locally.
- The dashboard's `oidc-client-ts` code flow sent no `nonce`. It now sends one.
- The dashboard used to store tokens in `sessionStorage`. They are now kept in memory only.

## Not verified

httpOnly BFF session; browser-level nonce tampering (checked only in the scripted flow); a
production IdP and membership store (Stage 09); remote CI; TLS on the issuer; multi-replica
JWKS cache behaviour; the live browser-to-saga flow.
