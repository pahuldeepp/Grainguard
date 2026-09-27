# Design check

## Contrast (WCAG 2.x)

| Mode | Pair | Ratio | Min | Result |
| --- | --- | --- | --- | --- |
| light | text on bg (#141a16 on #f3f4f2) | 16.01 | 4.5 | pass |
| light | text on surface (#141a16 on #ffffff) | 17.66 | 4.5 | pass |
| light | textMuted on surface (#4a544e on #ffffff) | 7.87 | 4.5 | pass |
| light | brand on surface (#0b5d36 on #ffffff) | 7.97 | 4.5 | pass |
| light | onBrand on brand (#ffffff on #0b5d36) | 7.97 | 4.5 | pass |
| light | focus ring on surface (#1d5fd1 on #ffffff) | 5.82 | 3 | pass |
| light | critical on surface (#b3261e on #ffffff) | 6.54 | 4.5 | pass |
| light | critical on 12% tint (#b3261e on #f6e5e4) | 5.37 | 4.5 | pass |
| light | warning on surface (#8a5a00 on #ffffff) | 5.93 | 4.5 | pass |
| light | warning on 12% tint (#8a5a00 on #f1ebe0) | 5.00 | 4.5 | pass |
| light | notice on surface (#1d5fd1 on #ffffff) | 5.82 | 4.5 | pass |
| light | notice on 12% tint (#1d5fd1 on #e4ecf9) | 4.89 | 4.5 | pass |
| light | ok on surface (#1e6b3c on #ffffff) | 6.51 | 4.5 | pass |
| light | ok on 12% tint (#1e6b3c on #e4ede8) | 5.45 | 4.5 | pass |
| light | offline on surface (#5b4b8a on #ffffff) | 7.45 | 4.5 | pass |
| light | offline on 12% tint (#5b4b8a on #ebe9f1) | 6.19 | 4.5 | pass |
| dark | text on bg (#eaefeb on #0f1311) | 16.09 | 4.5 | pass |
| dark | text on surface (#eaefeb on #171c19) | 14.83 | 4.5 | pass |
| dark | textMuted on surface (#a6b0aa on #171c19) | 7.74 | 4.5 | pass |
| dark | brand on surface (#4cbf84 on #171c19) | 7.47 | 4.5 | pass |
| dark | onBrand on brand (#06170e on #4cbf84) | 8.00 | 4.5 | pass |
| dark | focus ring on surface (#7fb0ff on #171c19) | 7.86 | 3 | pass |
| dark | critical on surface (#ff8a80 on #171c19) | 7.56 | 4.5 | pass |
| dark | critical on 12% tint (#ff8a80 on #332925) | 6.20 | 4.5 | pass |
| dark | warning on surface (#f2b84b on #171c19) | 9.64 | 4.5 | pass |
| dark | warning on 12% tint (#f2b84b on #312f1f) | 7.54 | 4.5 | pass |
| dark | notice on surface (#7fb0ff on #171c19) | 7.86 | 4.5 | pass |
| dark | notice on 12% tint (#7fb0ff on #232e35) | 6.31 | 4.5 | pass |
| dark | ok on surface (#6fd09a on #171c19) | 9.18 | 4.5 | pass |
| dark | ok on 12% tint (#6fd09a on #223228) | 7.18 | 4.5 | pass |
| dark | offline on surface (#b9a8f0 on #171c19) | 8.16 | 4.5 | pass |
| dark | offline on 12% tint (#b9a8f0 on #2a2d33) | 6.52 | 4.5 | pass |

## Warnings

none

## Violations

- apps/dashboard/src/style.css:211 [no-shadow] shadow outside sheet/menu: .nav a (box-shadow: inset 0 -2px 0 transparent)
- apps/dashboard/src/style.css:223 [no-shadow] shadow outside sheet/menu: .nav a[aria-current="page"] (box-shadow: inset 0 -2px 0 var(--brand))
- apps/dashboard/src/style.css:269 [no-shadow] shadow outside sheet/menu: .nav a (box-shadow: inset 0 2px 0 transparent)
- apps/dashboard/src/style.css:274 [no-shadow] shadow outside sheet/menu: .nav a[aria-current="page"] (box-shadow: inset 0 2px 0 var(--brand))

Mode: tolerant
