import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkContrast,
  compareTokens,
  contrastRatio,
  exitCode,
  lintCss,
  lintTs,
  parseCssTokens,
  parseSpecScale,
  parseSpecTokens,
  parseTsTokens,
  scaleDrift,
  tint,
} from "./design-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = readFileSync(join(root, "docs/DESIGN_SYSTEM.md"), "utf8");
const rules = (findings) => findings.map((f) => f.rule);
const FOCUS = ".a:focus-visible { outline: 2px solid red; }";

test("spec table parses both modes and the spacing scale", () => {
  const tokens = parseSpecTokens(spec);
  assert.equal(tokens.light.brand, "#0b5d36");
  assert.equal(tokens.dark.surface, "#171c19");
  assert.deepEqual(parseSpecScale(spec), [4, 8, 12, 16, 24, 32, 48]);
});

test("contrast maths matches known values", () => {
  assert.equal(contrastRatio("#000000", "#ffffff").toFixed(2), "21.00");
  assert.ok(contrastRatio("#777777", "#ffffff") < 4.5);
  assert.equal(tint("#000000", "#ffffff", 0.5), "#808080");
});

test("every required pair in the real spec meets AA", () => {
  const rows = checkContrast(parseSpecTokens(spec));
  assert.ok(rows.length >= 32);
  assert.deepEqual(
    rows.filter((r) => !r.pass),
    [],
  );
});

test("a low-contrast palette fails", () => {
  const p = { ...parseSpecTokens(spec).light, textMuted: "#cccccc" };
  const rows = checkContrast({ light: p, dark: p });
  assert.ok(rows.some((r) => r.name === "textMuted on surface" && !r.pass));
});

test("css tokens: light, dark and name mapping", () => {
  const css = `:root { --muted: #4A544E; --brand: #fff; --surface-raised: #eee; }
@media (prefers-color-scheme: dark) { :root { --muted: #a6b0aa; } }`;
  const t = parseCssTokens(css);
  assert.equal(t.light.textMuted, "#4a544e");
  assert.equal(t.light.brand, "#ffffff");
  assert.equal(t.light.surfaceRaised, "#eeeeee");
  assert.equal(t.dark.textMuted, "#a6b0aa");
  assert.equal(t.dark.brand, undefined);
});

test("ts tokens parse and drift is reported", () => {
  const ts =
    "export const palette = { light: { bg: '#F3F4F2', text: '#000000' }, dark: { bg: '#0F1311' } } as const;";
  const impl = parseTsTokens(ts);
  const { drift, missing } = compareTokens(parseSpecTokens(spec), impl);
  assert.deepEqual(
    drift.map((d) => d.token),
    ["text"],
  );
  assert.ok(missing.includes("dark.text"));
});

test("scale drift flags off-scale values only", () => {
  assert.deepEqual(scaleDrift([4, 8], [4, 8], "x"), []);
  assert.equal(scaleDrift([5], [4, 8], "x").length, 1);
});

test("rule: no ALL-CAPS", () => {
  assert.ok(
    rules(lintCss(`.a { text-transform: uppercase; }\n${FOCUS}`)).includes(
      "no-all-caps",
    ),
  );
  assert.ok(
    !rules(lintCss(`.a { text-transform: none; }\n${FOCUS}`)).includes(
      "no-all-caps",
    ),
  );
  assert.ok(
    rules(lintTs("const s = { textTransform: 'uppercase' };")).includes(
      "no-all-caps",
    ),
  );
  assert.deepEqual(lintTs("const s = { textTransform: 'none' };"), []);
});

test("rule: radius above 8px, 50% allowed", () => {
  assert.ok(
    rules(lintCss(`.a { border-radius: 12px; }\n${FOCUS}`)).includes("radius"),
  );
  assert.ok(
    rules(lintCss(`.a { border-radius: 4px 999px; }\n${FOCUS}`)).includes(
      "radius",
    ),
  );
  assert.ok(
    !rules(lintCss(`.a { border-radius: 8px; }\n${FOCUS}`)).includes("radius"),
  );
  assert.ok(
    !rules(lintCss(`.a { border-radius: 50%; }\n${FOCUS}`)).includes("radius"),
  );
  assert.ok(rules(lintTs("x = { borderRadius: 16 }")).includes("radius"));
  assert.deepEqual(lintTs("x = { borderRadius: 8 }"), []);
});

test("rule: shadow only in sheets and menus", () => {
  assert.ok(
    rules(lintCss(`.card { box-shadow: 0 1px 2px #000; }\n${FOCUS}`)).includes(
      "no-shadow",
    ),
  );
  assert.ok(
    !rules(
      lintCss(`.sheet { box-shadow: 0 1px 2px rgb(0 0 0); }\n${FOCUS}`),
    ).includes("no-shadow"),
  );
  assert.ok(
    !rules(lintCss(`.card { box-shadow: none; }\n${FOCUS}`)).includes(
      "no-shadow",
    ),
  );
  assert.ok(
    rules(lintTs("x = { elevation: 4 }", "Row.tsx")).includes("no-shadow"),
  );
  assert.deepEqual(lintTs("x = { elevation: 4 }", "Sheet.tsx"), []);
});

test("rule: no gradients or glass", () => {
  const bad = `.a { background: linear-gradient(red, blue); backdrop-filter: blur(4px); }\n${FOCUS}`;
  assert.deepEqual(
    rules(lintCss(bad)).filter((r) => r.startsWith("no-g")),
    ["no-gradient", "no-glass"],
  );
  assert.deepEqual(lintCss(`.a { background: var(--bg); }\n${FOCUS}`), []);
  assert.ok(
    rules(lintTs("const g = 'radial-gradient(x)'")).includes("no-gradient"),
  );
});

test("rule: font size floor", () => {
  const f = (v) =>
    rules(lintCss(`.a { font-size: ${v}; }\n${FOCUS}`)).includes("font-size");
  assert.ok(f("12px"));
  assert.ok(f("0.75rem"));
  assert.ok(!f("14px"));
  assert.ok(!f("1rem"));
  assert.ok(rules(lintTs("x = { fontSize: 12 }")).includes("font-size"));
  assert.deepEqual(lintTs("x = { fontSize: 14 }"), []);
});

test("rule: reduced motion required when animating", () => {
  const anim = `.a { transition: color 150ms; }\n${FOCUS}`;
  assert.ok(rules(lintCss(anim)).includes("reduced-motion"));
  const ok = `${anim}\n@media (prefers-reduced-motion: reduce) { .a { transition: none; } }`;
  assert.ok(!rules(lintCss(ok)).includes("reduced-motion"));
  assert.ok(!rules(lintCss(FOCUS)).includes("reduced-motion"));
});

test("rule: focus-visible required", () => {
  assert.ok(rules(lintCss(".a { color: red; }")).includes("focus-visible"));
  assert.ok(!rules(lintCss(FOCUS)).includes("focus-visible"));
});

test("rule: hard-coded hex outside tokens", () => {
  assert.ok(rules(lintCss(`.a { color: #fff; }\n${FOCUS}`)).includes("no-hex"));
  assert.ok(
    !rules(lintCss(`:root { --brand: #0b5d36; }\n${FOCUS}`)).includes("no-hex"),
  );
  assert.ok(rules(lintTs("const c = '#FF0000';")).includes("no-hex"));
  assert.deepEqual(lintTs("// #FF0000 in a comment"), []);
});

test("findings carry line numbers", () => {
  const found = lintCss(
    `.a {\n  color: red;\n  border-radius: 20px;\n}\n${FOCUS}`,
  );
  assert.equal(found.find((f) => f.rule === "radius").line, 3);
});

test("exit code: warnings only fail under --strict", () => {
  const warn = { violations: [], warnings: ["x not yet implemented"] };
  assert.equal(exitCode(warn, false), 0);
  assert.equal(exitCode(warn, true), 1);
  assert.equal(exitCode({ violations: ["v"], warnings: [] }, false), 1);
});
