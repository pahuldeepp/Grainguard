# Stage 10e mobile UI: validation

Date: 2026-09-26. Scope: `apps/mobile/shell/src`, `apps/mobile/shell/__tests__`, `apps/mobile/shell/scripts`
(the tested core `apps/mobile/src`, `ios/**`, services, infra and the dashboard were not touched; `.gitignore` gained one line for
`ios/build-release-ui/`). Nothing was committed. Audit of the starting point: [STAGE_10E_UI_AUDIT.md](STAGE_10E_UI_AUDIT.md).
Screenshots: `evidence/stage10e-ui/` (index below).

## What the UI is now

Direction from [docs/DESIGN_SYSTEM.md](../docs/DESIGN_SYSTEM.md), then pushed from "tokens on rows" to a grain-bin monitoring tool:

- **Header identity**: a shield-and-wheat mark (plain Views) and the organisation name; sync state is a small trailing marker
  ("Synced" or a glyph plus "2 unsent"), not a button row.
- **One status line** for offline, stale and demo state (icon plus one short sentence, tappable: offline opens the sync queue, stale retries).
  The old separate offline banner, demo banner and toggles are gone from the top of the screen.
- **Alert list**: tabs Open / Acknowledged / All with counts as data (default Open, filter and scroll offset survive a visit to detail),
  open alerts sorted by severity then age, rows lead with bin name and the **triggering reading** ("Moisture 16.8%, limit 14"),
  severity glyph plus word, time, and state (Open / Unsent / Acknowledged) as a small trailing marker. Empty state per filter, skeleton while loading,
  error state with Retry, "n+" counts when the API reports another page.
- **Alert detail** leads with the facts (risk score, age, state, escalation), then three reading tiles (value, unit, limit, "Over limit" with glyph),
  a 24 h trend of the triggering metric with the limit as a dashed line, then **BinProfile**: a side-on bin section with temperature cables
  and sensors. A sensor's band is shown by shape (hollow, filled, filled with ring) and colour, is a 44pt tap target, and the hot spot is ringed and named
  ("Cable 3, 4.5 m: 34.2 C, hot spot"). Then a history timeline. One primary action is pinned at the bottom.
- **Acknowledge flow**: busy button ("Acknowledging" for screen readers), then a pinned confirmation ("Acknowledged.", announced), with **Next open alert**
  (only if another alert still needs one) and **Back to alerts**. Header "< Alerts" back, iOS-style left-edge swipe back.
- **Sync queue**: per-item state (Waiting for connection / Sending / Retrying, attempt n / Rejected plus reason), Dismiss on rejected, Sync now.
- **Sign-in**: brand, one sentence, a quiet Demo / Live selector (development builds only), one primary button, an honest
  "Sign-in is not configured for this build." state in release.

## Live versus demo (what is real)

Source: [docs/MOBILE_DATA_AVAILABILITY.md](../docs/MOBILE_DATA_AVAILABILITY.md) and [evidence/MOBILE_DATA_AVAILABILITY_LIVE.md](MOBILE_DATA_AVAILABILITY_LIVE.md).

| Element | Live mode | Demo mode |
| --- | --- | --- |
| Alert id, severity, state, score (0-100), rule id, escalation level, opened / acknowledged times, bin id | real (`alertList`, `alertDetail`) | fixtures |
| Bin and site names | not available: title is "Bin" plus the first 4 characters of the id when the name is a UUID; no site line | fixtures |
| Rule name | not available: raw rule id shown as "Rule 3f9a" | formatted rule key |
| Acknowledged by | never shown raw (opaque IdP subject): "by you" or "by another operator" | "by you" |
| Readings, limits, trend, cables and sensors | hidden with "Readings, limits and sensor positions are not available in this view yet." | fixtures, every section labelled (demo) |
| History timeline | derived only from opened, escalation level (no time), acknowledged time and actor, resolved (no time); "Time not available yet" is printed rather than a guess | fixture timeline labelled "History (demo)" |
| Filter counts | counted from the loaded page; "n+" when `nextCursor` exists | same |

## Pending backend / BFF work that blocks the desired UI

(The mobile core may only call persisted operations; `services/bff/src/query-policy.ts` was not edited.)

1. Bin and site names (join to device-service `bins.name`/`sites`, or a `read.bin_views` projection).
2. `ruleKey`, thresholds (`open_score` / `clear_score` and per-grain temperature and moisture limits).
3. `escalatedAt`, `resolvedAt`, `openWindowStart` in `alertList` / `alertDetail` (schema has them, persisted operations do not select them).
4. Transition history: `alert_transitions` (columns `transition_type`, `from_state`, `to_state`, `actor_type`, `actor_id`, `occurred_at`, `episode_version`, `event_id`,
   in `greenguard_alerts`; `escalation_suppressed` rows have no event) has no API. It needs a persisted BFF operation (or `GET /v1/alerts/:id/transitions`).
5. Delivered-notification log (`notification_intents` in the jobs-worker database) has no API.
6. Latest reading and 24 h history: the Read API has `deviceCurrent` / `deviceHistory` / `readingRollups` (per device); the mobile core does not call them yet, there is
   no bin-to-device query, and CO2, cable and sensor data do not exist in any contract. The Read API on :4401 was not running during the data check.
7. Acknowledger display name (needs a tenant-scoped membership lookup).
8. Counts endpoint (mobile fetches a page and counts).

## Accessibility

- Every interactive element has a role, label and state; every severity is glyph plus word; state words are in the row label.
  Full label dump per screen: [stage10e-ui/voiceover-labels.json](stage10e-ui/voiceover-labels.json) (generated by `__tests__/a11y-labels.test.tsx`).
  Examples: `button: High, Bin 7 (wheat), North Elevator, Moisture 16.8%, limit 14, open, 55 minutes ago`;
  `button: Cable 3, 4.5 m: 34.2 °C, hot, hot spot`; `tab: Open, 3`; `button: Sync queue, 0 unsent, 0 rejected`.
- Dynamic Type: `Txt` scales every role with a per-role cap (title 1.4x, data 1.5x, body/meta 1.8x, display 1.3x). At fontScale above 1.25 the reading tiles, fact
  strip and filter tabs stack one per row; tenant name wraps with a non-breaking hyphen. Checked on iPhone 17 and iPhone SE (3rd generation) at accessibility-large.
- Contrast: `node --experimental-strip-types scripts/contrast.mjs` (output in [stage10e-ui/contrast-output.txt](stage10e-ui/contrast-output.txt)). All 44 text and glyph pairs pass
  (text 4.5:1, glyph ink 3:1). Ratios on `surface`, light / dark: text 17.66 / 14.83, textMuted 7.87 / 7.74, brand 7.97 / 7.47, critical 6.54 / 7.56, warning 5.93 / 9.64,
  notice 5.82 / 7.86, ok 6.51 / 9.18, offline 7.45 / 8.16, onBrand on brand 7.97 / 8.00. **Advisory, not a pass:** the `line` token (input and divider strokes) is
  1.43:1 light and 1.36:1 dark; WCAG 1.4.11 asks 3:1 for input boundaries. The token is binding in DESIGN_SYSTEM.md, so it is unchanged; inputs are identified by label and a 2px focus ring instead.
  (No input field is used in the shell today: sign-in is the system browser.)
- Reduce Motion: `useReduceMotion` reads `AccessibilityInfo`; `FadeIn` (the only animation, 180 ms ease-out, on banners and status lines) is skipped when it is on. Unit-tested both ways
  (`__tests__/states.test.tsx`); not toggled on a simulator.
- Announcements: the acknowledge result, the queued-offline result and connectivity changes call `AccessibilityInfo.announceForAccessibility`; the confirmation is a live region.
- Touch targets: buttons 48, links, tabs, rows, sensors, back 44+ (sensors are 18pt squares with a 14pt hit slop).

## Tests and builds run (all in `apps/mobile/shell`)

| Command | Outcome |
| --- | --- |
| `npx jest` | 7 suites, 54 tests pass (21 pre-existing tests kept; 5 assertions updated for new copy, see below) |
| `npx tsc --noEmit` | exit 0 |
| `npx prettier --check src __tests__ scripts` | clean |
| `npm run lint` | does not start (pre-existing: ESLint 8 config references an unknown `jest/globals` env); not fixed |
| `node scripts/design-check.mjs` (repo root) | no violations |
| `xcodebuild -sdk iphonesimulator -configuration Debug` (derived data in the scratchpad) | BUILD SUCCEEDED; installed and launched on iPhone 17, iPhone SE (3rd gen) |
| `xcodebuild -sdk iphonesimulator -configuration Release -derivedDataPath ios/build-release-ui` | BUILD SUCCEEDED; launched on a temporary SE simulator: shows the Sign-in screen with "Sign-in is not configured for this build." after 15 s (screenshot `se-release-launch-15s.png`) |

Assertions changed because copy changed (behaviour unchanged): "CRITICAL" to "Critical"; "Queue (n pending, n rejected)" / "n acknowledgement pending" to the new offline line and the
"Unsent" state word; "Sign in with browser (live)" to "Sign in with browser"; the tenant name is compared after normalising the non-breaking hyphen.
New tests: component roles/labels/states, severity mapping, grouping and ordering, filters and counts, empty / error / skeleton, acknowledge -> confirmation -> Next / Back,
no stale confirmation on Next, timeline derivation without invented data, acknowledger never raw, live mode hides readings, bin sensor labels, reduce motion,
release path (identity lookup that rejects or never resolves goes to sign-in, sign-in disabled and explained).

### Release skeleton bug (reported by the release-readiness check)

Cause: `AppRoot` waited forever for `session.identity()`; if the lookup rejected or hung in an unconfigured build, the skeleton stayed. Fix: the lookup is
caught and races a 4 s timeout, both resolve to signed out; `AppServices.signInAvailable` (false when live endpoints are empty) shows
"Sign-in is not configured for this build." and disables the button. Tests in `states.test.tsx`; verified in the Release build above.

## Real Dex login (not completed)

Done: live mode, Sign in with browser, Dex page on 127.0.0.1 in Safari, email `alice@greenguard.test` typed, iOS autofill / "Update Password?" sheets dismissed
("Not Now"; nothing saved), the password pasted from the git-ignored `.env` through `simctl pbcopy` (never printed, pasteboard cleared afterwards).
Result: Dex answered **"Invalid Email Address and password."** The `OIDC_DEV_PASSWORD` value in `.env` does not match what the running Dex has loaded (Dex was probably started
before the value changed; `make oidc-up` regenerates the hash). I did not retry (lockout risk) and did not restart infrastructure. Consequently these were **not** run in this pass:
real alert list, real detail, real acknowledgement, `alert_transitions` check, navigation after a real acknowledgement. The mobile core behaviour for those is covered by
`STAGE_10E_LIVE_LOGIN_VALIDATION.md` (earlier run, before this UI change); the new UI has only been exercised against demo fixtures and jest.
The sign-in error state ("Sign-in timed out. Try again.") was captured after abandoning the browser (`iphone17-light-signin-waiting.png`).

## Rejected designs (log)

1. **Stats strip** (Open / Critical or high / Unsent as three big numbers above the list). Built, screenshotted, removed: it repeated the tab counts, pushed the first alert down and the
   figures had no action. Counts now live only in the filter tabs.
2. **Filled green segmented control** for Open / Acknowledged / All. Heavy, two-line cells at 4 lines tall, and green used for a non-primary control. Replaced by
   underlined tabs with the count inline.
3. **Two stacked banners** (offline, demo) plus a "Sync queue" text button and a "Synced" check glyph at the top. About 45% of the screen before the first alert. Replaced by one status line
   and a quiet trailing sync marker (the check glyph only appears when there are unsent items).
4. **Label / value table for detail** (Risk score, Severity, State, Rule, Opened as five rows). Read like a form and buried the reason for the alert. Replaced by a fact strip and the readings.
5. **Severity pill with ALL CAPS text** and identical rounded cards (the audit baseline): not domain-specific, and the pill carried no shape.
6. **Green links for Switch organisation / Switch to live** in the account footer: arbitrary green. Now neutral text; only Sign out is coloured (critical).
7. **Auto-shrinking values in the reading tiles** (adjustsFontSizeToFit): three tiles with three different sizes. Replaced by a fixed display size and a small unit.
8. **Normal sensors drawn in the "ok" green**: with a cable diagram it reads as "everything is fine" and adds a third hue. Normal is now a neutral hollow square; only warm and hot use colour.
9. **Mode choice as two big buttons plus a primary** on sign-in: three green-weight buttons. Now a quiet Demo / Live selector and one primary.
10. **Bin cross-section as decoration**: kept only because it shows cable positions, sensor bands, depth, the thresholds and the hot spot, and it is demo-only. If it were only an outline of a bin it would have been dropped.

## Screenshot index (`evidence/stage10e-ui/`)

| File | Shows |
| --- | --- |
| `before/*` | starting point (list light, dark, accessibility-XL, detail) |
| `iphone17-light-list.png`, `iphone17-light-list-full.png` | alert list, Open filter, light, with and without the account footer |
| `iphone17-dark-list.png` | list, dark |
| `iphone17-light-list-accessibility-large.png`, `iphone17-dark-list-accessibility-large.png` | list at accessibility-large (temporary iPhone 17 device) |
| `iphone17-light-detail-top.png` | detail: facts, reading tiles, 24 h trend, pinned Acknowledge |
| `iphone17-light-detail-acknowledged.png` | after acknowledging: pinned confirmation, Next open alert, Back to alerts |
| `iphone17-light-signin-demo.png`, `iphone17-light-signin-live.png`, `iphone17-light-signin-waiting.png` | sign-in (demo, first live version, live after an abandoned browser sign-in) |
| `se-light-list.png`, `se-dark-ax-list.png`, `se-dark-ax-detail-top.png`, `se-dark-detail-top.png`, `se-dark-detail-bin.png` | iPhone SE (3rd gen): light, dark + accessibility-large, detail stacking, dark bin section with hot spot |
| `se-release-launch-15s.png` | Release build after 15 s |
| `voiceover-labels.json`, `contrast-output.txt` | label dump, computed contrast ratios |

Not re-shot after the final redesign: the offline state (status line "Offline, demo data. 1 acknowledgement will send when you reconnect."), the sync queue screen, the
loading skeleton, empty and error states. Their content is asserted in jest; the earlier (pre-redesign) offline and queue screens were seen on the simulator. Screenshots in the
first pass of this task that showed superseded layouts were deleted so the folder only holds current screens. iPad was not validated (the target is iPhone-only, portrait-only).

## Pending / not done

- VoiceOver on a device or in the simulator's Accessibility Inspector; the label list above comes from the React tree, not from VoiceOver.
- Physical device, Android, Reduce Motion toggled on a simulator, keyboard / Switch Control.
- Real Dex login, real list, real acknowledgement and the `alert_transitions` check (see above; blocked by the password mismatch).
- Offline / queue / skeleton / error screenshots of the final layout; a landscape layout.
- Decision needed on `docs/DESIGN_SYSTEM.md`: this pass added a `display` type role (34 / 700 / 40, tabular) for the reading values and uses a tab-style filter and a status line that
  the document does not describe; the document was not edited.
- Fast Refresh: adding a hook to a mounted component during a session shows a transient "Should have a queue" red box in Debug; a cold launch is clean. Not a production issue.
