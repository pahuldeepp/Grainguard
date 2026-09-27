# Stage 10e mobile UI audit (before the redesign)

Date: 2026-09-26. Build: Debug on iPhone 17 simulator, demo data. Screenshots in `evidence/stage10e-ui/before/`
(list light, list dark, list at accessibility-extra-large, alert detail). Sign-in, queue and offline states were
audited from the source in `apps/mobile/shell/src` because they are reached only by state changes; this is stated
so the audit is not read as more than it is. Reference: `docs/DESIGN_SYSTEM.md`.

## All screens (system level)

- No theme layer: colours are one ad hoc object (`ui/theme.ts`); none of the DESIGN_SYSTEM tokens (`surface`, `line`, `ok`, `offline`, `focus`, severity tokens) exist. Severity "high" uses a hard-coded `#c25e00`; "medium" and "low" have no colour at all.
- No type scale: sizes are literals (13, 16, 17, 20, 24, 30); no line heights, no tabular numerals, no Dynamic Type caps.
- Severity is an ALL-CAPS outlined pill with colour only differing; there is no glyph. Design system requires glyph + word, no ALL-CAPS labels, no pill everywhere.
- Every alert is an identical rounded card with a border (12 radius); the design system asks for full-bleed rows divided by 1px lines.
- Buttons are outlined green rectangles with 10 radius and 1.5 border; no pressed state, no busy state, no visible focus.

## Header (all signed-in screens)

- Header stacks a title, a "Demo data" pill, three outlined buttons (Queue, Switch tenant, Sign out) and a "Simulate offline" switch: about 45% of the screen before any alert appears (see list screenshot).
- The queue button label reads "Queue (0 pending, 0 rejected)": counts are prose in a button, not data.
- Sign out sits next to Switch tenant with equal weight; destructive action is one tap away from a routine one.
- At accessibility-extra-large text the title wraps to two lines, the "Demo data" pill is pushed off the right edge (clipped), the Queue button is three lines, and the "Simulate offline (demo)" label is clipped. The first alert is barely visible. The header does not scale.
- Demo banner is a lavender block that repeats the pill; developer wording ("No sign-in or server is used") on the primary path.

## Sign-in

- "Demo data" / "Live sign-in" buttons are two peer primary-looking buttons, then a third button whose label changes to "Sign in with browser (live)" / "Sign in (demo data)": three buttons, unclear which is the action and which is the mode. "PKCE" appears in an accessibility hint (dev jargon).
- No labelled field or explanation of what happens next (browser opens).

## Alert list

- Flat list, no grouping: open critical alerts and acknowledged history are mixed in creation order; nothing says what needs attention.
- No counts. Row has severity pill, time, bin, site, and state on four separate lines: tall and hard to scan.
- Acknowledged state is plain text "Acknowledged", with no glyph or colour.
- Empty state is a single grey line; loading state is text "Loading alerts..." (no skeleton); error is a grey line without a retry action (only pull to refresh).
- In live mode the row title is a raw UUID because `describeBin` only knows the bin id.

## Alert detail

- Facts are stacked label/value pairs of equal weight; the risk score is a plain 2-decimal string, not set as data; no tabular numerals.
- Rule id is shown raw (`grain-temp-hotspot`).
- Acknowledge is a full-width outlined-green/filled button below the fold on small phones; no busy state, no confirmation that is announced to screen readers; pressing it gives no feedback until the list refreshes.
- "Back to alerts" is a bordered button at the top instead of a navigation affordance.

## Sync queue

- Rows show the raw alert id ("Acknowledge a-1001") and "N attempts"; no per-item state glyph, no state word (waiting / sending / rejected), rejection reason shown as "Rejected a-1: <reason>" in red text only.
- Dismiss is a full-width red outlined button per row, giving the screen a heavy look; Sync now is disabled with no explanation.

## Offline

- Offline banner is amber text on amber; it is `accessibilityRole="alert"` but has no glyph and uses the warning colour (design system reserves `offline` purple for this, distinct from severity).
- Banner appears with no motion or announcement other than the role.

## Accessibility

- Contrast was never measured. Muted text `#55605a` on `#f4f5f2` passes, but medium/low severity colour is only `muted`, and the "high" orange on white is 3.7:1 (fails AA for 12-13pt bold text).
- Touch targets: buttons are 44 tall (ok) but the demo pill and live badge are about 26pt tall.
- No Dynamic Type caps and no layout that reflows (see the accessibility-XL screenshot).
- No Reduce Motion handling because there is no motion; pending announcements (acknowledge result, offline changes) are absent.

## Follow-up

The redesign that answers this audit, the rejected-designs log and the validation results are in
[STAGE_10E_UI_VALIDATION.md](STAGE_10E_UI_VALIDATION.md).
