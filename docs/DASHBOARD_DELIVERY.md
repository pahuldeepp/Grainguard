# Dashboard delivery and performance configuration

Scope: `apps/dashboard` (static SPA served by nginx, built by Vite). Evidence and
measurements: [STAGE_UI_DASHBOARD_DELIVERY.md](../evidence/STAGE_UI_DASHBOARD_DELIVERY.md).

## Files

| File                                    | Purpose                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/dashboard/index.html`             | lang, viewport (zoom allowed), description, `color-scheme`, light/dark `theme-color`, icons, manifest |
| `apps/dashboard/public/`                | `favicon.svg`, `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `site.webmanifest`       |
| `apps/dashboard/vite.config.ts`         | production build settings and vendor chunking (dev proxy and env handling unchanged)                 |
| `apps/dashboard/nginx.conf`             | server config, installed as an nginx **template** by the Dockerfile                                  |
| `apps/dashboard/Dockerfile`             | copies the config to `/etc/nginx/templates/default.conf.template`, defines `CSP_CONNECT_EXTRA`       |

Icons are the GreenGuard mark (white shield with a wheat ear on spruce `#0B5D36`), drawn as SVG.
The PNGs are rendered from that SVG. No external fonts or scripts are loaded.
`theme-color` uses `#F3F4F2` (light) and `#0F1311` (dark) from `docs/DESIGN_SYSTEM.md`.

## Build

- `target es2022`, `minify oxc`, `sourcemap false`. Maps are never published; if wanted for the error
  tracker, produce them in a CI-only build and upload them privately.
- Vite 8 uses Rolldown, so vendor splitting is `build.rolldownOptions.output.codeSplitting.groups`
  (the Rollup `manualChunks` option is deprecated here): `vendor-react` (react, react-dom, react-router),
  `vendor-ui` (Chakra/emotion/zag/ark/floating-ui, emitted only while the source imports them),
  `vendor-data` (TanStack Query, Redux Toolkit, zod, react-hook-form, oidc-client-ts).
  Vendor chunks change only on dependency bumps, so they stay cached across app releases.
- `chunkSizeWarningLimit 500` (kB, before gzip) so a regression back to one large bundle warns again.
- `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_AUDIENCE` and `VITE_SENTRY_DSN` are
  build-time values (unchanged). The E2E harness builds with its own env and serves with its own
  Node server (`scripts/browser-e2e-stack.mjs`), so it does not use nginx.

## Origins the app talks to

Derived from `src/`:

| Connection                                     | Where                          | Origin                       |
| ---------------------------------------------- | ------------------------------ | ---------------------------- |
| GraphQL POST, subscription ticket, `/api/*` readiness | `graphql-client.ts`, `read-api.ts`, `health.ts` | same origin (nginx proxies to gateway 4002, device-service 3001, telemetry-ingest 8080) |
| GraphQL WebSocket                              | `read-api.ts` (`/graphql`)      | same origin (`ws`/`wss`)     |
| OIDC discovery, token, JWKS                    | `oidc-client-ts` (`auth.ts`)    | the issuer origin from `VITE_OIDC_AUTHORITY` (E2E/local: `http://127.0.0.1:5556`, Dex) |
| Error tracking (optional)                      | `monitoring.ts`                 | Sentry ingest origin from `VITE_SENTRY_DSN`, only if set |

The redirect to the identity provider is a top-level navigation, which CSP `connect-src` does not govern.

## Content-Security-Policy

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src 'self' ${CSP_CONNECT_EXTRA}; manifest-src 'self'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'; object-src 'none'
```

- Set `CSP_CONNECT_EXTRA` at container start to the OIDC issuer origin (and the Sentry ingest origin if
  used), space-separated, for example `CSP_CONNECT_EXTRA="https://id.example.com"`. The image default is
  empty. The variable must be defined (even empty): an undefined variable is left literal by envsubst and
  nginx then refuses to start.
- `'self'` in `connect-src` covers same-origin WebSockets in current browsers; add explicit `wss://<host>`
  to `CSP_CONNECT_EXTRA` if very old Safari must be supported.
- `style-src 'unsafe-inline'` is required only while the UI injects runtime styles (Chakra/emotion or
  inline `style` attributes). If the UI agent removes all runtime style injection, drop it. Scripts stay
  strict: no inline scripts, no `eval`.
- `frame-ancestors 'none'` also gives clickjacking protection (no `X-Frame-Options` needed).

## Other headers

| Header | Value | Note |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb, accelerometer, gyroscope all `()` | |
| `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` | `same-origin` | OIDC uses redirects, not popups |
| `Strict-Transport-Security` | `max-age=31536000` | sent **only** when `X-Forwarded-Proto: https`; TLS ends at the ingress/CDN, not in this container. Plain HTTP (local, staging on 127.0.0.1) never gets HSTS. The ingress must set/overwrite `X-Forwarded-Proto` and strip a client-supplied one. |
| `server_tokens off` | | hides the nginx version |

Headers are set at server level with no `add_header` in any location, so they are inherited everywhere,
including proxied responses and 404s (nginx drops inherited `add_header` in a location that defines its own).

## Caching

| Path | `Cache-Control` |
| --- | --- |
| `/assets/*` (content-hashed) | `public, max-age=31536000, immutable` |
| `/`, `/index.html`, client routes | `no-cache` (revalidate by ETag, so a release is picked up at once) |
| `/favicon.svg`, `/apple-touch-icon.png`, `/icon-*.png`, `/site.webmanifest` | `public, max-age=86400` (unhashed names) |
| `/graphql`, `/api/*` | `no-store` |

The header is sent without `always`, so error responses (a 404 for a stale hashed asset) are not cached
as immutable.

## SPA fallback and health

- `/assets/*` and any path ending in a file extension return a real `404` when missing; only
  extension-less paths (for example `/auth/callback`, `/devices`) fall back to `index.html`.
  This keeps a stale hashed asset from being served as HTML with status 200.
- `GET /healthz` returns `200 ok`, unlogged, independent of upstreams.

## Compression

gzip on (level 5, min 1 KiB, `Vary: Accept-Encoding`) for CSS, JS, SVG, manifest and text. JSON is
excluded (BREACH exposure for token-bearing responses). Brotli is not enabled: the pinned image has no
brotli module and no brotli directive is emitted (so `nginx -t` stays valid). Precompressed `.br` would
need a CDN or a custom nginx build.

## Proxy

Existing routes are unchanged (`/api/devices/`, `/api/telemetry/`, `/graphql` with WebSocket upgrade,
`/api/v1/subscription-ticket`). Added `proxy_read_timeout 3600s` on `/graphql` so idle subscription
sockets are not cut at nginx's 60 s default.

## Operating notes

- Rollout: deploy `index.html` and assets together (one image). Old hashed assets vanish with the old
  image; clients holding an old `index.html` for at most one revalidation may 404 on old chunks. Keep the
  previous release's assets available at the CDN for one release if zero-downtime chunk loading matters.
- Verify after any change: `nginx -t` with the pinned image, then the curl checks in the evidence file.
