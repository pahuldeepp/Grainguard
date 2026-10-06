import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsumerLag } from "./lag.js";

test("consumer lag starts once, preserves its start while behind, and clears on catch-up", () => {
  const lag = new ConsumerLag();
  assert.equal(lag.lagMs(100), 0);

  lag.markBehind(100);
  assert.equal(lag.lagMs(250), 150);

  lag.markBehind(200);
  assert.equal(lag.lagMs(300), 200);

  lag.markCaughtUp();
  assert.equal(lag.lagMs(400), 0);

  lag.markBehind(500);
  assert.equal(lag.lagMs(450), 0, "clock skew must not produce negative lag");
  assert.equal(lag.lagMs(550), 50);
});
