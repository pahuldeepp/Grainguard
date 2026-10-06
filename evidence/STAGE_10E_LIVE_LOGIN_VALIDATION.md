# Stage 10e live login validation (2026-09-26)

Scope: real Authorization Code + PKCE from the iOS simulator app to local Dex, then BFF alerts. Local only; no real IdP or account.

## Proven
- Dex client `greenguard-mobile` registered: authorization URL for it returns the login page; unknown client 404 (curl).
- Audience: with scope `audience:server:client_id:greenguard-dashboard` the access and ID token have `aud=[greenguard-dashboard, greenguard-mobile]`, `azp=greenguard-mobile`, and the BFF (`AUTH_AUDIENCE=greenguard-dashboard`) answers an alerts query with 200 and alert items; without that scope: 401 `invalid_token`; no token: 401 `missing_token`. (Scratch probe using the same flow as `scripts/oidc-login.mjs`; no token printed.)
- Tests: `npm test -w @greenguard/mobile` 52 pass (incl. new no-tenant-claim cases); shell `npx jest` 21 pass (RFC 7636 challenge via polyfilled path, SHA-256 vectors, callback wait/timeout/cancel, live/demo choice, sign-in error and cancel states, Info.plist scheme and Debug-only ATS); `npm run typecheck` clean.
- Debug simulator build succeeds; built Info.plist has the `greenguard` scheme and localhost-only ATS exceptions. Release plist has no `NSAppTransportSecurity`.
- On the iPhone 17 simulator, "Live sign-in" then the sign-in button opens Safari on the Dex login page (`evidence/stage10e/dex-login-in-simulator.png`). Stopped there by design.

## NOT proven (needs the owner)
- Password entry, the redirect back into the app (SceneDelegate `openURLContexts` to Linking), token exchange under Hermes `fetch` with a `URLSearchParams` body, Keychain write, and the live alert list/ack from the app. Cold-start redirect (app killed during sign-in) is not handled.
- Release build behaviour (live config is deliberately empty there); Android; device.

## Notes
- Dex tokens carry no `tenant_id`; the core now falls back to `unresolved@<issuer>` for local scoping only. The BFF `session` query is not in its persisted allow-list (see coordination note).
- Debug BFF endpoint is `http://127.0.0.1:4400/graphql`, a private-port BFF started for this check.

## Coordinator run, 2026-09-26 ~02:43 local: real sign-in and acknowledge proven on the simulator

iPhone 17, iOS 27.0, local Dex (`http://127.0.0.1:5556/dex`), local BFF (`127.0.0.1:4400`) and workflow-alerts. Test user `alice@greenguard.test`; the dev password came from the git-ignored `.env` and is not recorded here.

| Step | Result |
| --- | --- |
| App "Live sign-in" -> Safari shows the Dex login page | pass |
| Login with the test user | pass (first attempts failed because the Mac clipboard is synced into the simulator, so a paste inserted the wrong text; the password was then typed) |
| `greenguard://auth/callback` redirect back into the app | pass ("Open in GreenGuard?" prompt accepted) |
| Token exchange | FAILED first with `unsupported_grant_type`: the core sent a `URLSearchParams` object as the fetch body, which React Native does not serialise. Fixed in `apps/mobile/src/oidc.ts` (explicit form-encoded string) after a test (`typeof body === "string"`) failed first; core 52/52, shell 21/21, lint and tsc clean |
| Token exchange after the fix, tokens to Keychain | pass |
| Alert list from the real BFF | pass: header "Live", real alerts (mixed Open / Acknowledged) |
| Alert detail | pass: real critical alert, risk score 87.00 |
| Acknowledge | pass: state "Acknowledged, just now"; `alert_transitions` in `greenguard_alerts` has an `acknowledged` transition with `actor_type = user` at 07:44:05 UTC, the only user-actor row in the last 10 minutes (matched by time and actor, not by episode id) |

Not proven: offline acknowledge against the live backend (the demo-mode offline queue is proven separately), tenant switch with real memberships, refresh-token renewal in the app, sign-out clearing the Keychain, kill-and-resume during sign-in, physical device. iOS offered to save the password to the simulator keychain; "Not Now" was chosen.
