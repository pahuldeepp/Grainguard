import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { handleRiskEvent } from "../consumer/handler.js";
import type { Db } from "../db/client.js";
import { LockTimeoutError, withTenant } from "../db/tenant.js";
import {
  adminQuery,
  newStream,
  outboxFor,
  pooledDb,
  riskEvent,
} from "../testing/fixtures.js";
import {
  AlertNotFoundError,
  IdempotencyConflictError,
  InvalidStateError,
  VersionConflictError,
} from "./errors.js";
import {
  acknowledge,
  escalateIfStillUnacknowledged,
  type CommandContext,
} from "./lifecycle.js";

let db: Db;
before(() => {
  db = pooledDb(8);
});
after(() => db.$disconnect());

const LATER = new Date(Date.now() + 3600_000);

async function openAlert() {
  const s = newStream();
  const result = await handleRiskEvent(db, riskEvent(s, 65));
  assert.equal(result.status, "applied");
  const episodeId = (result as { effect: { episodeId: string } }).effect
    .episodeId;
  return { tenantId: s.tenantId, episodeId, stream: s };
}

const ctx = (tenantId: string, key = randomUUID()): CommandContext => ({
  tenantId,
  actorId: "operator-1",
  correlationId: randomUUID(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  idempotencyKey: key,
});

const lifecycleTypes = async (tenantId: string) =>
  (await outboxFor(tenantId)).map((r) => r["event_type"]);

const transitions = (tenantId: string) =>
  adminQuery<{ transition_type: string; event_id: string | null }>(
    "SELECT transition_type, event_id FROM alert_transitions WHERE tenant_id = $1 ORDER BY occurred_at, episode_version",
    [tenantId],
  );

describe("acknowledge", () => {
  test("transitions once, writes audit and alert.acknowledged", async () => {
    const a = await openAlert();
    const result = await acknowledge(db, ctx(a.tenantId), a.episodeId, 1n);
    assert.deepEqual(
      { state: result.state, version: result.version },
      { state: "acknowledged", version: "2" },
    );
    assert.deepEqual(await lifecycleTypes(a.tenantId), [
      "alert.opened",
      "alert.acknowledged",
    ]);
    const [row] = await adminQuery<{ acknowledged_by: string }>(
      "SELECT acknowledged_by FROM alert_episodes WHERE episode_id = $1",
      [a.episodeId],
    );
    assert.equal(row.acknowledged_by, "operator-1");
    // A second command with a fresh key sees the state change: 409, not a second effect.
    await assert.rejects(
      acknowledge(db, ctx(a.tenantId), a.episodeId, 2n),
      InvalidStateError,
    );
  });

  test("a retried Idempotency-Key returns the original outcome; reuse for another request conflicts", async () => {
    const a = await openAlert();
    const command = ctx(a.tenantId);
    const first = await acknowledge(db, command, a.episodeId, 1n);
    // Retry after a client timeout: same answer, no second transition.
    assert.deepEqual(await acknowledge(db, command, a.episodeId, 1n), first);
    assert.equal((await transitions(a.tenantId)).length, 2);
    await assert.rejects(
      acknowledge(db, command, a.episodeId, 5n),
      IdempotencyConflictError,
    );
    const [receipt] = await adminQuery<{ command_id: string }>(
      "SELECT command_id FROM command_receipts WHERE tenant_id = $1",
      [a.tenantId],
    );
    const [transition] = await adminQuery<{ cause_id: string }>(
      "SELECT cause_id FROM alert_transitions WHERE tenant_id = $1 AND transition_type = 'acknowledged'",
      [a.tenantId],
    );
    const [event] = await adminQuery<{ causation_id: string }>(
      "SELECT causation_id FROM outbox_events WHERE tenant_id = $1 AND event_type = 'alert.acknowledged'",
      [a.tenantId],
    );
    assert.equal(receipt.command_id, transition.cause_id);
    assert.equal(receipt.command_id, event.causation_id);
    assert.notEqual(receipt.command_id, first.eventId);
    // The same client key belongs to the principal that created the receipt.
    await assert.rejects(
      acknowledge(db, { ...command, actorId: "operator-2" }, a.episodeId, 1n),
      VersionConflictError,
    );
  });

  test("stale If-Match version and unknown alert are rejected", async () => {
    const a = await openAlert();
    await assert.rejects(
      acknowledge(db, ctx(a.tenantId), a.episodeId, 7n),
      (e: unknown) =>
        e instanceof VersionConflictError && e.currentVersion === 1n,
    );
    await assert.rejects(
      acknowledge(db, ctx(a.tenantId), randomUUID(), 1n),
      AlertNotFoundError,
    );
  });
});

describe("acknowledge versus escalation", () => {
  test("ack first: the later escalation is suppressed with a no-op receipt", async () => {
    const a = await openAlert();
    await acknowledge(db, ctx(a.tenantId), a.episodeId, 1n);
    const outcome = await escalateIfStillUnacknowledged(db, a, LATER);
    assert.equal(outcome.outcome, "suppressed");
    // Repeated sweeps do not multiply receipts.
    await escalateIfStillUnacknowledged(db, a, LATER);
    assert.deepEqual(await lifecycleTypes(a.tenantId), [
      "alert.opened",
      "alert.acknowledged",
    ]);
    const kinds = (await transitions(a.tenantId)).map((t) => [
      t.transition_type,
      t.event_id === null,
    ]);
    assert.deepEqual(kinds, [
      ["opened", false],
      ["acknowledged", false],
      ["escalation_suppressed", true],
    ]);
  });

  test("escalation first: an acknowledge with the old version gets 412, then succeeds on the new one", async () => {
    const a = await openAlert();
    const escalated = await escalateIfStillUnacknowledged(db, a, LATER);
    assert.equal(escalated.outcome, "escalated");
    await assert.rejects(
      acknowledge(db, ctx(a.tenantId), a.episodeId, 1n),
      VersionConflictError,
    );
    assert.equal(
      (await escalateIfStillUnacknowledged(db, a, LATER)).outcome,
      "suppressed",
    );
    await acknowledge(db, ctx(a.tenantId), a.episodeId, 2n);
    assert.deepEqual(await lifecycleTypes(a.tenantId), [
      "alert.opened",
      "alert.escalated",
      "alert.acknowledged",
    ]);
  });

  test("not yet due: no escalation, no receipt", async () => {
    const a = await openAlert();
    assert.equal(
      (await escalateIfStillUnacknowledged(db, a, new Date(0))).outcome,
      "not_due",
    );
    assert.equal((await transitions(a.tenantId)).length, 1);
    await assert.rejects(
      escalateIfStillUnacknowledged(db, { ...a, episodeId: randomUUID() }),
      AlertNotFoundError,
    );
  });

  test("concurrent race: exactly one of ack or escalation takes effect", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await openAlert();
      const [ack, esc] = await Promise.allSettled([
        acknowledge(db, ctx(a.tenantId), a.episodeId, 1n),
        escalateIfStillUnacknowledged(db, a, LATER),
      ]);
      const ackWon = ack.status === "fulfilled";
      const escWon =
        esc.status === "fulfilled" && esc.value.outcome === "escalated";
      assert.notEqual(ackWon, escWon, `round ${round}`);
      if (!ackWon)
        assert.ok(
          ack.status === "rejected" &&
            ack.reason instanceof VersionConflictError,
        );
      const events = await lifecycleTypes(a.tenantId);
      assert.equal(events.length, 2, JSON.stringify(events));
    }
  });

  test("a held row lock makes a racing command fail fast instead of waiting forever", async () => {
    const a = await openAlert();
    let release = () => undefined as void;
    const held = new Promise<void>((r) => (release = r));
    const holder = withTenant(db, a.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM alert_episodes WHERE episode_id = ${a.episodeId}::uuid FOR UPDATE`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(
      acknowledge(db, ctx(a.tenantId), a.episodeId, 1n),
      LockTimeoutError,
    );
    release();
    await holder;
  });
});
