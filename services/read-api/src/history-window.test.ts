import assert from "node:assert/strict";
import { test } from "node:test";
import { readHistoryHotWindowMs } from "./history-window.js";

test("history hot window defaults to 24 hours and parses Go-style durations", () => {
  assert.equal(readHistoryHotWindowMs(undefined), 24 * 60 * 60_000);
  assert.equal(readHistoryHotWindowMs("36h"), 36 * 60 * 60_000);
  assert.equal(readHistoryHotWindowMs("1h30m"), 90 * 60_000);
});

test("history hot window rejects malformed and out-of-policy values", () => {
  for (const value of ["", "24days", "1m", "2161h", "-24h", "24h!", "24h30"]) {
    assert.throws(
      () => readHistoryHotWindowMs(value),
      /READ_HISTORY_HOT_WINDOW/,
    );
  }
});
