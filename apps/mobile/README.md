# apps/mobile

Status: **Stage 10e mobile core and iOS shell implemented locally; deployed iPhone acceptance pending**.

Stages: 10 (row 10e).

Technology: React Native iOS shell and dependency-light TypeScript core.

Responsibility: Mobile alert and acknowledgement journey.

## Modules (`src/`)

| Module             | Purpose                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkce.ts`          | S256 verifier/challenge (RFC 7636 vector tested), state and nonce, authorization URL builder, callback parser that rejects a state mismatch. Crypto is injected (`CryptoDeps`).                                                                                                                                                                      |
| `oidc.ts`          | Authorization-code exchange and refresh with injected `fetch` and clock; ID-token nonce check; `OidcError.transient` separates outages from `invalid_grant`.                                                                                                                                                                                         |
| `session.ts`       | `MobileSession`: sign-in, single-flight refresh with expiry skew, forced refresh, re-login signal, sign-out and tenant switch (clear listeners); tenant and subject are resolved from the BFF's verified session, never trusted from decoded token claims.                                                                                  |
| `secure-store.ts`  | `SecureStore` interface. Tokens and pending PKCE material go only through it (Keychain/Keystore in the shell); never plain storage.                                                                                                                                                                                                                  |
| `graphql.ts`       | Persisted-query client for the BFF (same protocol as the dashboard); bearer token from the session; one forced refresh on 401.                                                                                                                                                                                                                       |
| `alerts-client.ts` | List, detail and acknowledge against the existing BFF contract. Tenant is taken from the session, never from payloads; list cache is tenant-keyed and cleared on session clear. A test pins the operation text to `services/bff/src/query-policy.ts`.                                                                                                |
| `ack-queue.ts`     | Offline acknowledgement queue on an injected store, scoped per tenant and user. Idempotency key is generated once at enqueue and reused on every retry and restart; ordered replay; bounded exponential backoff; 409/412 treated as already acknowledged; permanent 4xx moved to a visible rejected state; relogin pauses without spending attempts. |

Commands: `npm test -w @greenguard/mobile` (build + `node --test`), `npm run coverage -w @greenguard/mobile`, `npm run typecheck -w @greenguard/mobile`.

## Live mode (local Dex and BFF)

1. `make oidc-up` (Dex with client `greenguard-mobile`; restart Dex if it was up before this change).
2. Start workflow-alerts and the BFF with `AUTH_ISSUER=http://127.0.0.1:5556/dex`, `AUTH_AUDIENCE=greenguard-dashboard`, `AUTH_JWKS_URL=.../keys`, `AUTH_MEMBERSHIP_FILE=infra/oidc/memberships.json`; BFF `BFF_PORT=4400 ALERT_API_URL=http://127.0.0.1:4405 SAGA_API_URL=<any> BFF_ALLOW_NO_RATE_LIMIT=true`, alerts `PORT=4405`, plus the `.env` DB URLs.
3. Metro (`npx react-native start` in `shell/`), run the Debug app, tap the "Demo data" badge, then "Sign in with browser (live)".
4. In the Dex page enter `alice@greenguard.test` and the `OIDC_DEV_PASSWORD` value from your git-ignored `.env`.

Details: `evidence/STAGE_10E_LIVE_LOGIN_VALIDATION.md`. The redirect uses the `greenguard://` scheme delivered through `SceneDelegate` to RN Linking; the browser is Safari via `Linking.openURL`. PKCE crypto: `react-native-get-random-values` 2.0.0 plus a tested pure-JS SHA-256 (`shell/src/services/polyfills.ts`). Local loopback config is Debug-only; a generated public deployment config can supply HTTPS endpoints to Debug and Release builds. See the [iPhone/AWS login runbook](../../docs/runbooks/mobile-iphone-aws-login.md).

## Design decisions

- Queue entries are keyed by tenant **and** subject: a different user in the same tenant cannot replay someone else's acknowledgement. Queues are kept across sign-out so the same user can flush after re-login; a tenant switch clears tokens and cached alert data but keeps each scope's pending acks untouched.
- Dequeue happens only after the send. A crash between send and dequeue replays the same key; the alert API is idempotent on it.
- Conflict (409/412) is success-equivalent because the alert is no longer in the state the command targeted; the UI should refetch detail to show the real state.
- Claims are decoded only to scope local data; the BFF remains the authority.

### OIDC client verification boundary

The mobile core currently validates the PKCE state and compares the returned
ID token's `nonce`, but it only decodes the ID token payload to make that
comparison. It does **not** verify the ID token signature, issuer, audience,
or expiry on-device. Do not use decoded ID-token claims as identity or
authorization evidence. Every API request and the BFF-backed tenant-membership
lookup independently validate the access token's signature, issuer, audience
(or the configured Cognito access-token client allowlist), and expiry before
returning tenant data.

Adding full ID-token verification safely requires both provider and runtime
support: the mobile deployment configuration must include the exact issuer and
JWKS endpoint (with a stable `kid` and supported signing algorithm such as
RS256), and the iOS runtime must provide a maintained platform-backed public
key verification primitive or standards-compliant WebCrypto
`SubtleCrypto.importKey`/`verify`, including bounded JWKS caching and refresh
for key rotation. Hermes currently has no WebCrypto; the shell polyfill only
implements secure randomness, SHA-256, and encoding, and the mobile core's
injected `CryptoDeps` has no signature-verification operation. The `jose`
dependency used by the server verifier is not a mobile dependency and cannot
be assumed to work in Hermes without that crypto support. We therefore keep
the server access-token verifier as the security boundary and leave
on-device ID-token verification as an explicit mobile release-readiness gap;
do not add a handwritten RSA/JWS verifier as a substitute.

## Not done

- Physical iPhone run against a deployed HTTPS issuer and BFF; push notifications.
- Accessibility audit (screen reader, dynamic type, contrast) and device/browser test commands.
- Remote CI and Sonar evidence for this package; `docs/MILESTONES.md` is not updated.

## iOS shell (`shell/`)

A bare React Native 0.87.1 app (`GreenGuardMobile`, TypeScript, New Architecture) that imports the tested core above in place. It is a **standalone npm project** with its own `package.json` and lockfile; it is not a root workspace, so `make verify`, lint and the root lockfile do not see it.

### Open and run

```bash
cd apps/mobile/shell
npm install
(cd ios && LANG=en_US.UTF-8 pod install)   # CocoaPods needs a UTF-8 locale
open ios/GreenGuardMobile.xcworkspace       # always the .xcworkspace, not .xcodeproj
```

Then either press Run in Xcode after starting Metro (`npx react-native start`), or `npx react-native run-ios`. A Debug build loads JavaScript from Metro, so Metro must keep running. The current bundle id is `com.greenguard.mobile`; choose a bundle identifier owned by your Apple signing team before installing on your phone.

Commands: `npm test` (jest, 5 screen tests), `npm run typecheck` (builds the core's `dist/*.d.ts` with the root toolchain, then `tsc --noEmit`).

Toolchain notes from the first run (Xcode 27, iOS 27 simulator): iOS 27 requires the UIScene lifecycle, so `AppDelegate.swift` has a `SceneDelegate` and `Info.plist` a scene manifest (the template crashed at launch without them); the Podfile raises any pod below iOS 15 to 15.0 (Xcode 27 rejects 13.0); `react-native-safe-area-context` is 5.10.0 because 5.5.2 does not compile against RN 0.87; Metro `nodeModulesPaths` points core files at the shell's `node_modules`. A stopped CoreSimulator needed `killall com.apple.CoreSimulator.CoreSimulatorService` before `simctl boot` worked.

### Wiring to the core

- Metro `watchFolders` includes `../src`; `@greenguard/mobile-core` is aliased to it in Metro, jest and tsconfig (types come from the built `../dist` declarations). A small Metro `resolveRequest` maps the core's NodeNext `./x.js` specifiers to the `.ts` files. Nothing is copied.
- Dependencies (exact pins): `react-native-keychain` 10.0.0 (Keychain-backed `SecureStore`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; maintained, tokens only), `@react-native-async-storage/async-storage` 3.1.1 (ack queue storage; holds alert ids and idempotency keys, never tokens), `@react-native-community/netinfo` 12.0.1 (`isOnline` and reconnect drain), `react-native-safe-area-context` 5.10.0. Navigation is a small state machine, so no navigation library or extra pods.
- Screens: sign-in, alert list, alert detail with Acknowledge, sync queue (pending/rejected, dismiss, sync now), offline banner with pending count, tenant switch, sign-out. Light and dark themes, roles and labels on controls; severity is text plus colour.

### Demo data versus real

- **Demo data** (`shell/src/demo/*`, the visible "Demo data" badge): fictional tenants, bins and alerts; a fake session and alerts client; a "Simulate offline" switch. It uses the **real** `AckQueue`, so acknowledging offline, the pending count, backoff and drain on reconnect are the real logic against a fake sender. Default only when `__DEV__`; `createServices` and `createDemoServices` refuse demo mode in a release bundle, and the demo modules are dead code there. Tapping the badge switches to live mode.
- **Live**: `MobileSession`, `AlertsClient`, Keychain/AsyncStorage/NetInfo adapters and the Linking-based browser hand-off in `shell/src/services/live.ts`. The local Dex/BFF path has been exercised; the deployed iPhone path has not. `shell/scripts/configure.mjs` writes ignored public HTTPS endpoints for an AWS build. Without those endpoints, Release sign-in is disabled.

### NOT DONE

- Deployed OIDC client/user/tenant membership and physical-device login acceptance; the local Dex client and iOS URL scheme are already registered.
- Real device run and TestFlight; push notifications.
- Accessibility audit with VoiceOver, dynamic type and contrast measurement.
- Release signing, and an Android run (the template `android/` folder is untouched and unbuilt).
- The template's `npm run lint` does not start (ESLint 8 config references an unknown `jest/globals` env); not fixed here.

### UI (Stage 10e polish)

Design direction and tokens: [docs/DESIGN_SYSTEM.md](../../docs/DESIGN_SYSTEM.md). Details and evidence: [STAGE_10E_UI_VALIDATION.md](../../evidence/STAGE_10E_UI_VALIDATION.md).

- Theme and components live in `shell/src/ui/` (`theme/tokens.ts` holds the tokens; `Txt`, `Button`, `TextField`, `SeverityMarker`/`Glyph`, `StatusLine`, `AlertRow`,
  `Segmented`, `ReadingViews`, `BinProfile`, `Timeline`, `BackButton`). Glyphs are drawn with Views (no icon or SVG dependency was added).
- Demo-only: readings, limits, 24 h trend, cable and sensor layout and the fixture history (`shell/src/demo/data.ts`), always labelled "(demo)". Live mode shows only what the alert
  queries return and says so where something is not available; bin and site names, thresholds, transition history and notification log are backend gaps listed in the validation doc.
- Checks: `npm test` (54 tests), `npm run typecheck`, `node --experimental-strip-types scripts/contrast.mjs` (contrast of every token pair, exits 1 on failure).
- Simulator settings for testing: the app follows the system text size and appearance. Use the normal setup (content size `large`, appearance `light`) for day-to-day runs
  (`xcrun simctl ui <udid> content_size large`, `appearance light`). Do accessibility-size and dark sweeps on a separate temporary simulator
  (`xcrun simctl create` ... `delete`) so the main device keeps normal settings.
- Release builds use only the generated HTTPS deployment config. Without it, they open Sign-in with "Sign-in is not configured for this build."

`read-client.ts` exports `MobileReadClient` with the BFF's exact persisted reading,
current-device, bin, rollup, history and search documents. It retains observed
PostgreSQL minima per tenant/subject, clears on session/relogin events, and
preserves the minimum through the one 401 refresh retry. `observeDeviceChange()`
lets a future subscription transport raise the next refresh minimum. Higher
epochs replace identity, late older hints are ignored, and controlled identity409
allows one tenant-bound authoritative reset within the original deadline. Empty
results use the GraphQL response certificate; unchanged identity/outage cannot
downgrade the minimum. Old session hints are rejected before observation. The current
shell's live alert screens do not yet consume this reading client. The portable
watermark codec uses a dedicated package subpath and Metro/Jest source mapping,
so the shell never imports the membership server runtime. See the
[consistency contract](../../docs/api/bff-read-consistency.md).
