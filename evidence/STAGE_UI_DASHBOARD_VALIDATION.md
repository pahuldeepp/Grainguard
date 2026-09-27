# Dashboard UI rework: validation

Scope: `apps/dashboard/src` (plus `e2e/navigation.spec.ts` heading text and a README section). Presentation, markup structure, states and copy only. No API call, GraphQL operation, route, auth flow or data flow changed. Not touched: `index.html`, `vite.config.ts`, `nginx.conf`, `Dockerfile`, `public/*`, `.storybook/*`, `package.json`, the lockfile, `services/*`, `apps/mobile/*`.

## What changed

- `style.css` rewritten on the DESIGN_SYSTEM.md tokens (light, dark by `prefers-color-scheme`, rem type scale, 4-48 spacing, radius 4/8, no decorative shadow or gradient), `:focus-visible` ring, reduced-motion and forced-colors handling. One addition to the spec: `--line-strong` for control borders, because `line` (1.4:1) cannot be a form-control boundary under WCAG 1.4.11.
- New `ui.tsx` (inline SVG glyph set, `StatusMarker`, `Banner`, `Loading` skeleton, `EmptyState`, `ErrorState` with Retry, `FieldError`, `PageHeader`), `severity.ts` (severity/state/device-status to glyph+word, alert ordering, next-open-alert), `format.ts` (readable times, relative age), `online.ts` (offline notice).
- Shell: skip link, sticky top bar with a grain-bin mark and `nav aria-label="Primary"` (`aria-current`), bottom tab bar under 768 px, one `h1` per screen, `main#main`, a single compact status line for "service unavailable" or "offline". The marketing hero, eyebrow labels, "Local development" pill, "Your workspace" promo block, footer and per-route service cards are gone.
- Overview: open alerts (real query, worst first, top 5, count) then service readiness.
- Alerts: see the workflow below.
- Provisioning: labelled inputs with `aria-invalid` and `aria-describedby` errors, "Start" and "Follow" as separate steps, state as glyph+word, history as a lined list with readable times.
- Devices, current reading, history, averages: labelled forms, lined result lists, tables that reflow into labelled rows below 768 px (with table roles restored), temperature and humidity emphasised in tabular figures, loading/empty/error states with Retry.
- Sign-in and "Restoring sign-in" screens designed; Sign out moved into the header (`onSignOut` prop of `App`, passed by `AuthGate`).
- Chakra: `ChakraProvider` and every Chakra component import removed from `src` (native elements and our CSS). Nothing in the built bundle contains `chakra` or `emotion` (checked with grep on `dist/assets`).
- Routes other than Overview are lazy-loaded with a skeleton fallback; readiness polling pauses while `document.hidden` and refreshes on return.

## Alert workflow (owner feedback)

- Filter Open / Acknowledged / Resolved / All (default Open) with counts in the option labels. The BFF exposes no count, so a count is the length of the first page (25) of each state and reads `25+` when a cursor exists.
- Open alerts first, then severity (critical, high, warning, notice), then oldest first. Ordering is applied within the page the BFF returns.
- URL carries the state: `/alerts?state=&after=&alert=` (same route, no new route). Browser Back, reload and shared links work. Returning from a detail restores scroll position and puts focus on the row link (verified in Chromium, see flows).
- Detail (`?alert=`): severity, state, risk score, rule, escalation level, version, alert ID, and a history of the two timestamps the API returns (opened, acknowledged). A real "Back to alerts" link sits at the top.
- After Acknowledge succeeds: a polite live-region confirmation ("Acknowledged Bin ...") scrolled into view, with Back to alerts (in detail) and Next open alert (next open one after this in the sorted page, if any). The detail stays readable and shows Acknowledged after the list refetches. An uncertain ack still retries with the same idempotency key.
- Acknowledge in a list row is a secondary button (severity is the loud signal); it is primary in detail.

## Decisions and rejected designs

| Iteration | Critique of the rendered screen | Decision |
| --- | --- | --- |
| v0 (original) | Hero and promo blocks on every route; identical white rounded cards; raw ISO timestamps; alert meta floating mid-row; 11-13 px text; green pills; no severity signal. | Removed; see the audit. |
| v1 | Alert rows broke into one-letter columns at 375 px; shield-check logo could belong to any security product; "Open" repeated on every open row; four bright green Acknowledge buttons competed with severity; UUID as a 28 px page title; bordered boxes around forms; "Start here" menu duplicated the nav and said nothing about grain. | Stack the row under 640 px; grain-bin mark; hide state in the Open filter; secondary row buttons; detail titled "Critical alert" with the bin ID in monospace; flat forms with rule lines; Overview leads with real open alerts. |
| v2 | Orphan "·" separator wrapped alone on phones; Overview rows read poorly; forced-colors and 200%/400% not yet inspected. | Separator kept in the text (so "Critical · Bin ..." is one phrase for screen readers and tests) but not drawn; reflow checked at 640 and 320 px. |
| Rejected outright | Pills/badges for state; card grids; gradient or hero KPI tiles; chart placeholders; coloured left borders on every row (kept only as a 3 px severity edge on open rows, since severity also has glyph and word); a two-pane master/detail (bad at 375 px and would need a new route); a tab strip for filters (E2E and tests use the `#alert-state` select). |

## Real data versus not available (BFF gaps, pending)

Everything on screen comes from the existing persisted operations; nothing is fabricated and there is no demo mode. Returned and shown: alertId, severity, state, score, ruleId, escalationLevel, version, openedAt, acknowledgedAt, binId, cursor pagination, filter by state. Not exposed, therefore not shown, and pending a BFF query: bin and site names for an alert; counts; rule names and thresholds; escalation time; grain type, CO2, cable/sensor readings for a bin (readings exist per device only; there is no bin to device query, so the alert detail cannot show readings or trends); transition, acknowledgement and escalation history; delivered-notification log; the acknowledging user (opaque subject, deliberately not shown). Acknowledged-by is not displayed.

## Accessibility

Landmarks (banner, primary nav, main), one h1, headings in order, skip link, `aria-current`, label-above inputs with programmatic labels and error association, `role="alert"` errors, polite live regions for acknowledgement and status, `aria-busy` with a spare "Acknowledging" label on the busy button, 44 px hit areas (48 px controls), `:focus-visible` ring, tables with roles and labelled cells at phone width, decorative glyphs `aria-hidden`. Contrast: `node evidence/stage-ui-dashboard/contrast-check.mjs` checks 72 token pairs in both themes (text 4.5:1, focus ring, control borders and glyphs 3:1, text on the 12 percent severity tints): all pass; report in `evidence/stage-ui-dashboard/contrast-report.md`. axe-core / @axe-core/playwright is not installed, so axe was NOT run.

## Commands run and outcomes

| Command | Outcome |
| --- | --- |
| `npm test -w @greenguard/dashboard` (`vitest run`) | 16 files, 66 tests, all pass |
| `npm run coverage -w @greenguard/dashboard` | 66 tests pass; statements 80.36 percent, lines 81.84 percent (files untouched by this work such as `read-api.ts`, `alerts-api.ts`, `monitoring.ts` remain low; the repo gate is enforced by Sonar and was not run) |
| `npm run lint` (eslint, whole repo command) | clean |
| `npm run typecheck -w @greenguard/dashboard` | clean |
| `npm run build -w @greenguard/dashboard` | passes; initial JS 24 kB plus vendor chunks, routes in separate chunks (Provisioning 7.5 kB, Alerts 9 kB, ReadViews 13 kB); 15 kB CSS |
| `npx prettier --check` on `src/**/*.{ts,tsx,css}`, `e2e/navigation.spec.ts`, `README.md` | pass |
| `node scripts/design-check.mjs` | Violations: none (it flagged four nav inset shadows and an uppercase transform earlier; both replaced) |
| `node evidence/stage-ui-dashboard/contrast-check.mjs` | 72 of 72 pairs pass |
| Playwright (Chromium) fixture harness, 11 states x 375/768/1280 x light/dark | screenshots in `evidence/stage-ui-dashboard/{before,v1,v2,v3}` (v3 is final); `flows/` for keyboard focus, 200 percent (640 px) and 400 percent (320 px) reflow, forced colors, offline banner, confirmation |
| `evidence/stage-ui-dashboard/flows-report.txt` | detail, back-to-list scroll and focus restore, browser Back, live confirmation, Next open alert, focus ring, no horizontal scroll at 640 and 320, reduced motion, offline banner, filter in the URL: see the file for the PASS list |

The harness (outside the repo) renders the real `App` in Chromium against a stubbed `fetch` that returns fixture GraphQL data, so the screenshots show real components with fixture values. That is verification data only; it is not shipped.

## Not run

- `make browser-e2e` (needs the heavy live stack) was NOT run. `scripts/browser-e2e.mjs` selectors were checked by reading: `Provisioning`/`Devices`/`Alerts` links, `#device-search`, `#alert-state`, `#history-from`, `.read-table`, `.read-view`, `.provisioning-status`, `strong + *` state text, `ol li` history text, `critical · Bin <id>` text, `Acknowledge`, `Administrator redrive`, `Redrive reason`, labels and headings are all preserved. Changed on purpose: the `Better grain care.` heading (now `Overview`) in `apps/dashboard/e2e/navigation.spec.ts` and `main.test.tsx`; the `Sign out` button and alert list markup differ visually but keep their names.
- No live check against the local Dex/BFF (not started here); no real screen reader pass; no axe.
- Sonar/CodeRabbit not run.

## Follow-ups for the delivery agent

- CSP: nothing in `src` injects runtime styles any more (no Chakra/emotion in the bundle, no inline `style=` attributes), so `'unsafe-inline'` can be dropped from `style-src` in `nginx.conf` once the build is deployed. Not verified against a running nginx.
- Dependencies: `@chakra-ui/react` and `@emotion/react` are now unused by `src`, but `.storybook/preview.tsx` still imports Chakra and `package.json` was not edited. Removal is safe for the app only after that file stops using Chakra; the lockfile was not touched and `npm install` was not run.
- `index.html` still has the title "GreenGuard · Foundation" (owned by delivery).

## Screenshot index

`evidence/stage-ui-dashboard/v3/<screen>-<width>-<scheme>.png`, widths 375, 768, 1280, schemes light and dark. Screens: `overview`, `overview-degraded` (a service unavailable), `alerts`, `alerts-empty`, `alerts-error`, `alerts-loading`, `alert-detail`, `provisioning`, `provisioning-repair`, `devices`, `device-current`, `device-history`. `before/` is the original UI, `v1` and `v2` are the intermediate critique rounds. `flows/` holds `flow-1-detail-375`, `flow-2-confirmation-375`, `keyboard-focus-1280`, `zoom200-alerts` (640 px), `zoom400-alerts` (320 px), `forced-colors-alerts`, `offline-375`. Problems by screen for the original UI: `evidence/STAGE_UI_DASHBOARD_AUDIT.md`.
