# Dashboard UI audit (before)

Method: a fixture harness (outside the repo) renders the real `App` with a stubbed `fetch`, so signed-in views show data. Playwright (Chromium) captured 11 states at 375, 768 and 1280 px in light and dark: `evidence/stage-ui-dashboard/before/`. The live stack and browser E2E were not used.

## Global
- Hero copy ("Better grain care. A solid foundation.", eyebrow, intro), a "Local development" pill, a "Your workspace" promo block and a footer sit on every route. They carry no information and push the working content down; on a phone the alert list starts below about 900 px of chrome.
- Service status cards render on every route with a decorative glyph and a per-card status pill. Health is not a task; a failure is not surfaced as a banner.
- Every screen is a white rounded card on a grey page (identical cards, 14 px radius). DESIGN_SYSTEM.md says rows separated by lines, radius at most 8, no decoration.
- Colours are ad hoc hex values (#193c32, #7b9175, ...) with no tokens. Muted greys (#738074, #7a8777 at 11-12 px) fail 4.5:1. Dark mode comes only from Chakra defaults, which mixes with the custom light hex values.
- Type: Inter (not installed, silently falls back), sizes 11, 12, 13 px; eyebrow labels in ALL CAPS with letter spacing; body below the 16 px floor in several places.
- No `:focus-visible` styling of its own; no skip link; `nav` is not labelled; the current page is not marked (`aria-current`).
- Nav is a wrapping row on 375 px, with the pill wrapping to a third line. No mobile-appropriate navigation.
- Sign out is an unstyled bare button above the header. Sign-in and "Restoring sign-in" screens are unstyled text.
- Chakra `Button`/`Input`/`Badge` and native controls are mixed; controls are 32-40 px high, under the 44 px hit-area rule.

## Alerts
- Rows show `critical · Bin <36-char UUID>` in bold with the meta text floating in the middle of the row, misaligned per row (see 1280 px).
- No severity marker: severity is plain lowercase text. State is lowercase text.
- Raw ISO timestamps with milliseconds ("2026-09-26T16:41:07.531Z").
- No detail view; rule, version and escalation are fetched but never shown.
- Loading is text only; the error message has no recovery action; empty says "No alerts in this view." with no hint of what is normal.
- Filter is an unlabelled-looking select ("State Open" on one line).
- Acknowledge result is not announced; only errors are (role=alert).

## Provisioning
- Inputs sit in a wrapping flex row; labels wrap the input, so the validation error text becomes part of the accessible name. Errors are not linked to the input (`aria-describedby`/`aria-invalid` missing) and have no icon.
- "Stage 08 · live workflow" is an internal label shown to users.
- State chip is a yellow pill with low-contrast text in dark mode; history is a list of `action · ISO time` with the time wrapping mid-value at 375 px.
- Start and Track are the same visual weight; the flow (start, then follow) is not clear.

## Devices, current reading, history, averages
- Search form and result list have no separation between the field and its button; tables use `white-space: nowrap` and scroll sideways on a phone with no hint.
- Times are raw ISO strings in five columns; temperature and humidity are not tabular numerals and are not emphasised.
- Back links use an arrow glyph inside the link name; date inputs and "Group by" select are unstyled or inconsistent.
- Loading/empty/error states are plain paragraphs.

## Accessibility
- Headings: two `h1`-less views (h2 only) under one marketing `h1`; the h1 is not the page title.
- Contrast failures (approx.): `#738074` on white 4.1:1, `#7a8777` on #f5f7f2 3.6:1, `#66756a` on white 4.9 but 3.9 on tinted, `#914a2d` on `#fff0e4` about 5.0 (ok), dark status text mixed with Chakra tokens.
- No `prefers-reduced-motion` or `forced-colors` handling.
- Live regions: only the loading `output` elements; acknowledgement and offline changes are silent.
