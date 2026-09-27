import assert from "node:assert/strict";
import test from "node:test";
import { AckQueue } from "./ack-queue.js";
import type { AckQueueDeps } from "./ack-queue.js";
import { GraphqlError } from "./graphql.js";
import { IdentityChangedError, ReloginRequiredError } from "./session.js";
import type { Identity } from "./session.js";
import { FakeClock, MemoryStore } from "./support.test.js";

const tenantA: Identity = { tenantId: "tenant-a", subject: "u1" };
const tenantB: Identity = { tenantId: "tenant-b", subject: "u1" };

type Behaviour = (call: { id: string; key: string }) => void;

class FakeServer {
  readonly received: { id: string; key: string; identity: Identity }[] = [];
  readonly effects = new Map<string, number>();
  behaviour: Behaviour = () => undefined;
  async acknowledge(
    id: string,
    _version: string,
    key: string,
    identity: Identity,
  ) {
    this.received.push({ id, key, identity });
    this.behaviour({ id, key });
    // Idempotent on the key, like the BFF/alert API.
    if (!this.effects.has(key)) this.effects.set(key, 1);
    return {};
  }
}

function setup(overrides: Partial<AckQueueDeps> = {}) {
  const storage = new MemoryStore();
  const clock = new FakeClock();
  const server = new FakeServer();
  let counter = 0;
  const deps: AckQueueDeps = {
    storage,
    now: clock.now,
    newId: () => `key-${++counter}`,
    random: () => 0,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    maxAttempts: 3,
    ...overrides,
  };
  const make = () => new AckQueue(server, deps);
  return { storage, clock, server, queue: make(), make };
}

const fail =
  (status: number): Behaviour =>
  () => {
    throw new GraphqlError("boom", status);
  };

test("enqueue persists a stable key that survives restart", async () => {
  const s = setup();
  const entry = await s.queue.enqueue(tenantA, "alert-1", "3");
  const restarted = s.make();
  const [again] = await restarted.pending(tenantA);
  assert.equal(again.idempotencyKey, entry.idempotencyKey);
  assert.equal(again.alertId, "alert-1");
});

test("duplicate acknowledge of the same alert keeps one entry and one key", async () => {
  const s = setup();
  const one = await s.queue.enqueue(tenantA, "alert-1", "3");
  const two = await s.queue.enqueue(tenantA, "alert-1", "3");
  assert.equal(one.idempotencyKey, two.idempotencyKey);
  assert.equal((await s.queue.pending(tenantA)).length, 1);
});

test("drain replays in order with the original key and identity, then empties", async () => {
  const s = setup();
  for (const id of ["a", "b", "c"]) await s.queue.enqueue(tenantA, id, "1");
  const result = await s.queue.drain(tenantA);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.sent, ["key-1", "key-2", "key-3"]);
  assert.deepEqual(
    s.server.received.map((r) => r.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(s.server.received[0].identity, tenantA);
  assert.equal((await s.queue.pending(tenantA)).length, 0);
  assert.equal((await s.queue.drain(tenantA)).status, "empty");
});

test("crash between send and dequeue replays the same key without a second effect", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  const realSet = s.storage.setItem.bind(s.storage);
  const realRemove = s.storage.removeItem.bind(s.storage);
  const killed = async () => {
    throw new Error("process killed");
  };
  s.storage.setItem = killed;
  s.storage.removeItem = killed;
  await assert.rejects(s.queue.drain(tenantA), /process killed/);
  s.storage.setItem = realSet;
  s.storage.removeItem = realRemove;
  const restarted = s.make();
  assert.equal((await restarted.pending(tenantA)).length, 1);
  await restarted.drain(tenantA);
  assert.equal(s.server.received.length, 2);
  assert.equal(s.server.received[0].key, s.server.received[1].key);
  assert.equal(s.server.effects.size, 1);
  assert.equal((await restarted.pending(tenantA)).length, 0);
});

test("409 and 412 count as already acknowledged and dequeue", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  await s.queue.enqueue(tenantA, "b", "1");
  let calls = 0;
  s.server.behaviour = () => {
    calls += 1;
    throw new GraphqlError("conflict", calls === 1 ? 409 : 412);
  };
  const result = await s.queue.drain(tenantA);
  assert.deepEqual(result.alreadyAcknowledged, ["key-1", "key-2"]);
  assert.deepEqual(result.sent, []);
  assert.equal((await s.queue.pending(tenantA)).length, 0);
});

test("transient failure backs off, blocks later entries, then resumes in order", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  await s.queue.enqueue(tenantA, "b", "1");
  let failOnce = true;
  s.server.behaviour = () => {
    if (failOnce) {
      failOnce = false;
      throw new GraphqlError("down", 503);
    }
  };
  const first = await s.queue.drain(tenantA);
  assert.equal(first.status, "backoff");
  assert.equal(first.nextAttemptAt, s.clock.now() + 1000);
  assert.equal(s.server.received.length, 1);
  const early = await s.queue.drain(tenantA);
  assert.equal(early.status, "backoff");
  assert.equal(s.server.received.length, 1);
  s.clock.advance(1000);
  const done = await s.queue.drain(tenantA);
  assert.equal(done.status, "complete");
  assert.deepEqual(
    s.server.received.map((r) => r.id),
    ["a", "a", "b"],
  );
});

test("backoff doubles per attempt up to the cap and network errors are retried", async () => {
  const s = setup({ maxAttempts: 10 });
  await s.queue.enqueue(tenantA, "a", "1");
  s.server.behaviour = fail(0);
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await s.queue.drain(tenantA);
    delays.push((r.nextAttemptAt ?? 0) - s.clock.now());
    s.clock.advance(60_000);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000]);
});

test("retries are bounded: an exhausted entry is rejected and the queue moves on", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  await s.queue.enqueue(tenantA, "b", "1");
  s.server.behaviour = ({ id }) => {
    if (id === "a") throw new GraphqlError("down", 500);
  };
  await s.queue.drain(tenantA);
  s.clock.advance(60_000);
  await s.queue.drain(tenantA);
  s.clock.advance(60_000);
  const result = await s.queue.drain(tenantA);
  assert.deepEqual(result.rejected, ["key-1"]);
  assert.deepEqual(result.sent, ["key-2"]);
  const [left] = await s.queue.pending(tenantA);
  assert.equal(left.rejectedReason, "retries_exhausted");
  await s.queue.dismiss(tenantA, left.idempotencyKey);
  assert.equal((await s.queue.pending(tenantA)).length, 0);
});

test("a permanent 4xx rejects the entry without retrying and later entries still send", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  await s.queue.enqueue(tenantA, "b", "1");
  s.server.behaviour = ({ id }) => {
    if (id === "a") throw new GraphqlError("forbidden", 403);
  };
  const result = await s.queue.drain(tenantA);
  assert.deepEqual(result.rejected, ["key-1"]);
  assert.deepEqual(result.sent, ["key-2"]);
  assert.equal(s.server.received.filter((r) => r.id === "a").length, 1);
});

test("queued acknowledgements never replay under another tenant or user", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  assert.equal((await s.queue.pending(tenantB)).length, 0);
  assert.equal((await s.queue.drain(tenantB)).status, "empty");
  const otherUser = { tenantId: "tenant-a", subject: "u2" };
  assert.equal((await s.queue.drain(otherUser)).status, "empty");
  assert.equal(s.server.received.length, 0);
  assert.equal((await s.queue.pending(tenantA)).length, 1);
  await s.queue.enqueue(tenantB, "a", "1");
  const b = await s.queue.pending(tenantB);
  assert.notEqual(
    b[0].idempotencyKey,
    (await s.queue.pending(tenantA))[0].idempotencyKey,
  );
});

test("an identity change mid-replay stops the pass and keeps the entry", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  s.server.behaviour = () => {
    throw new IdentityChangedError();
  };
  const result = await s.queue.drain(tenantA);
  assert.equal(result.status, "identity-changed");
  assert.equal((await s.queue.pending(tenantA)).length, 1);
});

test("relogin required pauses the queue without spending an attempt", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  s.server.behaviour = () => {
    throw new ReloginRequiredError();
  };
  const paused = await s.queue.drain(tenantA);
  assert.equal(paused.status, "paused-relogin");
  const [entry] = await s.queue.pending(tenantA);
  assert.equal(entry.attempts, 0);
  s.server.behaviour = () => undefined;
  assert.equal((await s.queue.drain(tenantA)).status, "complete");
});

test("a 401 that survives the refresh also pauses for re-login", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  s.server.behaviour = fail(401);
  assert.equal((await s.queue.drain(tenantA)).status, "paused-relogin");
});

test("offline submissions queue without sending, then flush once online", async () => {
  let online = false;
  const s = setup({ isOnline: () => online });
  const offline = await s.queue.submit(tenantA, "a", "1");
  assert.equal(offline.status, "offline");
  assert.equal(s.server.received.length, 0);
  online = true;
  const reconnect = await s.queue.drain(tenantA);
  assert.equal(reconnect.status, "complete");
  assert.equal(s.server.received.length, 1);
  const again = await s.queue.submit(tenantA, "b", "1");
  assert.equal(again.status, "complete");
  assert.equal(s.server.received.length, 2);
});

test("overlapping drains share one pass and send each entry once", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  const [x, y] = await Promise.all([
    s.queue.drain(tenantA),
    s.queue.drain(tenantA),
  ]);
  assert.equal(x, y);
  assert.equal(s.server.received.length, 1);
});

test("unknown errors are treated as transient", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  s.server.behaviour = () => {
    throw new Error("weird");
  };
  assert.equal((await s.queue.drain(tenantA)).status, "backoff");
});

test("dismiss ignores unknown keys and only acts on the caller's scope", async () => {
  const s = setup();
  await s.queue.enqueue(tenantA, "a", "1");
  await s.queue.dismiss(tenantB, "key-1");
  await s.queue.dismiss(tenantA, "nope");
  assert.equal((await s.queue.pending(tenantA)).length, 1);
});
