import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryDrain } from "./delivery-drain.js";

test("shutdown waits for an in-flight delivery to settle before closing resources", async () => {
  const drain = new DeliveryDrain();
  let settle!: () => void;
  drain.track(
    new Promise<void>((resolve) => {
      settle = resolve;
    }),
  );
  drain.stopAccepting();
  let finished = false;
  const waiting = drain.wait(100).then(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  settle();
  await waiting;
  assert.equal(finished, true);
  assert.equal(drain.isAccepting, false);
  assert.throws(() => drain.track(Promise.resolve()), /after shutdown/);
});

test("shutdown fails within a bounded time if a delivery never settles", async () => {
  const drain = new DeliveryDrain();
  drain.track(new Promise<void>(() => {}));
  drain.stopAccepting();
  await assert.rejects(drain.wait(5), /timed out with 1 unsettled message/);
});

test("settlement failures are collected without unhandled rejections", async () => {
  const drain = new DeliveryDrain();
  drain.track(Promise.reject(new Error("channel ack failed")));
  drain.stopAccepting();
  await assert.rejects(drain.wait(100), /settlement failed/);
});
