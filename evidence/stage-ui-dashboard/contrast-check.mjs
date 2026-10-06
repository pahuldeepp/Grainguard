// WCAG contrast check for every token pair the dashboard uses, in both themes.
// Reads the tokens straight from apps/dashboard/src/style.css. Exit 1 below AA.
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../../apps/dashboard/src/style.css", import.meta.url), "utf8");
const block = (start) => {
  const i = css.indexOf(start);
  return css.slice(i, css.indexOf("\n  }\n}", i) > 0 && start.includes("@media") ? css.indexOf("\n  }\n}", i) : css.indexOf("\n}", i));
};
const grab = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]));
const light = grab(block(":root {"));
const dark = { ...light, ...grab(block("@media (prefers-color-scheme: dark)")) };
const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (fg, bg, t) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * t + parseInt(bg.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, "0")).join("");
const rows = [];
let failed = 0;
for (const [mode, t] of [["light", light], ["dark", dark]]) {
  const check = (label, fg, bg, min) => {
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) failed++;
    rows.push(`| ${mode} | ${label} | ${fg} on ${bg} | ${r.toFixed(2)} | ${min} | ${ok ? "pass" : "FAIL"} |`);
  };
  for (const bg of ["bg", "surface"]) {
    check(`text on ${bg}`, t.text, t[bg], 4.5);
    check(`text-muted on ${bg}`, t["text-muted"], t[bg], 4.5);
    check(`brand (links, quiet buttons) on ${bg}`, t.brand, t[bg], 4.5);
    check(`focus ring on ${bg}`, t.focus, t[bg], 3);
    check(`control border (line-strong) on ${bg}`, t["line-strong"], t[bg], 3);
  }
  check("on-brand on brand (primary button)", t["on-brand"], t.brand, 4.5);
  for (const k of ["critical", "warning", "notice", "ok", "offline"]) {
    check(`${k} text on surface`, t[k], t.surface, 4.5);
    check(`${k} text on bg`, t[k], t.bg, 4.5);
    check(`${k} glyph/left bar on surface`, t[k], t.surface, 3);
    check(`text on ${k} 12% banner tint`, t.text, mix(t[k], t.surface, 0.12), 4.5);
    check(`${k} glyph on its 12% tint`, t[k], mix(t[k], t.surface, 0.12), 3);
  }
}
const out = ["# Dashboard contrast check", "", "Source: apps/dashboard/src/style.css tokens. AA text 4.5:1, non-text 3:1.", "", "| Theme | Pair | Colours | Ratio | Min | Result |", "| --- | --- | --- | --- | --- | --- |", ...rows, "", failed ? `FAILED: ${failed} pair(s) below AA` : `All ${rows.length} pairs pass AA.`].join("\n");
console.log(out);
process.exit(failed ? 1 : 0);
