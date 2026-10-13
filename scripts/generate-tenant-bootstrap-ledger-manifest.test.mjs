import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const generator = path.join(
  root,
  "scripts/generate-tenant-bootstrap-ledger-manifest.mjs",
);

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "gg-owner-ledger-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, output: path.join(directory, "owner-migrations.json") };
}

function generate(output, source = root) {
  return spawnSync(
    process.execPath,
    [generator, "--root", source, "--output", output],
    { encoding: "utf8" },
  );
}

test("repeated builds replace the read-only manifest with identical complete data", (t) => {
  const { directory, output } = fixture(t);
  assert.equal(generate(output).status, 0);
  const first = readFileSync(output, "utf8");
  assert.equal(statSync(output).mode & 0o222, 0);
  assert.equal(statSync(output).mode & 0o400, 0o400);
  assert.equal(generate(output).status, 0);
  assert.equal(readFileSync(output, "utf8"), first);
  assert.equal(statSync(output).mode & 0o222, 0);
  assert.equal(statSync(output).mode & 0o400, 0o400);
  assert.equal(Object.keys(JSON.parse(first).owners).length, 9);
  assert.deepEqual(readdirSync(directory), ["owner-migrations.json"]);
});

test("invalid migration inputs preserve the previous complete manifest", (t) => {
  const { directory, output } = fixture(t);
  assert.equal(generate(output).status, 0);
  const first = readFileSync(output, "utf8");
  assert.notEqual(generate(output, directory).status, 0);
  assert.equal(readFileSync(output, "utf8"), first);
  assert.deepEqual(readdirSync(directory), ["owner-migrations.json"]);
});

test("replacing an output link does not overwrite the linked file", (t) => {
  const { directory, output } = fixture(t);
  const untouched = path.join(directory, "untouched.json");
  writeFileSync(untouched, "retain this file\n");
  symlinkSync(untouched, output);
  assert.equal(generate(output).status, 0);
  assert.equal(readFileSync(untouched, "utf8"), "retain this file\n");
  assert.equal(statSync(output).mode & 0o222, 0);
  assert.equal(statSync(output).mode & 0o400, 0o400);
});
