import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSignedAuditExport } from "./index.js";
import { verifyFiles } from "./verify-cli.js";

test("verify-audit-export files accept signed content and reject a changed file", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "greenguard-audit-"));
  try {
    const keys = generateKeyPairSync("ed25519");
    const exportData = createSignedAuditExport({
      tenantId: "11111111-1111-4111-8111-111111111111",
      rows: [],
      privateKey: keys.privateKey,
      publicKeyId: "test",
    });
    const paths = [
      "audit.jsonl",
      "manifest.json",
      "signature",
      "public.pem",
    ].map((name) => path.join(directory, name));
    writeFileSync(paths[0], exportData.file);
    writeFileSync(paths[1], JSON.stringify(exportData.manifest));
    writeFileSync(paths[2], exportData.signature);
    writeFileSync(
      paths[3],
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    assert.equal(verifyFiles(paths), true);
    const cli = fileURLToPath(new URL("./verify-cli.js", import.meta.url));
    assert.equal(spawnSync(process.execPath, [cli, ...paths]).status, 0);
    writeFileSync(paths[0], "extra\n");
    assert.equal(verifyFiles(paths), false);
    assert.equal(spawnSync(process.execPath, [cli, ...paths]).status, 1);
    assert.equal(spawnSync(process.execPath, [cli]).status, 1);
    assert.throws(() => verifyFiles(paths.slice(1)), /expected/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
