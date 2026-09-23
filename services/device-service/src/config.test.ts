import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "./config.js";
test("requires the database URL without echoing any value", () => {
  assert.throws(() => readConfig({}), /INVENTORY_DATABASE_URL is required/);
});
test("applies local defaults", () => {
  assert.deepEqual(readConfig({ INVENTORY_DATABASE_URL: "postgres://x" }), {
    databaseUrl: "postgres://x",
    port: 3001,
    host: "127.0.0.1",
  });
});
test("honours PORT and HOST overrides", () => {
  assert.deepEqual(
    readConfig({
      INVENTORY_DATABASE_URL: "postgres://x",
      PORT: "4100",
      HOST: "0.0.0.0",
    }),
    { databaseUrl: "postgres://x", port: 4100, host: "0.0.0.0" },
  );
});
