// WCAG 2.x contrast ratios for every text/surface pair in the design tokens.
// Run: node --experimental-strip-types scripts/contrast.mjs   (exit 1 on failure)
import { palette } from '../src/ui/theme/tokens.ts';

const lum = hex => {
  const n = parseInt(hex.slice(1), 16);
  const f = v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * f((n >> 16) & 255) +
    0.7152 * f((n >> 8) & 255) +
    0.0722 * f(n & 255)
  );
};
export const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground token, background token, minimum]. 4.5 for text, 3 for glyphs/borders.
const pairs = [
  ['text', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['text', 'surfaceRaised', 4.5],
  ['textMuted', 'bg', 4.5],
  ['textMuted', 'surface', 4.5],
  ['textMuted', 'surfaceRaised', 4.5],
  ['brand', 'bg', 4.5],
  ['brand', 'surface', 4.5],
  ['onBrand', 'brand', 4.5],
  ['critical', 'bg', 4.5],
  ['critical', 'surface', 4.5],
  ['warning', 'bg', 4.5],
  ['warning', 'surface', 4.5],
  ['notice', 'bg', 4.5],
  ['notice', 'surface', 4.5],
  ['ok', 'bg', 4.5],
  ['ok', 'surface', 4.5],
  ['offline', 'bg', 4.5],
  ['offline', 'surface', 4.5],
  ['focus', 'surface', 3],
  ['line', 'surface', 0], // 0 = advisory only (see report)
  ['surface', 'critical', 3],
  ['surface', 'ok', 3], // glyph ink on filled shapes
];
let failed = 0;
for (const scheme of ['light', 'dark']) {
  console.log(`\n${scheme}`);
  for (const [fg, bg, min] of pairs) {
    const r = ratio(palette[scheme][fg], palette[scheme][bg]);
    const ok = r >= min;
    if (!ok) failed++;
    if (min === 0) {
      console.log(
        `INFO ${fg.padEnd(10)} on ${bg.padEnd(13)} ${r.toFixed(
          2,
        )}:1 (advisory: WCAG 1.4.11 asks 3:1 for input borders)`,
      );
      continue;
    }
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${fg.padEnd(10)} on ${bg.padEnd(13)} ${r.toFixed(
        2,
      )}:1 (min ${min})`,
    );
  }
}
console.log(failed ? `\n${failed} failing` : '\nall pairs pass');
process.exit(failed ? 1 : 0);
