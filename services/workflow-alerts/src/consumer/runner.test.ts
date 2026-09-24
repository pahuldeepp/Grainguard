import assert from "node:assert/strict";
import { test } from "node:test";
import type { HandleResult } from "./handler.js";
import {
  processRecord,
  runConsumer,
  type EventSource,
  type RunOptions,
  type SourceRecord,
} from "./runner.js";

const envelope = {
  event_id: "e1",
  event_type: "risk.assessed",
  tenant_id: "t1",
};
const record = (
  value = JSON.stringify(envelope),
  headers = { ...envelope },
): SourceRecord => ({
  value,
  headers,
  position: "p0/1",
});

function fakeSource(records: SourceRecord[] = []) {
  const log: string[] = [];
  const source: EventSource = {
    poll: async () => records.shift(),
    commit: async (r) => void log.push(`commit ${r.position}`),
    quarantine: async (r, errors) => void log.push(`quarantine ${errors[0]}`),
  };
  return { source, log };
}

const effect = { outcome: "applied" as const, eventIds: [] };
const options = (
  source: EventSource,
  handle: RunOptions["handle"],
  signal = new AbortController().signal,
): RunOptions => ({ source, handle, signal, backoffMs: 1, idleMs: 1 });

test("commits only after the effect is durable", async () => {
  const { source, log } = fakeSource();
  const handle = async (): Promise<HandleResult> => {
    log.push("effect");
    return { status: "applied", effect };
  };
  assert.equal(
    await processRecord(options(source, handle), record()),
    "applied",
  );
  assert.deepEqual(log, ["effect", "commit p0/1"]);
});

test("invalid, conflicting, malformed and header-mismatched records are quarantined before commit", async () => {
  for (const status of ["invalid", "conflict"] as const) {
    const { source, log } = fakeSource();
    await processRecord(
      options(source, async () => ({ status, errors: [status] })),
      record(),
    );
    assert.deepEqual(log, [`quarantine ${status}`, "commit p0/1"]);
  }
  const { source, log } = fakeSource();
  const never = async (): Promise<HandleResult> =>
    assert.fail("must not handle");
  assert.equal(
    await processRecord(options(source, never), record("{nope")),
    "quarantined",
  );
  await processRecord(
    options(source, never),
    record(undefined, { ...envelope, tenant_id: "t2" }),
  );
  assert.deepEqual(log, [
    "quarantine value is not JSON",
    "commit p0/1",
    "quarantine header tenant_id does not match the envelope",
    "commit p0/1",
  ]);
});

test("transient failures retry; exhausted retries stop without committing", async () => {
  const { source, log } = fakeSource();
  let calls = 0;
  const flaky = async (): Promise<HandleResult> => {
    if (++calls < 3) throw new Error("db down");
    return { status: "duplicate", effect };
  };
  assert.equal(
    await processRecord(options(source, flaky), record()),
    "duplicate",
  );
  assert.equal(calls, 3);
  const down = async (): Promise<HandleResult> => {
    throw new Error("db down");
  };
  await assert.rejects(
    processRecord({ ...options(source, down), maxAttempts: 2 }, record()),
    /db down/,
  );
  assert.deepEqual(log, ["commit p0/1"]);
});

test("a failed quarantine write does not commit the offset", async () => {
  const { source, log } = fakeSource();
  source.quarantine = async () => {
    throw new Error("quarantine unavailable");
  };
  await assert.rejects(
    processRecord(
      options(source, async () => ({ status: "invalid", errors: ["x"] })),
      record(),
    ),
    /quarantine unavailable/,
  );
  assert.deepEqual(log, []);
});

test("the loop drains records, idles, and stops on abort", async () => {
  const { source, log } = fakeSource([record(), record()]);
  const stop = new AbortController();
  let handled = 0;
  const handle = async (): Promise<HandleResult> => {
    if (++handled === 2) setTimeout(() => stop.abort(), 5);
    return { status: "applied", effect };
  };
  await runConsumer(options(source, handle, stop.signal));
  assert.equal(handled, 2);
  assert.equal(log.length, 2);
});
