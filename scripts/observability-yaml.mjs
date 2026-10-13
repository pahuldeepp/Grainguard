// Minimal YAML subset reader for Prometheus rule files: block mappings,
// block sequences, quoted/plain scalars and literal (|) or folded (>) blocks.
// It exists so the observability checks need no new dependency.

const KEY_PATTERN = /^([^\s'"#][^:]*|"[^"]*"|'[^']*'):(?:\s+(.*))?$/;

function prepare(text) {
  return text
    .split("\n")
    .map((raw) => ({
      raw,
      indent: raw.length - raw.trimStart().length,
      text: raw.trim(),
    }))
    .filter((line) => line.text !== "" && !line.text.startsWith("#"));
}

function scalar(value) {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length > 1) {
    return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function readBlockScalar(state, parentIndent, style) {
  const collected = [];
  let base = null;
  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    if (line.indent <= parentIndent) break;
    base ??= line.indent;
    collected.push(line.raw.slice(base));
    state.pos += 1;
  }
  const joined = collected.join(style === "|" ? "\n" : " ");
  return `${joined}${style === "|" ? "\n" : ""}`;
}

function readMapValue(state, indent, rest) {
  if (rest === undefined || rest === "") {
    const next = state.lines[state.pos];
    const nested =
      next &&
      (next.indent > indent ||
        (next.indent === indent && next.text.startsWith("- ")));
    return nested ? readBlock(state, next.indent) : null;
  }
  if (rest === "|" || rest === ">") return readBlockScalar(state, indent, rest);
  return scalar(rest);
}

function readMap(state, indent) {
  const map = {};
  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    if (line.indent !== indent || line.text.startsWith("- ")) break;
    const match = KEY_PATTERN.exec(line.text);
    if (!match) throw new Error(`Unsupported YAML near: ${line.text}`);
    state.pos += 1;
    map[scalar(match[1])] = readMapValue(state, indent, match[2]);
  }
  return map;
}

function readSeq(state, indent) {
  const list = [];
  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    if (line.indent !== indent || !line.text.startsWith("- ")) break;
    const rest = line.text.slice(2).trim();
    if (KEY_PATTERN.test(rest)) {
      // Re-read the item body as a mapping indented past the dash.
      state.lines[state.pos] = { ...line, indent: indent + 2, text: rest };
      list.push(readMap(state, indent + 2));
    } else {
      state.pos += 1;
      list.push(scalar(rest));
    }
  }
  return list;
}

function readBlock(state, indent) {
  return state.lines[state.pos].text.startsWith("- ")
    ? readSeq(state, indent)
    : readMap(state, indent);
}

export function parseYaml(text) {
  const state = { lines: prepare(text), pos: 0 };
  if (state.lines.length === 0) return null;
  return readBlock(state, state.lines[0].indent);
}
