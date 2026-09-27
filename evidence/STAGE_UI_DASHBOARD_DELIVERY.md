# Evidence: dashboard delivery and performance configuration

Date: 2026-09-26. Design and policy: [docs/DASHBOARD_DELIVERY.md](../docs/DASHBOARD_DELIVERY.md).
Another agent was editing `apps/dashboard/src` at the same time, so the "after" numbers below were taken
twice (see notes). No file under `src/` was touched.

## Build sizes (`npx vite build --outDir <scratch>`, gzip -9 of each file)

`npm run build -w @greenguard/dashboard` was not used for measurement because its `tsc --noEmit` step
type-checks the in-flux `src/`; `vite build` is the second half of that script.

| Build | Chunk | Raw | Gzip |
| --- | --- | ---: | ---: |
| Before (old config, old src) | `index-*.js` (single bundle, Vite warned >500 kB) | 771,218 | 218,433 |
| | `index-*.css` | 13,092 | 3,401 |
| After, same src (Chakra still imported) | `vendor-react` | 256,675 | 80,480 |
| | `vendor-ui` (Chakra/emotion) | 256,043 | 63,742 |
| | `vendor-data` | 225,022 | 65,223 |
| | `index` (app) | 36,698 | 10,739 |
| | `rolldown-runtime` | 589 | 397 |
| | `index-*.css` | 13,104 | 3,395 |
| After, latest src (UI agent removed Chakra imports) | `vendor-react` | 256,675 | 80,480 |
| | `vendor-data` | 225,022 | 65,223 |
| | `index` (app) | 50,068 | 13,786 |
| | `rolldown-runtime` | 589 | 397 |
| | `index-*.css` | 14,096 | 3,599 |

Total JS gzip: 218 kB before, about 220 kB after with the same src (splitting costs a little), about
160 kB with the latest src. The gain of the config change is cacheability, not size: an app-code release
re-downloads about 11 to 14 kB gzip instead of about 218 kB. The chunk-size warning is gone. No
`sourceMappingURL` in any output, and no `.map` files were emitted.

## nginx (image `nginxinc/nginx-unprivileged@sha256:04a3275f...a508`, the digest already pinned in the Dockerfile)

The image was not present locally and was pulled (`docker pull`); no running container was touched.
Upstream names were mapped with `--add-host ...:127.0.0.1` so `nginx -t` can resolve them.

- `docker run --rm --add-host ... -v <rendered>:/etc/nginx/conf.d/default.conf:ro <image> nginx -t`
  → `syntax is ok`, `test is successful`.
- Smoke test: container `gg-dash-smoke` on `127.0.0.1:18080`, template mounted at
  `/etc/nginx/templates/default.conf.template`, built dist mounted read-only,
  `CSP_CONNECT_EXTRA=http://127.0.0.1:5556`. Removed afterwards (`docker rm -f`).

| Check | Result |
| --- | --- |
| `GET /` | 200, `Cache-Control: no-cache`, CSP with `connect-src 'self' http://127.0.0.1:5556`, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP; no `Server` version |
| `GET /auth/callback?code=x` | 200 `text/html` (SPA fallback) |
| `GET /assets/vendor-react-*.js` with `Accept-Encoding: gzip` | 200, `Content-Encoding: gzip`, `Cache-Control: public, max-age=31536000, immutable` |
| `GET /assets/index-NOPE.js` | 404 (not index.html), no Cache-Control |
| `GET /nope.js` | 404 |
| `GET /healthz` | 200 `ok` |
| `/favicon.svg`, `/site.webmanifest` | 200, `max-age=86400`; manifest `application/manifest+json` (fixed after first run served `octet-stream`) |
| HSTS | absent on plain HTTP; `max-age=31536000` when `X-Forwarded-Proto: https` |
| `/graphql` with no upstream | 502 still carries the security headers |

Defects found and fixed while testing: unquoted `{1,8}` in a regex location broke nginx; the manifest
had the wrong MIME type; an undefined `CSP_CONNECT_EXTRA` stops nginx (documented; the Dockerfile
sets a default of empty).

## Browser check against the served build (Playwright Chromium, already installed)

Loaded `http://127.0.0.1:18080/` under the CSP: no CSP violations and no page errors. DOMContentLoaded 274 ms,
first contentful paint 352 ms on localhost (not a Lighthouse score). Title "GreenGuard"; icon, apple-touch-icon,
manifest links resolve. The only console error is the 502 from the readiness probes, because the
upstream services were not running. Page sent 6 static requests, all gzip except a 589-byte runtime file.

## Not run

- Lighthouse: not installed (`lighthouse` not on PATH, not in `node_modules`); no scores are claimed.
- `docker build` of `apps/dashboard/Dockerfile` (needs `npm ci` and the full workspace context); only the
  config and template mechanism were exercised with the pinned base image and the locally built dist.
- `make verify`, the Sonar gate, and `scripts/browser-e2e*.mjs` (live stack, as instructed). E2E serves
  the dashboard through its own Node server, so nginx changes cannot affect it; the `index.html`,
  `public/` and `vite.config.ts` changes do go through its `vite build` (build verified locally).
- `npx vitest run` in `apps/dashboard` had 7 failing tests in `AlertsView`, `ReadViews`, `main` and related
  files, all under `src/` that the UI agent is rewriting; they could not be attributed to these config
  changes (`vite.config.ts` test settings are unchanged) but I did not isolate them.
- Prettier was run on `vite.config.ts`, `index.html` and `site.webmanifest`. `nginx.conf` is not formatted by it.

## Recommended src-level follow-ups for the UI agent (read-only findings)

1. Route-level lazy loading in `App.tsx`: `Provisioning` (pulls react-hook-form, `@hookform/resolvers`,
   zod), `AlertsView`, and the `ReadViews` device pages are each behind a `<Route>` but imported
   statically. Use `React.lazy(() => import(...))` plus `<Suspense>` with the existing loading state.
   Expected to move most of `vendor-data`'s form/validation code (zod is the largest piece) out of the
   entry path for the Overview route.
2. `oidc-client-ts` is needed at startup for `AuthGate`; keep it eager, but `monitoring.ts` (Sentry) is
   already a dynamic import behind `VITE_SENTRY_DSN` and is absent from this build. Keep it that way.
3. `@chakra-ui/react` and `@emotion/react` are in `package.json` but the latest `src/` no longer imports
   Chakra (the `vendor-ui` chunk disappeared). If confirmed, remove them, `DashboardProviders`'
   `ChakraProvider`, and Tailwind/Apollo mentions in the README; this also lets CSP drop `'unsafe-inline'`
   for styles if nothing injects style tags.
4. `react-router` 8 and `react-dom` make `vendor-react` 256 kB raw; no action, but do not add more
   router-level dependencies.
5. Avoid `import()` of a module that is also statically imported, or the chunk will not split.
6. Add `<link rel="preload">` only after measuring; Vite already emits modulepreload for vendor chunks.
7. Reading `/api/devices/readyz` and `/api/telemetry/readyz` every 5 s from every tab is cheap but
   uncached (`no-store`); consider pausing the poll when the tab is hidden (`document.visibilityState`).
