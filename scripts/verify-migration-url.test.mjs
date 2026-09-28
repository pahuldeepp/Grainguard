import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const key = "INVENTORY_MIGRATION_URL";
for (const [name, value, expected] of [
  [
    "verified RDS TLS",
    "postgresql://owner:secret@db.example.test/greenguard?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem",
    0,
  ],
  [
    "TLS disabled",
    "postgresql://owner:secret@db.example.test/greenguard?sslmode=disable",
    1,
  ],
  [
    "wrong CA",
    "postgresql://owner:secret@db.example.test/greenguard?sslmode=verify-full&sslrootcert=%2Ftmp%2Fca.pem",
    1,
  ],
  [
    "missing database",
    "postgresql://owner:secret@db.example.test/?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem",
    1,
  ],
  ["missing URL", "", 1],
]) {
  test(name, () => {
    const result = spawnSync(
      process.execPath,
      [new URL("./verify-migration-url.mjs", import.meta.url).pathname, key],
      {
        env: { ...process.env, [key]: value },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, expected);
    assert.doesNotMatch(result.stderr, /secret/);
  });
}
