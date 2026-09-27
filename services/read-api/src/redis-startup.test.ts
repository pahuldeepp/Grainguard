import assert from "node:assert/strict";
import test from "node:test";
import {
  connectRedisBounded,
  DEFAULT_REDIS_STARTUP_WAIT_MS,
  redisStartupWaitMs,
} from "./redis-startup.js";

test("startup completes within the bound when Redis never connects", async () => {
  const started = Date.now();
  const failures: unknown[] = [];
  await connectRedisBounded(
    { connect: () => new Promise<void>(() => undefined) },
    50,
    (error) => failures.push(error),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 40 && elapsed < 1000, `elapsed ${elapsed}ms`);
  assert.deepEqual(failures, []);
});

test("startup returns as soon as Redis connects and reports failures", async () => {
  const started = Date.now();
  await connectRedisBounded({ connect: async () => undefined }, 60_000, () =>
    assert.fail("unexpected failure"),
  );
  const failures: unknown[] = [];
  const boom = new Error("refused");
  await connectRedisBounded(
    { connect: () => Promise.reject(boom) },
    60_000,
    (error) => failures.push(error),
  );
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(failures, [boom]);
});

test("READ_REDIS_STARTUP_WAIT_MS is optional and validated", () => {
  assert.equal(redisStartupWaitMs(undefined), DEFAULT_REDIS_STARTUP_WAIT_MS);
  assert.equal(redisStartupWaitMs(" "), 2000);
  assert.equal(redisStartupWaitMs("250"), 250);
  assert.equal(redisStartupWaitMs("0"), 0);
  assert.equal(redisStartupWaitMs("-1"), 2000);
  assert.equal(redisStartupWaitMs("soon"), 2000);
});
