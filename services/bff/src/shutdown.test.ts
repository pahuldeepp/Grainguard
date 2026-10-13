import test from "node:test";
import assert from "node:assert/strict";
import { terminationGraceMs } from "./shutdown.js";
test("termination deadline covers accepted summaries and bounded drain/cleanup", () => {
  for (const invalid of [
    undefined,
    "",
    "NaN",
    "10000",
    "329999",
    "900001",
    "330000.5",
  ]) {
    assert.equal(terminationGraceMs(invalid), 340000);
  }
  assert.equal(terminationGraceMs("330000"), 330000);
  assert.equal(terminationGraceMs("900000"), 900000);
});

test("shutdown retains readiness gate, listener drain and cleanup timer release", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  const shutdown = source.slice(source.indexOf("const shutdown = () =>"));
  assert.ok(
    shutdown.indexOf("stopping = true") < shutdown.indexOf("listener.close"),
  );
  assert.match(
    shutdown,
    /terminationGraceMs\(process\.env\.BFF_TERMINATION_GRACE_MS\)/,
  );
  assert.ok(
    shutdown.indexOf("listener.close") < shutdown.indexOf("Promise.allSettled"),
  );
  assert.ok(
    shutdown.indexOf("Promise.allSettled") <
      shutdown.indexOf("clearTimeout(deadline)"),
  );
});
