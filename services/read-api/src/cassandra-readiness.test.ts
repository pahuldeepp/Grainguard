import assert from "node:assert/strict";
import test from "node:test";
import { createCassandraReadiness } from "./cassandra-readiness.js";

test("failed Cassandra startup retries on readiness and shares an in-flight attempt", async () => {
  let resolveAttempt: (() => void) | undefined;
  let rejectAttempt: ((error: Error) => void) | undefined;
  let calls = 0;
  let connected = false;
  const failures: unknown[] = [];
  const readiness = createCassandraReadiness(
    {
      connect: () => {
        calls++;
        return new Promise<void>((resolve, reject) => {
          resolveAttempt = () => {
            connected = true;
            resolve();
          };
          rejectAttempt = reject;
        });
      },
      getState: () => ({
        getConnectedHosts: () => (connected ? ["host"] : []),
      }),
    },
    (error) => failures.push(error),
  );
  readiness.ensureConnected();
  readiness.ensureConnected();
  assert.equal(calls, 1);
  assert.equal(readiness.connected(), false);
  rejectAttempt!(new Error("Cassandra unavailable"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures.length, 1);
  readiness.ensureConnected();
  assert.equal(calls, 2);
  resolveAttempt!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readiness.connected(), true);
  readiness.ensureConnected();
  assert.equal(calls, 2);
});
