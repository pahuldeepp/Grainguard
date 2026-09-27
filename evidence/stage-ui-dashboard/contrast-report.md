# Dashboard contrast check

Source: apps/dashboard/src/style.css tokens. AA text 4.5:1, non-text 3:1.

| Theme | Pair | Colours | Ratio | Min | Result |
| --- | --- | --- | --- | --- | --- |
| light | text on bg | #141a16 on #f3f4f2 | 16.01 | 4.5 | pass |
| light | text-muted on bg | #4a544e on #f3f4f2 | 7.13 | 4.5 | pass |
| light | brand (links, quiet buttons) on bg | #0b5d36 on #f3f4f2 | 7.23 | 4.5 | pass |
| light | focus ring on bg | #1d5fd1 on #f3f4f2 | 5.27 | 3 | pass |
| light | control border (line-strong) on bg | #79837d on #f3f4f2 | 3.55 | 3 | pass |
| light | text on surface | #141a16 on #ffffff | 17.66 | 4.5 | pass |
| light | text-muted on surface | #4a544e on #ffffff | 7.87 | 4.5 | pass |
| light | brand (links, quiet buttons) on surface | #0b5d36 on #ffffff | 7.97 | 4.5 | pass |
| light | focus ring on surface | #1d5fd1 on #ffffff | 5.82 | 3 | pass |
| light | control border (line-strong) on surface | #79837d on #ffffff | 3.92 | 3 | pass |
| light | on-brand on brand (primary button) | #ffffff on #0b5d36 | 7.97 | 4.5 | pass |
| light | critical text on surface | #b3261e on #ffffff | 6.54 | 4.5 | pass |
| light | critical text on bg | #b3261e on #f3f4f2 | 5.92 | 4.5 | pass |
| light | critical glyph/left bar on surface | #b3261e on #ffffff | 6.54 | 3 | pass |
| light | text on critical 12% banner tint | #141a16 on #f6e5e4 | 14.50 | 4.5 | pass |
| light | critical glyph on its 12% tint | #b3261e on #f6e5e4 | 5.37 | 3 | pass |
| light | warning text on surface | #8a5a00 on #ffffff | 5.93 | 4.5 | pass |
| light | warning text on bg | #8a5a00 on #f3f4f2 | 5.37 | 4.5 | pass |
| light | warning glyph/left bar on surface | #8a5a00 on #ffffff | 5.93 | 3 | pass |
| light | text on warning 12% banner tint | #141a16 on #f1ebe0 | 14.89 | 4.5 | pass |
| light | warning glyph on its 12% tint | #8a5a00 on #f1ebe0 | 5.00 | 3 | pass |
| light | notice text on surface | #1d5fd1 on #ffffff | 5.82 | 4.5 | pass |
| light | notice text on bg | #1d5fd1 on #f3f4f2 | 5.27 | 4.5 | pass |
| light | notice glyph/left bar on surface | #1d5fd1 on #ffffff | 5.82 | 3 | pass |
| light | text on notice 12% banner tint | #141a16 on #e4ecf9 | 14.86 | 4.5 | pass |
| light | notice glyph on its 12% tint | #1d5fd1 on #e4ecf9 | 4.89 | 3 | pass |
| light | ok text on surface | #1e6b3c on #ffffff | 6.51 | 4.5 | pass |
| light | ok text on bg | #1e6b3c on #f3f4f2 | 5.90 | 4.5 | pass |
| light | ok glyph/left bar on surface | #1e6b3c on #ffffff | 6.51 | 3 | pass |
| light | text on ok 12% banner tint | #141a16 on #e4ede8 | 14.78 | 4.5 | pass |
| light | ok glyph on its 12% tint | #1e6b3c on #e4ede8 | 5.45 | 3 | pass |
| light | offline text on surface | #5b4b8a on #ffffff | 7.45 | 4.5 | pass |
| light | offline text on bg | #5b4b8a on #f3f4f2 | 6.75 | 4.5 | pass |
| light | offline glyph/left bar on surface | #5b4b8a on #ffffff | 7.45 | 3 | pass |
| light | text on offline 12% banner tint | #141a16 on #ebe9f1 | 14.68 | 4.5 | pass |
| light | offline glyph on its 12% tint | #5b4b8a on #ebe9f1 | 6.19 | 3 | pass |
| dark | text on bg | #eaefeb on #0f1311 | 16.09 | 4.5 | pass |
| dark | text-muted on bg | #a6b0aa on #0f1311 | 8.39 | 4.5 | pass |
| dark | brand (links, quiet buttons) on bg | #4cbf84 on #0f1311 | 8.11 | 4.5 | pass |
| dark | focus ring on bg | #7fb0ff on #0f1311 | 8.52 | 3 | pass |
| dark | control border (line-strong) on bg | #7b867f on #0f1311 | 4.96 | 3 | pass |
| dark | text on surface | #eaefeb on #171c19 | 14.83 | 4.5 | pass |
| dark | text-muted on surface | #a6b0aa on #171c19 | 7.74 | 4.5 | pass |
| dark | brand (links, quiet buttons) on surface | #4cbf84 on #171c19 | 7.47 | 4.5 | pass |
| dark | focus ring on surface | #7fb0ff on #171c19 | 7.86 | 3 | pass |
| dark | control border (line-strong) on surface | #7b867f on #171c19 | 4.57 | 3 | pass |
| dark | on-brand on brand (primary button) | #06170e on #4cbf84 | 8.00 | 4.5 | pass |
| dark | critical text on surface | #ff8a80 on #171c19 | 7.56 | 4.5 | pass |
| dark | critical text on bg | #ff8a80 on #0f1311 | 8.20 | 4.5 | pass |
| dark | critical glyph/left bar on surface | #ff8a80 on #171c19 | 7.56 | 3 | pass |
| dark | text on critical 12% banner tint | #eaefeb on #332925 | 12.15 | 4.5 | pass |
| dark | critical glyph on its 12% tint | #ff8a80 on #332925 | 6.20 | 3 | pass |
| dark | warning text on surface | #f2b84b on #171c19 | 9.64 | 4.5 | pass |
| dark | warning text on bg | #f2b84b on #0f1311 | 10.46 | 4.5 | pass |
| dark | warning glyph/left bar on surface | #f2b84b on #171c19 | 9.64 | 3 | pass |
| dark | text on warning 12% banner tint | #eaefeb on #312f1f | 11.59 | 4.5 | pass |
| dark | warning glyph on its 12% tint | #f2b84b on #312f1f | 7.54 | 3 | pass |
| dark | notice text on surface | #7fb0ff on #171c19 | 7.86 | 4.5 | pass |
| dark | notice text on bg | #7fb0ff on #0f1311 | 8.52 | 4.5 | pass |
| dark | notice glyph/left bar on surface | #7fb0ff on #171c19 | 7.86 | 3 | pass |
| dark | text on notice 12% banner tint | #eaefeb on #232e35 | 11.92 | 4.5 | pass |
| dark | notice glyph on its 12% tint | #7fb0ff on #232e35 | 6.31 | 3 | pass |
| dark | ok text on surface | #6fd09a on #171c19 | 9.18 | 4.5 | pass |
| dark | ok text on bg | #6fd09a on #0f1311 | 9.95 | 4.5 | pass |
| dark | ok glyph/left bar on surface | #6fd09a on #171c19 | 9.18 | 3 | pass |
| dark | text on ok 12% banner tint | #eaefeb on #223228 | 11.61 | 4.5 | pass |
| dark | ok glyph on its 12% tint | #6fd09a on #223228 | 7.18 | 3 | pass |
| dark | offline text on surface | #b9a8f0 on #171c19 | 8.16 | 4.5 | pass |
| dark | offline text on bg | #b9a8f0 on #0f1311 | 8.85 | 4.5 | pass |
| dark | offline glyph/left bar on surface | #b9a8f0 on #171c19 | 8.16 | 3 | pass |
| dark | text on offline 12% banner tint | #eaefeb on #2a2d33 | 11.86 | 4.5 | pass |
| dark | offline glyph on its 12% tint | #b9a8f0 on #2a2d33 | 6.52 | 3 | pass |

All 72 pairs pass AA.
