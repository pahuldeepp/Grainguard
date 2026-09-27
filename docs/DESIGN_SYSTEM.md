# GreenGuard design system

Status: direction set 2026-09-26 for the mobile shell (`apps/mobile/shell`) and the web dashboard (`apps/dashboard`). Both apps implement these tokens natively; nothing here changes an API or a flow.

## Who it is for and what it must do

Operators of grain storage (co-ops, elevators, farms) check bins for heat, moisture and CO2 risk, often on a phone, in a cab, in bright sun or at night, with poor signal. The job of the interface: show what needs attention now, let a tired person acknowledge it in two taps, and be honest about what is stale or unsent.

## Direction: field instrument

Neutral, legible, quiet. Galvanised-steel greys and one deep spruce green for identity; colour is spent almost entirely on severity. No gradients, no glass, no shadows for decoration, no stock hero. Data (temperature, moisture, scores, times) is set in tabular figures and is the visual centre of every screen. One memorable element: the severity marker (shape + label + colour) that is identical everywhere.

Defaults deliberately avoided: cream-and-terracotta, acid-green-on-black, identical rounded cards with the same shadow, ALL-CAPS eyebrow labels, badge/pill everywhere, decorative numbering.

## Tokens

### Colour (light / dark). Every text pair below meets WCAG AA (4.5:1) on its surface.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `bg` | #F3F4F2 | #0F1311 | screen background |
| `surface` | #FFFFFF | #171C19 | rows, sheets |
| `surfaceRaised` | #FFFFFF | #1E2521 | modals, active row |
| `line` | #D5D9D5 | #2C3530 | 1px separators, input borders |
| `text` | #141A16 | #EAEFEB | primary text |
| `textMuted` | #4A544E | #A6B0AA | secondary text (never below AA) |
| `brand` | #0B5D36 | #4CBF84 | identity, primary actions, links |
| `onBrand` | #FFFFFF | #06170E | text on brand fills |
| `focus` | #1D5FD1 | #7FB0FF | focus ring (2px, 2px offset) |
| `critical` | #B3261E | #FF8A80 | severity critical |
| `warning` | #8A5A00 | #F2B84B | severity warning (text-safe amber) |
| `notice` | #1D5FD1 | #7FB0FF | severity notice / info |
| `ok` | #1E6B3C | #6FD09A | resolved / acknowledged / online |
| `offline` | #5B4B8A | #B9A8F0 | offline / unsent (distinct from severity) |

Severity fills use the colour at 12% over `surface` as a tint; the text and icon use the solid token. Severity is NEVER colour alone: each level has a fixed glyph and a word.

| Level | Glyph | Word | Shape |
| --- | --- | --- | --- |
| Critical | filled octagon with "!" | Critical | octagon |
| High | filled triangle with "!" | High | triangle |
| Warning | outlined triangle with "!" | Warning | triangle outline |
| Notice | circle with "i" | Notice | circle |
| Acknowledged / OK | circle with check | Acknowledged | circle |
| Offline / unsent | cloud with slash | Unsent | cloud |

### Type

System UI font on both platforms (SF Pro on iOS, so Dynamic Type works; system stack on web). No downloaded fonts.

| Role | Size / weight / line | Notes |
| --- | --- | --- |
| Screen title | 28 / 700 / 34 | one per screen |
| Section | 20 / 600 / 26 | |
| Row title | 17 / 600 / 22 | alert or bin name |
| Body | 16 / 400 / 24 | 16px minimum so iOS does not zoom inputs |
| Data value | 22 / 600 / 28, tabular numerals | readings and scores |
| Meta | 14 / 400 / 20 | times, ids; never below 14 |
| Button | 17 / 600 / 22 | sentence case |

Sentence case everywhere. No ALL-CAPS labels. Line length under 70 characters. On mobile every size scales with Dynamic Type (`allowFontScaling`, cap at accessibility-large where layout requires); on web use rem.

### Space, radius, elevation

Spacing scale (px): 4, 8, 12, 16, 24, 32, 48. Screen gutter 16 (phone) / 24 (tablet, desktop). Radius: 4 for inputs and chips, 8 for buttons, sheets and grouped lists, 0 for full-bleed rows; nothing larger. Elevation: none on rows; a 1px `line` divides content. Only sheets and menus may cast a shadow.

Touch targets at least 44x44 pt (mobile) and 24px with 44px hit area (web). Rows are separated by lines, not stacked as individual cards.

### Components

- **Button:** primary (filled `brand`), secondary (1px `line` border, `text`), destructive (text + `critical` outline). Height 48. States: default, pressed (12% darker), disabled (50% and `accessibilityState.disabled`), busy (spinner replaces label, width fixed, label kept for screen readers as "Acknowledging").
- **Input:** 48 high, 1px `line`, 2px `focus` ring on focus, label above (never placeholder-only), error text below with an icon.
- **Alert row:** severity marker (glyph + word) left, bin/site name (row title), time and rule (meta), state at right; whole row one 44+ target; state read as one VoiceOver phrase ("Critical, Bin 14 corn, North Elevator, open, 12 minutes ago").
- **Status banner:** full-width strip under the header for offline ("Offline. 2 acknowledgements will send when you reconnect.") and stale-data; icon + text; not colour alone.
- **Sync queue:** a list of unsent acknowledgements with per-item state (waiting, sending, rejected with reason), retry and dismiss actions.
- **Empty / error / loading:** skeleton rows for loading (no spinner-only screens), an empty state that says what is normal and what to do ("No open alerts. Bins are within limits."), an error state that says what failed and offers Retry.
- **Motion:** 150-200ms ease-out only in response to a tap (row press, state change, banner appear); no entrance animations; respect Reduce Motion (mobile) and `prefers-reduced-motion` (web) by removing movement and keeping instant state changes.

### Accessibility floor (both apps)

Every control has a role and a label; severity and state are in the label text; focus order follows reading order; visible focus ring on web; contrast AA in both themes; light and dark follow the system setting; nothing depends on hover; forms have programmatic labels and error association; live regions announce the acknowledgement result and offline changes.

## Voice

Plain verbs, active voice, the same word for the same action throughout ("Acknowledge" produces "Acknowledged"; "Sign in" not "Log in"). Errors say what happened and what to do; they do not apologise.
