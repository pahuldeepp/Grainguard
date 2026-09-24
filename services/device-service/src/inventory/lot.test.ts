import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Db } from "../db/client.js";
import {
  appQuery,
  adminQuery,
  context,
  pooledDb,
  seedTenant,
} from "../testing/fixtures.js";
import {
  IdempotencyConflictError,
  InvalidInputError,
  InvalidReferenceError,
} from "./errors.js";
import { grainLotAt, placeGrainLot } from "./repository.js";

let db: Db;
before(() => {
  db = pooledDb(6);
});
after(() => db.$disconnect());

test("wheat-to-canola placement preserves the observed-time batch and one outbox effect per version", async () => {
  const tenant = await seedTenant(db);
  const other = await seedTenant(db);
  const wheatAt = "2026-09-20T08:00:00.000Z";
  const canolaAt = "2026-09-21T08:00:00.000Z";
  const command = context(tenant.tenantId);
  const wheat = await placeGrainLot(db, command, {
    binId: tenant.binId,
    lotId: randomUUID(),
    grainType: "wheat",
    variety: "spring",
    effectiveFrom: wheatAt,
  });
  const retry = await placeGrainLot(db, command, {
    binId: tenant.binId,
    lotId: wheat.lotId,
    grainType: "wheat",
    variety: "spring",
    effectiveFrom: wheatAt,
  });
  assert.deepEqual(retry, wheat);
  await assert.rejects(
    placeGrainLot(db, command, {
      binId: tenant.binId,
      lotId: randomUUID(),
      grainType: "wheat",
      variety: "spring",
      effectiveFrom: wheatAt,
    }),
    IdempotencyConflictError,
  );
  await assert.rejects(
    placeGrainLot(db, command, {
      binId: tenant.binId,
      lotId: randomUUID(),
      grainType: "canola",
      effectiveFrom: wheatAt,
    }),
    IdempotencyConflictError,
  );
  const canola = await placeGrainLot(db, context(tenant.tenantId), {
    binId: tenant.binId,
    lotId: randomUUID(),
    grainType: "canola",
    effectiveFrom: canolaAt,
  });
  assert.equal(canola.occupancyVersion, "2");
  const before = await grainLotAt(
    db,
    tenant.tenantId,
    tenant.binId,
    new Date("2026-09-21T07:59:59.999Z"),
  );
  const after = await grainLotAt(
    db,
    tenant.tenantId,
    tenant.binId,
    new Date(canolaAt),
  );
  assert.equal(before?.lotId, wheat.lotId);
  assert.equal(before?.grainType, "wheat");
  assert.equal(before?.effectiveTo, canolaAt);
  assert.equal(after?.lotId, canola.lotId);
  assert.equal(after?.grainType, "canola");
  assert.equal(
    await grainLotAt(
      db,
      tenant.tenantId,
      tenant.binId,
      new Date("2026-09-20T07:59:59.999Z"),
    ),
    null,
  );
  assert.equal(
    await grainLotAt(db, other.tenantId, tenant.binId, new Date(canolaAt)),
    null,
  );
  const rows = await adminQuery<{
    aggregate_version: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT aggregate_version::text, payload FROM outbox_events
      WHERE tenant_id=$1 AND aggregate_type='bin_occupancy' AND aggregate_id=$2
      ORDER BY aggregate_version`,
    [tenant.tenantId, tenant.binId],
  );
  assert.deepEqual(
    rows.map((row) => row.aggregate_version),
    ["1", "2"],
  );
  assert.equal(rows[0].payload.lot_id, wheat.lotId);
  assert.equal(rows[1].payload.previous_lot_id, wheat.lotId);
  assert.equal(rows[1].payload.effective_from, canolaAt);
  const [counts] = await adminQuery<{
    lots: string;
    occupancy: string;
    events: string;
    audits: string;
    receipts: string;
  }>(
    `SELECT
       (SELECT count(*) FROM grain_lots WHERE tenant_id=$1) AS lots,
       (SELECT count(*) FROM bin_occupancies WHERE tenant_id=$1) AS occupancy,
       (SELECT count(*) FROM outbox_events WHERE tenant_id=$1 AND aggregate_type='bin_occupancy') AS events,
       (SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='lot.place') AS audits,
       (SELECT count(*) FROM command_receipts WHERE tenant_id=$1 AND command_type='lot.place') AS receipts`,
    [tenant.tenantId],
  );
  assert.deepEqual(counts, {
    lots: "2",
    occupancy: "2",
    events: "2",
    audits: "2",
    receipts: "2",
  });
});

test("invalid or cross-tenant placement leaves no grain or event effects", async () => {
  const tenant = await seedTenant(db);
  const other = await seedTenant(db);
  const firstAt = "2026-09-20T08:00:00.000Z";
  await placeGrainLot(db, context(tenant.tenantId), {
    binId: tenant.binId,
    lotId: randomUUID(),
    grainType: "wheat",
    effectiveFrom: firstAt,
  });
  await assert.rejects(
    placeGrainLot(db, context(tenant.tenantId), {
      binId: tenant.binId,
      lotId: randomUUID(),
      grainType: "canola",
      effectiveFrom: firstAt,
    }),
    InvalidInputError,
  );
  await assert.rejects(
    placeGrainLot(db, context(tenant.tenantId), {
      binId: tenant.binId,
      lotId: randomUUID(),
      grainType: "canola",
      effectiveFrom: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
    InvalidInputError,
  );
  await assert.rejects(
    placeGrainLot(db, context(other.tenantId), {
      binId: tenant.binId,
      lotId: randomUUID(),
      grainType: "canola",
      effectiveFrom: "2026-09-21T08:00:00.000Z",
    }),
    InvalidReferenceError,
  );
  const [row] = await adminQuery<{ n: string }>(
    "SELECT count(*) AS n FROM bin_occupancies WHERE tenant_id=$1 AND bin_id=$2",
    [tenant.tenantId, tenant.binId],
  );
  assert.equal(row.n, "1");
  for (const table of ["grain_lots", "bin_occupancies"]) {
    const [hidden] = await appQuery<{ n: string }>(
      `SELECT count(*) AS n FROM ${table}`,
    );
    assert.equal(hidden.n, "0");
  }
});
