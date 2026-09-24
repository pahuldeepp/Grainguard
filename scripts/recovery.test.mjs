import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWAL } from "./wal-check.mjs";
import { resetBindingFeed } from "./binding-feed-reset.mjs";
import { connectorConfig } from "./events-lib.mjs";

const capQuery = "pg_size_bytes";
const slotReserved = "reserved";

function walFixture(overrides = {}) {
  const messages = [];
  return {
    messages,
    env: {},
    log: {
      log: (line) => messages.push(line),
      error: (line) => messages.push(line),
    },
    query: (db, sql) =>
      sql.includes(capQuery)
        ? "1000"
        : JSON.stringify({
            slot: connectorConfig(db)["slot.name"],
            wal_status: slotReserved,
            retained_bytes: "1",
          }),
    ...overrides,
  };
}

test("WAL requires both configured slots, including a partially missing stack", () => {
  assert.equal(checkWAL(walFixture()), 0);
  for (const missing of ["inventory", "telemetry"]) {
    const fixture = walFixture();
    const original = fixture.query;
    fixture.query = (db, sql) =>
      db === missing && !sql.includes(capQuery) ? "" : original(db, sql);
    assert.equal(checkWAL(fixture), 1);
    assert.ok(
      fixture.messages.some(
        (line) =>
          line.includes(connectorConfig(missing)["slot.name"]) &&
          line.includes("missing"),
      ),
    );
  }
});

test("only the explicit empty-stack flag permits no slots", () => {
  for (const flag of [undefined, "0", "true", "1"]) {
    const fixture = walFixture({
      env: { WAL_ALLOW_EMPTY_STACK: flag },
      query: (_, sql) => (sql.includes(capQuery) ? "1000" : ""),
    });
    assert.equal(checkWAL(fixture), flag === "1" ? 0 : 1);
  }
  const fixture = walFixture({ env: { WAL_ALLOW_EMPTY_STACK: "1" } });
  const original = fixture.query;
  fixture.query = (db, sql) =>
    original(db, sql).replace(connectorConfig(db)["slot.name"], "unexpected");
  assert.equal(checkWAL(fixture), 1);
});

test("WAL retains configuration and retention failure checks", () => {
  for (const warn of ["bad", "0", "-1", "1000"]) {
    assert.throws(
      () => checkWAL(walFixture({ env: { WAL_WARN_BYTES: warn } })),
      /WAL_WARN_BYTES/,
    );
  }
  assert.equal(checkWAL(walFixture({ env: { WAL_WARN_BYTES: "10" } })), 0);
  assert.throws(
    () => checkWAL(walFixture({ query: () => "0" })),
    /bounded and positive/,
  );
  for (const slot of [
    { wal_status: "lost", retained_bytes: "1" },
    { wal_status: "unreserved", retained_bytes: "1" },
    { wal_status: slotReserved, retained_bytes: null },
    { wal_status: slotReserved, retained_bytes: "501" },
  ]) {
    assert.equal(
      checkWAL(
        walFixture({
          query: (db, sql) =>
            sql.includes(capQuery)
              ? "1000"
              : JSON.stringify({
                  slot: connectorConfig(db)["slot.name"],
                  ...slot,
                }),
        }),
      ),
      1,
    );
  }
});

test("checkpoint reset requires exact confirmation and targets telemetry only", () => {
  const calls = [];
  const execute = (...args) => calls.push(args);
  for (const args of [[], ["yes"], ["--yes", "--database=inventory"]]) {
    assert.throws(() => resetBindingFeed(args, execute), /--yes/);
  }
  assert.equal(calls.length, 0);
  resetBindingFeed(["--yes"], execute);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].at(-1), "greenguard_telemetry");
  assert.match(calls[0][1].input, /LOCK TABLE public.binding_feed_checkpoints/);
  assert.match(
    calls[0][1].input,
    /DELETE FROM public.binding_feed_checkpoints/,
  );
  assert.throws(
    () =>
      resetBindingFeed(["--yes"], () => {
        throw new Error("DB unavailable");
      }),
    /DB unavailable/,
  );
});
