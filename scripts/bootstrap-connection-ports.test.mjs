import test from "node:test";
import assert from "node:assert/strict";
import { connectionPorts } from "./bootstrap-connection-ports.mjs";

test("bootstrap preserves isolated loopback direct and pool ports", () => {
  assert.deepEqual(
    connectionPorts(
      new Map([
        [
          "POSTGRES_ADMIN_URL",
          "postgresql://admin:secret@127.0.0.1:55433/postgres",
        ],
        [
          "INVENTORY_DATABASE_URL",
          "postgresql://app:secret@localhost:56433/greenguard_inventory",
        ],
      ]),
    ),
    { direct: 55433, pooled: 56433 },
  );
});

test("bootstrap defaults to the documented shared development ports", () => {
  assert.deepEqual(connectionPorts(new Map()), {
    direct: 55432,
    pooled: 56432,
  });
});

test("bootstrap refuses non-loopback or malformed existing database URLs", () => {
  for (const value of [
    "postgresql://admin:secret@db.example.com:55433/postgres",
    "not-a-url",
  ]) {
    assert.throws(
      () => connectionPorts(new Map([["POSTGRES_ADMIN_URL", value]])),
      /POSTGRES_ADMIN_URL/,
    );
  }
});
