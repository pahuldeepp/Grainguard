import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createClientCredentialsVerifier } from "@greenguard/tenant-auth/service-principals";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { outboxRowToEvent, validateEvent } from "@greenguard/contracts";
import { startApi } from "../testing/api.js";
import { adminQuery, appQuery, createTenant } from "../testing/fixtures.js";
import { withTenant } from "../db/tenant.js";
import {
  canonicalId,
  stableUuid,
  type ImportChange,
  type ImportEntity,
} from "./contract.js";

const EVENT_NAMESPACE = "a00f2290-bf1c-5eb9-b19a-54f3acb29355";
const SOURCE = `partner-${randomUUID()}`;
const GENERATION = "generation-1";
let api: Awaited<ReturnType<typeof startApi>>;
let issuer: Awaited<ReturnType<typeof createTestIssuer>>;
let lookupFails = false;
const tenants = new Set<string>();

before(async () => {
  issuer = await createTestIssuer();
  const verifier = createClientCredentialsVerifier({
    issuer: issuer.issuer,
    audience: issuer.audience,
    getKey: issuer.getKey,
    tenantClaim: "gg_tenant",
    lookup: async (_iss, clientId, hint) => {
      if (lookupFails) throw new Error("control plane unavailable");
      return clientId === "mysql-importer" && hint && tenants.has(hint)
        ? {
            tenant_id: hint,
            principal_id: "123e4567-e89b-42d3-a456-426614174000",
            scopes: ["inventory:import"],
          }
        : undefined;
    },
  });
  api = await startApi({ importVerifier: verifier, importSourceId: SOURCE });
});
after(() => api.close());

async function tenant() {
  const tenantId = randomUUID();
  await createTenant(api.db, tenantId, `import ${tenantId.slice(0, 8)}`);
  tenants.add(tenantId);
  return tenantId;
}
async function token(
  tenantId: string,
  scope = "inventory:import",
  options: Record<string, unknown> = {},
) {
  return issuer.sign({
    sub: "mysql-importer@clients",
    azp: "mysql-importer",
    gty: "client-credentials",
    scope,
    gg_tenant: tenantId,
    ...options,
  });
}
function change(
  tenantId: string,
  entity: ImportEntity,
  external: string,
  payload: Record<string, string | null>,
  offset: number,
  options: Partial<ImportChange> = {},
): ImportChange {
  const topic = `partner.inventory_${entity === "site" ? "sites" : entity === "bin" ? "bins" : "devices"}`;
  const source_coordinate = {
    connector_generation: GENERATION,
    topic,
    partition: 0,
    offset: String(offset),
    ...options.source_coordinate,
  };
  return {
    contract_version: 1,
    event_id: stableUuid(EVENT_NAMESPACE, [
      SOURCE,
      source_coordinate.connector_generation,
      source_coordinate.topic,
      source_coordinate.partition,
      Number(source_coordinate.offset),
    ]),
    source_id: SOURCE,
    source_coordinate,
    tenant_id: tenantId,
    entity_type: entity,
    external_id: external,
    entity_id: canonicalId(SOURCE, tenantId, entity, external),
    operation: "upsert",
    payload,
    payload_sha256: offset.toString(16).padStart(64, "0"),
    ...options,
  };
}
function site(
  tenantId: string,
  external: string,
  offset: number,
  name = "North",
) {
  return change(
    tenantId,
    "site",
    external,
    {
      site_id: canonicalId(SOURCE, tenantId, "site", external),
      name,
    },
    offset,
  );
}
function bin(
  tenantId: string,
  external: string,
  siteExternal: string,
  offset: number,
  name = "Bin 1",
) {
  return change(
    tenantId,
    "bin",
    external,
    {
      bin_id: canonicalId(SOURCE, tenantId, "bin", external),
      site_id: canonicalId(SOURCE, tenantId, "site", siteExternal),
      name,
    },
    offset,
  );
}
function device(
  tenantId: string,
  external: string,
  siteExternal: string,
  binExternal: string | null,
  offset: number,
  status = "active",
) {
  return change(
    tenantId,
    "device",
    external,
    {
      device_id: canonicalId(SOURCE, tenantId, "device", external),
      site_id: canonicalId(SOURCE, tenantId, "site", siteExternal),
      bin_id: binExternal
        ? canonicalId(SOURCE, tenantId, "bin", binExternal)
        : null,
      serial_number: `SN-${tenantId.slice(0, 8)}-${external}`,
      status,
    },
    offset,
  );
}
async function admit(
  input: ImportChange,
  jwt: string,
  headers: Record<string, string> = {},
) {
  return api.call("POST", "/v1/internal/inventory/imports", {
    token: jwt,
    headers,
    body: input,
  });
}
async function counts(tenantId: string, entityId: string) {
  const rows = await adminQuery<{ events: string; audits: string }>(
    `
    SELECT (SELECT count(*) FROM outbox_events WHERE tenant_id=$1 AND aggregate_id=$2) AS events,
           (SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND actor_type='service') AS audits`,
    [tenantId, entityId],
  );
  return { events: Number(rows[0]!.events), audits: Number(rows[0]!.audits) };
}

test("import route rejects absent, human, malformed, wrong issuer/audience/scope and lookup outage", async () => {
  const t = await tenant();
  const input = site(t, `auth-${randomUUID()}`, 1);
  const human = await api.token(t, ["admin"]);
  const invalid = [
    null,
    human,
    "not-a-jwt",
    await token(t, "read:telemetry"),
    await issuer.sign(
      {
        sub: "mysql-importer@clients",
        azp: "mysql-importer",
        gty: "client-credentials",
        scope: "inventory:import",
        gg_tenant: t,
      },
      { issuer: "https://wrong.test" },
    ),
    await issuer.sign(
      {
        sub: "mysql-importer@clients",
        azp: "mysql-importer",
        gty: "client-credentials",
        scope: "inventory:import",
        gg_tenant: t,
      },
      { audience: "wrong" },
    ),
    await issuer.sign({
      sub: "human",
      scope: "inventory:import",
      gg_tenant: t,
    }),
  ];
  for (const credential of invalid) {
    const response = await api.call("POST", "/v1/internal/inventory/imports", {
      token: credential,
      body: input,
    });
    assert.ok(
      response.status === 401 || response.status === 403,
      `${response.status} ${response.text}`,
    );
  }
  lookupFails = true;
  try {
    assert.equal((await admit(input, await token(t))).status, 503);
  } finally {
    lookupFails = false;
  }
  assert.equal(
    (await api.call("GET", "/v1/devices", { token: await token(t) })).status,
    401,
  );
});

test("tenant-bound admission, replay fence, conflict, rollback and canonical events", async () => {
  const a = await tenant();
  const b = await tenant();
  const jwtA = await token(a);
  const jwtB = await token(b);
  const s = site(a, `s-${randomUUID()}`, 1);
  const otherSource = "partner-unconfigured";
  const otherEntityId = canonicalId(otherSource, a, "site", s.external_id);
  const forgedSource = {
    ...s,
    source_id: otherSource,
    entity_id: otherEntityId,
    event_id: stableUuid(EVENT_NAMESPACE, [
      otherSource,
      s.source_coordinate.connector_generation,
      s.source_coordinate.topic,
      s.source_coordinate.partition,
      BigInt(s.source_coordinate.offset),
    ]),
    payload: { site_id: otherEntityId, name: "Unauthorized source" },
  };
  const rejected = await admit(forgedSource, jwtA);
  assert.equal(rejected.status, 400, rejected.text);
  assert.deepEqual(await counts(a, otherEntityId), { events: 0, audits: 0 });
  const original = await admit(s, jwtA);
  assert.equal(original.status, 201);
  assert.deepEqual(await counts(a, s.entity_id), { events: 1, audits: 1 });
  assert.deepEqual((await admit(s, jwtA)).json, original.json);
  assert.deepEqual(await counts(a, s.entity_id), { events: 1, audits: 1 });
  assert.equal(
    (await admit({ ...s, payload_sha256: "f".repeat(64) }, jwtA)).status,
    409,
  );
  assert.equal((await admit(s, jwtB)).status, 400);
  assert.equal((await admit(s, jwtA, { "x-tenant-id": b })).status, 400);
  assert.equal(
    (await admit({ ...s, unwanted: "yes" } as ImportChange, jwtA)).status,
    400,
  );
  const s2 = site(a, s.external_id, 2, "North updated");
  assert.equal((await admit(s2, jwtA)).status, 201);
  assert.deepEqual(await counts(a, s.entity_id), { events: 2, audits: 2 });
  const withoutTenant = await appQuery<{ n: string }>(
    "SELECT count(*) AS n FROM inventory_import_state",
  );
  assert.equal(withoutTenant[0]!.n, "0");
  const bVisible = await withTenant(api.db, b, (tx) =>
    tx.inventoryImportState.count({
      where: { tenantId: b, entityId: s.entity_id },
    }),
  );
  assert.equal(bVisible, 0);
  assert.equal((await admit(s, jwtA)).json?.outcome, "stale");
  assert.equal(
    (
      await admit(
        change(a, "site", s.external_id, s2.payload, 2, {
          source_coordinate: { ...s2.source_coordinate, partition: 1 },
        }),
        jwtA,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await admit(
        change(a, "site", s.external_id, s2.payload, 2, {
          source_coordinate: {
            ...s2.source_coordinate,
            connector_generation: "generation-2",
          },
        }),
        jwtA,
      )
    ).status,
    409,
  );
  assert.deepEqual(await counts(a, s.entity_id), { events: 2, audits: 2 });
  const badBin = bin(a, `bad-${randomUUID()}`, `missing-${randomUUID()}`, 3);
  assert.equal((await admit(badBin, jwtA)).status, 422);
  const state = await adminQuery<{ n: string }>(
    "SELECT count(*) AS n FROM inventory_import_state WHERE tenant_id=$1 AND entity_id=$2",
    [a, badBin.entity_id],
  );
  assert.equal(state[0]!.n, "0");
  assert.deepEqual(await counts(a, badBin.entity_id), { events: 0, audits: 0 });
  const validBin = bin(a, `b-${randomUUID()}`, s.external_id, 4);
  assert.equal((await admit(validBin, jwtA)).status, 201);
  assert.equal((await admit(site(a, "other-site", 5), jwtA)).status, 201);
  const relocated = bin(a, validBin.external_id, s.external_id, 6);
  relocated.payload.site_id = canonicalId(SOURCE, a, "site", "other-site");
  assert.equal((await admit(relocated, jwtA)).status, 409);
  assert.equal(
    (await admit({ ...site(a, s.external_id, 7), operation: "delete" }, jwtA))
      .status,
    400,
  );
  const cross = bin(b, `cross-${randomUUID()}`, s.external_id, 6);
  cross.payload.site_id = s.entity_id;
  assert.equal((await admit(cross, jwtB)).status, 422);
});

test("device import applies binding/status changes, soft delete and no duplicate effects", async () => {
  const t = await tenant();
  const jwt = await token(t);
  const siteExternal = `s-${randomUUID()}`;
  const binExternal = `b-${randomUUID()}`;
  assert.equal((await admit(site(t, siteExternal, 1), jwt)).status, 201);
  assert.equal(
    (await admit(bin(t, binExternal, siteExternal, 2), jwt)).status,
    201,
  );
  const unknownDelete = {
    ...device(t, "never-imported", siteExternal, binExternal, 20),
    operation: "delete",
  } as ImportChange;
  assert.equal((await admit(unknownDelete, jwt)).status, 409);
  const first = device(t, `d-${randomUUID()}`, siteExternal, binExternal, 3);
  assert.equal((await admit(first, jwt)).status, 201);
  assert.deepEqual(await counts(t, first.entity_id), { events: 1, audits: 1 });
  const updated = device(
    t,
    first.external_id,
    siteExternal,
    null,
    4,
    "disabled",
  );
  const response = await admit(updated, jwt);
  assert.equal(response.status, 201, response.text);
  assert.equal(response.json?.aggregateVersion, "3");
  assert.deepEqual(await counts(t, first.entity_id), { events: 3, audits: 3 });
  assert.deepEqual((await admit(updated, jwt)).json, response.json);
  assert.deepEqual(await counts(t, first.entity_id), { events: 3, audits: 3 });
  const removed = {
    ...device(t, first.external_id, siteExternal, null, 5),
    operation: "delete",
  } as ImportChange;
  assert.equal((await admit(removed, jwt)).status, 201);
  const rows = await adminQuery<{ status: string }>(
    "SELECT status FROM devices WHERE tenant_id=$1 AND device_id=$2",
    [t, first.entity_id],
  );
  assert.equal(rows[0]!.status, "deleted");
  assert.deepEqual(await counts(t, first.entity_id), { events: 4, audits: 4 });
  const events = await adminQuery<{
    event_id: string;
    tenant_id: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: string;
    event_type: string;
    schema_version: number;
    occurred_at: Date;
    correlation_id: string;
    causation_id: string;
    traceparent: string;
    payload: unknown;
  }>(
    "SELECT * FROM outbox_events WHERE tenant_id=$1 AND aggregate_id=$2 ORDER BY aggregate_version",
    [t, first.entity_id],
  );
  for (const event of events) {
    const checked = validateEvent(
      outboxRowToEvent({
        eventId: event.event_id,
        tenantId: event.tenant_id,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        aggregateVersion: BigInt(event.aggregate_version),
        eventType: event.event_type,
        schemaVersion: event.schema_version,
        occurredAt: event.occurred_at,
        correlationId: event.correlation_id,
        causationId: event.causation_id,
        traceparent: event.traceparent,
        payload: event.payload,
      }),
    );
    assert.equal(checked.ok, true, JSON.stringify(checked));
  }
});

test("imported devices obey the existing tenant device capacity and failed admission rolls back", async () => {
  const t = await tenant();
  const jwt = await token(t);
  const siteExternal = `capacity-${randomUUID()}`;
  assert.equal((await admit(site(t, siteExternal, 1), jwt)).status, 201);
  for (let offset = 2; offset <= 11; offset++) {
    const item = device(t, `capacity-${offset}`, siteExternal, null, offset);
    const response = await admit(item, jwt);
    assert.equal(response.status, 201, response.text);
  }
  const over = device(t, "capacity-over", siteExternal, null, 12);
  const response = await admit(over, jwt);
  assert.equal(response.status, 403, response.text);
  assert.equal(response.json?.code, "entitlement_exceeded");
  const state = await adminQuery<{ n: string }>(
    "SELECT count(*) AS n FROM inventory_import_state WHERE tenant_id=$1 AND entity_id=$2",
    [t, over.entity_id],
  );
  assert.equal(state[0]!.n, "0");
  assert.deepEqual(await counts(t, over.entity_id), { events: 0, audits: 0 });
});

test("import device moves and removals publish atomic cable layout snapshots", async () => {
  const owner = await tenant();
  const jwt = await token(owner);
  const siteExternal = `cable-site-${randomUUID()}`;
  const binExternal = `cable-bin-${randomUUID()}`;
  const movedBinExternal = `cable-moved-${randomUUID()}`;
  const deviceExternal = `cable-device-${randomUUID()}`;
  for (const change of [
    site(owner, siteExternal, 1),
    bin(owner, binExternal, siteExternal, 1),
    bin(owner, movedBinExternal, siteExternal, 2),
    device(owner, deviceExternal, siteExternal, binExternal, 1),
  ])
    assert.equal((await admit(change, jwt)).status, 201);
  const human = await api.token(owner, ["operator"]);
  const created = await api.call("POST", "/v1/cables", {
    token: human,
    headers: { "idempotency-key": randomUUID() },
    body: {
      deviceId: canonicalId(SOURCE, owner, "device", deviceExternal),
      binId: canonicalId(SOURCE, owner, "bin", binExternal),
      label: "Imported device cable",
      sensors: [{ label: "Upper", position: 1, depthM: null }],
    },
  });
  assert.equal(created.status, 201);
  const path = created.headers.get("location") as string;
  const sensorId = (created.json?.sensors as { sensorId: string }[])[0]
    .sensorId;
  assert.equal(
    (
      await admit(
        device(owner, deviceExternal, siteExternal, movedBinExternal, 2),
        jwt,
      )
    ).status,
    201,
  );
  const moved = await api.call("GET", path, { token: human });
  assert.equal(moved.json?.cableVersion, "2");
  assert.equal(
    moved.json?.binId,
    canonicalId(SOURCE, owner, "bin", movedBinExternal),
  );
  assert.equal(
    (moved.json?.sensors as { sensorId: string }[])[0].sensorId,
    sensorId,
  );
  const deletedChange = device(
    owner,
    deviceExternal,
    siteExternal,
    movedBinExternal,
    3,
    "deleted",
  );
  deletedChange.operation = "delete";
  assert.equal((await admit(deletedChange, jwt)).status, 201);
  const removed = await api.call("GET", path, { token: human });
  assert.equal(removed.json?.cableVersion, "3");
  assert.deepEqual(removed.json?.sensors, []);
  const snapshots = await adminQuery<{
    payload: { operation: string; sensors: { sensor_id: string }[] };
    version: string;
  }>(
    "SELECT payload, aggregate_version::text AS version FROM outbox_events WHERE tenant_id=$1 AND aggregate_type='cable' AND aggregate_id=$2 ORDER BY aggregate_version",
    [owner, created.json?.cableId],
  );
  assert.deepEqual(
    snapshots.map((s) => [s.version, s.payload.operation]),
    [
      ["1", "upsert"],
      ["2", "upsert"],
      ["3", "deleted"],
    ],
  );
  assert.equal(snapshots[0].payload.sensors[0].sensor_id, sensorId);
  assert.deepEqual(snapshots[2].payload.sensors, []);
});
