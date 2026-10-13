import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { outboxRowToEvent, validateEvent } from "@greenguard/contracts";
import type { Db } from "../db/client.js";
import {
  adminQuery,
  calibratedRiskEventV2,
  newStream,
  invalidationEvent,
  outboxFor,
  pooledDb,
  riskEvent,
  uncalibratedRiskEventV2,
} from "../testing/fixtures.js";
import { deterministicId } from "../alerts/ids.js";
import { handleRiskEvent, type HandleResult } from "./handler.js";

let db: Db;
before(() => {
  db = pooledDb(8);
});
after(() => db.$disconnect());

const applied = (r: HandleResult) => {
  assert.ok(r.status === "applied" || r.status === "duplicate", r.status);
  return r.effect;
};

const episodes = (tenantId: string) =>
  adminQuery<{
    episode_id: string;
    state: string;
    version: string;
    score: number;
  }>(
    "SELECT episode_id, state, version::text, score FROM alert_episodes WHERE tenant_id = $1 ORDER BY opened_at",
    [tenantId],
  );

const count = async (table: string, tenantId: string) =>
  Number(
    (
      await adminQuery<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`,
        [tenantId],
      )
    )[0].n,
  );

describe("risk.assessed consumer", () => {
  test("v2 opens alerts and orders by the envelope stream sequence", async () => {
    const s = newStream();
    const event = calibratedRiskEventV2(s, 70);
    const result = await handleRiskEvent(db, event);
    assert.equal(result.status, "applied");
    if (result.status === "applied")
      assert.equal(result.effect.outcome, "applied");
    assert.equal((await episodes(s.tenantId))[0].score, 70);
    const staleV1 = riskEvent(s, 90, { version: 2 });
    const stale = await handleRiskEvent(db, staleV1);
    assert.equal(stale.status, "applied");
    if (stale.status === "applied") assert.equal(stale.effect.outcome, "stale");
  });

  test("v2 uses envelope stream sequence and uncalibrated policy cannot open alerts", async () => {
    const s = newStream();
    const event = uncalibratedRiskEventV2(s);
    const result = await handleRiskEvent(db, event);
    assert.equal(result.status, "applied");
    if (result.status === "applied")
      assert.equal(result.effect.outcome, "no_change");
    assert.equal((await episodes(s.tenantId)).length, 0);
    assert.equal(await count("outbox_events", s.tenantId), 0);
  });

  test("invalidation resolves only the causally current alert and is replay-safe", async () => {
    const s = newStream();
    const assessed = riskEvent(s, 75);
    assert.equal(
      applied(await handleRiskEvent(db, assessed)).outcome,
      "applied",
    );
    const invalidation = invalidationEvent(s, assessed);
    assert.equal(
      applied(await handleRiskEvent(db, invalidation)).outcome,
      "applied",
    );
    assert.equal((await episodes(s.tenantId))[0].state, "resolved");
    assert.equal((await handleRiskEvent(db, invalidation)).status, "duplicate");
    assert.equal((await outboxFor(s.tenantId)).length, 2);
    assert.equal(
      applied(await handleRiskEvent(db, riskEvent(s, 80, { version: 1 })))
        .outcome,
      "stale",
    );
  });

  test("invalidation cannot resolve a newer assessment or another tenant's alert", async () => {
    const a = newStream();
    const first = riskEvent(a, 70);
    await handleRiskEvent(db, first);
    await handleRiskEvent(db, riskEvent(a, 90));
    assert.equal(
      applied(await handleRiskEvent(db, invalidationEvent(a, first))).outcome,
      "no_change",
    );
    assert.equal((await episodes(a.tenantId))[0].state, "open");
    const b = newStream();
    const cross = invalidationEvent(b, {
      ...first,
      aggregate_id: b.deviceId,
      tenant_id: b.tenantId,
      payload: { ...first.payload, device_id: b.deviceId, bin_id: b.binId },
    });
    assert.equal(
      applied(await handleRiskEvent(db, cross)).outcome,
      "no_change",
    );
    assert.equal((await episodes(a.tenantId))[0].state, "open");
  });
  test("hysteresis: opens at 40, updates, holds above 25, resolves below 25", async () => {
    const s = newStream();
    assert.equal(
      applied(await handleRiskEvent(db, riskEvent(s, 30))).outcome,
      "no_change",
    );
    const opened = applied(await handleRiskEvent(db, riskEvent(s, 55)));
    assert.equal(opened.outcome, "applied");
    assert.equal(
      applied(await handleRiskEvent(db, riskEvent(s, 82))).outcome,
      "applied",
    );
    assert.equal(
      applied(await handleRiskEvent(db, riskEvent(s, 30))).outcome,
      "applied",
    );
    assert.equal(
      applied(await handleRiskEvent(db, riskEvent(s, 30))).outcome,
      "no_change",
    );
    assert.equal(
      applied(await handleRiskEvent(db, riskEvent(s, null))).outcome,
      "no_change",
    );
    assert.equal(
      applied(await handleRiskEvent(db, riskEvent(s, 10))).outcome,
      "applied",
    );
    const [episode] = await episodes(s.tenantId);
    assert.deepEqual(
      { state: episode.state, version: episode.version, score: episode.score },
      { state: "resolved", version: "4", score: 10 },
    );
    const types = (await outboxFor(s.tenantId)).map((r) => r["event_type"]);
    assert.deepEqual(types, [
      "alert.opened",
      "alert.updated",
      "alert.updated",
      "alert.resolved",
    ]);
    // A new crossing after resolution opens a second episode in a new window.
    applied(await handleRiskEvent(db, riskEvent(s, 60)));
    assert.equal((await episodes(s.tenantId)).length, 2);
  });

  test("every outbox row is a valid alert lifecycle event and matches its audit row", async () => {
    const s = newStream();
    for (const score of [45, 90, 5])
      await handleRiskEvent(db, riskEvent(s, score));
    const rows = await outboxFor(s.tenantId);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const event = outboxRowToEvent({
        eventId: row["event_id"] as string,
        tenantId: row["tenant_id"] as string,
        aggregateType: row["aggregate_type"] as string,
        aggregateId: row["aggregate_id"] as string,
        aggregateVersion: BigInt(row["aggregate_version"] as string),
        eventType: row["event_type"] as string,
        schemaVersion: row["schema_version"] as number,
        occurredAt: row["occurred_at"] as Date,
        correlationId: row["correlation_id"] as string,
        causationId: row["causation_id"] as string,
        traceparent: row["traceparent"] as string,
        payload: row["payload"],
      });
      const result = validateEvent(event);
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    assert.equal(await count("alert_transitions", s.tenantId), 3);
  });

  test("duplicate delivery is a no-op that returns the original effect", async () => {
    const s = newStream();
    const event = riskEvent(s, 70);
    const first = await handleRiskEvent(db, event);
    const again = await handleRiskEvent(db, JSON.parse(JSON.stringify(event)));
    assert.equal(again.status, "duplicate");
    assert.deepEqual(applied(again), applied(first));
    assert.equal(await count("outbox_events", s.tenantId), 1);
    assert.equal(await count("consumer_inbox", s.tenantId), 1);
  });

  test("the same event_id with different content is a conflict and changes nothing", async () => {
    const s = newStream();
    const event = riskEvent(s, 70);
    await handleRiskEvent(db, event);
    const tampered = {
      ...event,
      payload: { ...event.payload, score: 99, severity: "critical" },
    };
    const result = await handleRiskEvent(db, tampered);
    assert.equal(result.status, "conflict");
    assert.equal((await episodes(s.tenantId))[0].score, 70);
    assert.equal(await count("outbox_events", s.tenantId), 1);
  });

  test("invalid or foreign events are rejected before any write", async () => {
    const s = newStream();
    const bad = await handleRiskEvent(db, {
      ...riskEvent(s, 50),
      tenant_id: "x",
    });
    assert.equal(bad.status, "invalid");
    const other = await handleRiskEvent(db, {
      event_type: "alert.opened",
      schema_version: 1,
    });
    assert.equal(other.status, "invalid");
    const registered = JSON.parse(JSON.stringify(riskEvent(s, 50))) as Record<
      string,
      unknown
    >;
    registered["event_type"] = "device.registered";
    assert.equal((await handleRiskEvent(db, registered)).status, "invalid");
  });

  test("stale or reordered assessments cannot regress an episode", async () => {
    const s = newStream();
    const early = riskEvent(s, 90); // version 1
    const late = riskEvent(s, 50); // version 2
    applied(await handleRiskEvent(db, late));
    assert.equal(applied(await handleRiskEvent(db, early)).outcome, "stale");
    assert.equal(
      applied(await handleRiskEvent(db, riskEvent(s, 10, { version: 2 })))
        .outcome,
      "stale",
    );
    const [episode] = await episodes(s.tenantId);
    assert.deepEqual(
      [episode.state, episode.version, episode.score],
      ["open", "1", 50],
    );
  });

  test("a crash before COMMIT leaves no inbox, episode, transition or outbox row", async () => {
    const s = newStream();
    const event = riskEvent(s, 80);
    await assert.rejects(
      handleRiskEvent(db, event, {
        beforeCommit: () => {
          throw new Error("injected crash");
        },
      }),
      /injected crash/,
    );
    for (const table of [
      "consumer_inbox",
      "alert_episodes",
      "alert_transitions",
      "outbox_events",
      "risk_stream_positions",
    ])
      assert.equal(await count(table, s.tenantId), 0, table);
    // Redelivery after the crash applies the full effect exactly once.
    assert.equal(applied(await handleRiskEvent(db, event)).outcome, "applied");
    assert.equal(await count("outbox_events", s.tenantId), 1);
  });

  test("event IDs derive from (tenant, episode, version, type) and survive redelivery", async () => {
    const s = newStream();
    const events = [riskEvent(s, 50), riskEvent(s, 75), riskEvent(s, 5)];
    for (const e of events) await handleRiskEvent(db, e);
    const rows = await outboxFor(s.tenantId);
    const expected = rows.map((r) =>
      deterministicId(
        s.tenantId,
        r["aggregate_id"] as string,
        String(r["aggregate_version"]),
        (r["event_type"] as string).slice("alert.".length),
      ),
    );
    assert.deepEqual(
      rows.map((r) => r["event_id"]),
      expected,
    );
    // A full replay of the retained source stream (CDC snapshot, consumer reset).
    for (const e of events) await handleRiskEvent(db, e);
    assert.deepEqual(
      (await outboxFor(s.tenantId)).map((r) => r["event_id"]),
      expected,
    );
  });

  test("concurrent scores for one bin create exactly one episode", async () => {
    const tenantId = randomUUID();
    const binId = randomUUID();
    const streams = Array.from({ length: 8 }, () => ({
      ...newStream(tenantId),
      binId,
    }));
    const results = await Promise.all(
      streams.map((s) => handleRiskEvent(db, riskEvent(s, 60))),
    );
    assert.equal(results.filter((r) => r.status === "applied").length, 8);
    assert.equal((await episodes(tenantId)).length, 1);
    assert.equal(await count("outbox_events", tenantId), 1);
  });
});
