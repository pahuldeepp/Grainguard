#!/usr/bin/env node
// Design-system conformance check. docs/DESIGN_SYSTEM.md is the source of truth.
// Usage: node scripts/design-check.mjs [--strict] [--report=<path>]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const MODES = ["light", "dark"];
export const SEVERITY = ["critical", "warning", "notice", "ok", "offline"];
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;
const TINT = 0.12;
const MAX_RADIUS = 8;
const MIN_FONT = 14;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const SHEET_RE = /sheet|menu|dialog|modal/i;

// ---------- spec parsing ----------

const TOKEN_ROW =
  /^\|\s*`(\w+)`\s*\|\s*(#[0-9A-Fa-f]{6})\s*\|\s*(#[0-9A-Fa-f]{6})\s*\|/;

export function parseSpecTokens(md) {
  const out = { light: {}, dark: {} };
  for (const line of md.split("\n")) {
    const m = TOKEN_ROW.exec(line);
    if (m) {
      out.light[m[1]] = m[2].toLowerCase();
      out.dark[m[1]] = m[3].toLowerCase();
    }
  }
  return out;
}

export function parseSpecScale(md) {
  const m = /Spacing scale \(px\):\s*([\d,\s]+)/.exec(md);
  return m ? m[1].split(",").map((s) => Number(s.trim())) : [];
}

// ---------- contrast ----------

export function normalizeHex(value) {
  let h = String(value).trim().toLowerCase();
  if (!h.startsWith("#")) return null;
  h = h.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null;
}

export function hexToRgb(hex) {
  const n = normalizeHex(hex);
  return [1, 3, 5].map((i) => Number.parseInt(n.slice(i, i + 2), 16));
}

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function tint(fg, bg, alpha = TINT) {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  const mixed = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function requiredPairs(p) {
  const pairs = [
    ["text on bg", p.text, p.bg, AA_TEXT],
    ["text on surface", p.text, p.surface, AA_TEXT],
    ["textMuted on surface", p.textMuted, p.surface, AA_TEXT],
    ["brand on surface", p.brand, p.surface, AA_TEXT],
    ["onBrand on brand", p.onBrand, p.brand, AA_TEXT],
    ["focus ring on surface", p.focus, p.surface, AA_NON_TEXT],
  ];
  for (const level of SEVERITY) {
    pairs.push([`${level} on surface`, p[level], p.surface, AA_TEXT]);
    pairs.push([
      `${level} on 12% tint`,
      p[level],
      tint(p[level], p.surface),
      AA_TEXT,
    ]);
  }
  return pairs;
}

export function checkContrast(spec) {
  const rows = [];
  for (const mode of MODES) {
    for (const [name, fg, bg, min] of requiredPairs(spec[mode])) {
      const ratio = contrastRatio(fg, bg);
      rows.push({ mode, name, fg, bg, min, ratio, pass: ratio >= min });
    }
  }
  return rows;
}

// ---------- implemented token extraction ----------

const CSS_NAME_MAP = { muted: "textMuted" };

export function cssNameToToken(name) {
  const bare = name.replace(/^--/, "");
  if (CSS_NAME_MAP[bare]) return CSS_NAME_MAP[bare];
  return bare.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return text.length - 1;
}

function splitDarkBlocks(css) {
  const re = /@media[^{]*prefers-color-scheme:\s*dark[^{]*\{/g;
  let light = "";
  let dark = "";
  let last = 0;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(css, open);
    light += css.slice(last, m.index);
    dark += css.slice(open + 1, close);
    last = close + 1;
    re.lastIndex = last;
  }
  return { light: light + css.slice(last), dark };
}

function customProps(css) {
  const out = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

export function parseCssTokens(cssRaw) {
  const css = stripCssComments(cssRaw);
  const parts = splitDarkBlocks(css);
  const result = { light: {}, dark: {}, props: customProps(parts.light) };
  for (const mode of MODES) {
    for (const [name, value] of Object.entries(customProps(parts[mode]))) {
      const hex = normalizeHex(value);
      if (hex) result[mode][cssNameToToken(name)] = hex;
    }
  }
  return result;
}

function tsBlock(ts, mode) {
  const m = new RegExp(`\\b${mode}\\s*:\\s*\\{([^}]*)\\}`).exec(ts);
  return m ? m[1] : "";
}

export function parseTsTokens(ts) {
  const out = { light: {}, dark: {} };
  for (const mode of MODES) {
    for (const m of tsBlock(ts, mode).matchAll(
      /(\w+)\s*:\s*['"](#[^'"]+)['"]/g,
    )) {
      const hex = normalizeHex(m[2]);
      if (hex) out[mode][m[1]] = hex;
    }
  }
  return out;
}

export function tsObjectNumbers(ts, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\{([^}]*)\\}`).exec(ts);
  if (!m) return null;
  return [...m[1].matchAll(/:\s*(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]));
}

export function compareTokens(spec, impl) {
  const drift = [];
  const missing = [];
  for (const mode of MODES) {
    for (const [token, want] of Object.entries(spec[mode])) {
      const got = impl[mode][token];
      if (got === undefined) missing.push(`${mode}.${token}`);
      else if (got !== want) drift.push({ mode, token, want, got });
    }
  }
  return { drift, missing };
}

export function scaleDrift(values, scale, label) {
  return values
    .filter((v) => !scale.includes(v))
    .map((v) => `${label} value ${v} is not on the ${scale.join("/")} scale`);
}

// ---------- lint ----------

export function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function declarations(cssRaw) {
  const css = stripCssComments(cssRaw);
  const out = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    const bodyStart = rule.index + rule[0].indexOf("{") + 1;
    let offset = 0;
    for (const chunk of rule[2].split(";")) {
      const at = chunk.indexOf(":");
      if (at > 0) {
        const lead = chunk.length - chunk.trimStart().length;
        out.push({
          selector,
          prop: chunk.slice(0, at).trim().toLowerCase(),
          value: chunk.slice(at + 1).trim(),
          line: lineAt(css, bodyStart + offset + lead),
        });
      }
      offset += chunk.length + 1;
    }
  }
  return out;
}

function toPx(token) {
  const m = /^(\d*\.?\d+)(px|rem|em)?$/.exec(token);
  if (!m) return null;
  return m[2] === "rem" || m[2] === "em" ? Number(m[1]) * 16 : Number(m[1]);
}

function radiusViolation(value) {
  for (const token of value.split(/[\s/]+/)) {
    if (token.endsWith("%")) {
      if (token !== "50%") return token;
    } else if ((toPx(token) ?? 0) > MAX_RADIUS) return token;
  }
  return null;
}

function fontViolation(value) {
  const m = /^(\d*\.?\d+)(px|rem)$/.exec(value);
  if (!m) return false;
  const px = m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
  return px < MIN_FONT;
}

function declRules(d) {
  const found = [];
  const add = (rule, message) =>
    found.push({
      rule,
      line: d.line,
      message: `${message} (${d.prop}: ${d.value})`,
    });
  if (d.prop === "text-transform" && /uppercase/i.test(d.value)) {
    add("no-all-caps", "ALL-CAPS text-transform");
  }
  if (d.prop.startsWith("border") && d.prop.endsWith("radius")) {
    const bad = radiusViolation(d.value);
    if (bad) add("radius", `radius ${bad} exceeds ${MAX_RADIUS}px`);
  }
  if (d.prop === "box-shadow" && !/^none$/i.test(d.value)) {
    if (!SHEET_RE.test(d.selector))
      add("no-shadow", `shadow outside sheet/menu: ${d.selector}`);
  }
  if (/(linear|radial)-gradient/i.test(d.value)) add("no-gradient", "gradient");
  if (d.prop === "backdrop-filter") add("no-glass", "backdrop-filter");
  if (d.prop === "font-size" && fontViolation(d.value)) {
    add("font-size", `font size below ${MIN_FONT}px`);
  }
  if (!d.prop.startsWith("--") && HEX_RE.test(d.value)) {
    add("no-hex", "hard-coded hex colour outside a token");
  }
  return found;
}

export function lintCss(css) {
  const findings = declarations(css).flatMap(declRules);
  const clean = stripCssComments(css);
  const motion =
    /(^|[\s;{])(transition|animation)(-[a-z-]+)?\s*:|@keyframes/.exec(clean);
  if (motion && !/prefers-reduced-motion/.test(clean)) {
    findings.push({
      rule: "reduced-motion",
      line: lineAt(clean, motion.index),
      message: "transitions/animations without a prefers-reduced-motion block",
    });
  }
  if (!/:focus-visible/.test(clean)) {
    findings.push({
      rule: "focus-visible",
      line: 1,
      message: "no :focus-visible styles",
    });
  }
  return findings.sort((a, b) => a.line - b.line);
}

const TS_RULES = [
  [
    "no-all-caps",
    /textTransform\s*:\s*['"]uppercase['"]/,
    () => "ALL-CAPS textTransform",
  ],
  [
    "no-shadow",
    /\b(shadow(Color|Opacity|Radius|Offset)|elevation)\s*:/,
    () => "shadow/elevation outside sheet/menu",
  ],
  ["no-gradient", /(linear|radial)-?gradient/i, () => "gradient"],
  ["no-glass", /backdrop-?filter|BlurView/i, () => "blur/glass"],
];

function tsLineFindings(text, lineNo, file) {
  const out = [];
  const add = (rule, message) => out.push({ rule, line: lineNo, message });
  for (const [rule, re, msg] of TS_RULES) {
    if (re.test(text) && !(rule === "no-shadow" && SHEET_RE.test(file)))
      add(rule, msg());
  }
  const radius = /borderRadius\s*:\s*(\d+(?:\.\d+)?)/.exec(text);
  if (radius && Number(radius[1]) > MAX_RADIUS && !/circle/i.test(text)) {
    add("radius", `borderRadius ${radius[1]} exceeds ${MAX_RADIUS}`);
  }
  const font = /\bfontSize\s*:\s*(\d+(?:\.\d+)?)/.exec(text);
  if (font && Number(font[1]) < MIN_FONT)
    add("font-size", `fontSize ${font[1]} below ${MIN_FONT}`);
  if (HEX_RE.test(text))
    add("no-hex", "hard-coded hex colour outside token files");
  return out;
}

export function lintTs(source, file = "") {
  const out = [];
  source.split("\n").forEach((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
    out.push(...tsLineFindings(text, i + 1, file));
  });
  return out;
}

// ---------- orchestration ----------

const CSS_REL = "apps/dashboard/src/style.css";
const TS_REL = "apps/mobile/shell/src/ui/theme/tokens.ts";
const SPEC_REL = "docs/DESIGN_SYSTEM.md";
const NOT_YET = "not yet implemented";

function readIf(root, rel) {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function listSources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") listSources(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
      out.push(p);
    }
  }
  return out.sort();
}

function driftSection(label, spec, impl, res) {
  for (const d of impl ? compareTokens(spec, impl).drift : []) {
    res.violations.push(
      `${label} drift ${d.mode}.${d.token}: spec ${d.want}, implemented ${d.got}`,
    );
  }
  const missing = impl ? compareTokens(spec, impl).missing : [];
  if (missing.length)
    res.warnings.push(`${label}: ${NOT_YET}: ${missing.join(", ")}`);
}

function checkImplementations(root, spec, scale, res) {
  const css = readIf(root, CSS_REL);
  const ts = readIf(root, TS_REL);
  if (css === null) res.warnings.push(`${CSS_REL} ${NOT_YET}`);
  if (ts === null) res.warnings.push(`${TS_REL} ${NOT_YET}`);
  const cssTokens = css === null ? null : parseCssTokens(css);
  driftSection("dashboard", spec, cssTokens, res);
  driftSection("mobile", spec, ts === null ? null : parseTsTokens(ts), res);
  if (cssTokens) {
    const px = Object.entries(cssTokens.props)
      .filter(([k]) => k.startsWith("--space-"))
      .map(([, v]) => Number.parseFloat(v));
    res.violations.push(...scaleDrift(px, scale, "dashboard spacing"));
  }
  const space = ts === null ? null : tsObjectNumbers(ts, "space");
  if (space) res.violations.push(...scaleDrift(space, scale, "mobile spacing"));
}

function lintFiles(root, res) {
  const css = readIf(root, CSS_REL);
  const push = (file, findings) => {
    for (const f of findings) res.lint.push({ file, ...f });
  };
  if (css !== null) push(CSS_REL, lintCss(css));
  const roots = ["apps/dashboard/src", "apps/mobile/shell/src"];
  for (const r of roots) {
    for (const abs of listSources(join(root, r))) {
      const rel = relative(root, abs);
      if (rel === TS_REL) continue;
      push(rel, lintTs(readFileSync(abs, "utf8"), rel));
    }
  }
}

export function runChecks(root) {
  const res = { contrast: [], violations: [], warnings: [], lint: [] };
  const md = readIf(root, SPEC_REL);
  if (md === null) {
    res.violations.push(`${SPEC_REL} missing: the spec is the source of truth`);
    return res;
  }
  const spec = parseSpecTokens(md);
  if (!Object.keys(spec.light).length) {
    res.violations.push(`${SPEC_REL}: no colour token table found`);
    return res;
  }
  res.contrast = checkContrast(spec);
  for (const c of res.contrast.filter((r) => !r.pass)) {
    res.violations.push(
      `contrast ${c.mode} ${c.name}: ${c.ratio.toFixed(2)}:1 < ${c.min}:1`,
    );
  }
  checkImplementations(root, spec, parseSpecScale(md), res);
  lintFiles(root, res);
  for (const l of res.lint)
    res.violations.push(`${l.file}:${l.line} [${l.rule}] ${l.message}`);
  return res;
}

export function formatReport(res, strict) {
  const lines = ["# Design check", "", "## Contrast (WCAG 2.x)", ""];
  lines.push(
    "| Mode | Pair | Ratio | Min | Result |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const c of res.contrast) {
    lines.push(
      `| ${c.mode} | ${c.name} (${c.fg} on ${c.bg}) | ${c.ratio.toFixed(2)} | ${c.min} | ${c.pass ? "pass" : "FAIL"} |`,
    );
  }
  lines.push(
    "",
    "## Warnings",
    "",
    ...(res.warnings.length ? res.warnings.map((w) => `- ${w}`) : ["none"]),
  );
  lines.push(
    "",
    "## Violations",
    "",
    ...(res.violations.length ? res.violations.map((v) => `- ${v}`) : ["none"]),
  );
  lines.push("", `Mode: ${strict ? "strict" : "tolerant"}`);
  return `${lines.join("\n")}\n`;
}

export function exitCode(res, strict) {
  return res.violations.length || (strict && res.warnings.length) ? 1 : 0;
}

export function main(argv, root, write = (s) => process.stdout.write(s)) {
  const strict = argv.includes("--strict");
  const res = runChecks(root);
  const report = formatReport(res, strict);
  write(report);
  const target = argv.find((a) => a.startsWith("--report="));
  if (target) {
    const path = join(root, target.slice("--report=".length));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report);
  }
  return exitCode(res, strict);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = main(process.argv.slice(2), root);
}
