// Tenant-placement fixtures for live end-to-end scripts.
//
// Every tenant-owned table is behind an ownership row fence, so a fixture tenant
// must (1) have durable ownership bootstrapped in each database it touches,
// (2) be resolvable through a placement authority, and (3) reach each service via
// a private shard registry. This mirrors stage06-e2e without needing the four
// physical shard bundles: shard s1 is the central local database and s2-s4 are
// distinct loopback addresses that are never connected.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import pg from "pg";

const SHARDS = ["s1", "s2", "s3", "s4"];

function adminClient(database) {
  const url = new URL(process.env.POSTGRES_ADMIN_URL);
  url.pathname = `/greenguard_${database}`;
  return new pg.Client({ connectionString: url.toString() });
}

async function withAdmin(database, action) {
  const client = adminClient(database);
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

/** Shard incarnations from the control plane's registry, keyed by shard id. */
export async function controlIncarnations() {
  const rows = await withAdmin("control", (client) =>
    client
      .query(
        "SELECT shard_id,shard_incarnation::text AS incarnation,state FROM shard_registry ORDER BY shard_id",
      )
      .then((result) => result.rows),
  );
  const byId = Object.fromEntries(rows.map((row) => [row.shard_id, row]));
  // Only s1 (the central local database) must be active; s2-s4 just need an
  // incarnation so the registry loader accepts the file. They are never connected.
  for (const id of SHARDS) {
    if (!byId[id]) throw new Error(`local shard route ${id} is missing`);
  }
  if (byId.s1.state !== "active")
    throw new Error("local shard route s1 must be active");
  return Object.fromEntries(SHARDS.map((id) => [id, byId[id].incarnation]));
}

/** Prepare and activate durable ownership of each tenant on shard s1. */
export async function bootstrapTenantOwnership(
  tenants,
  databases,
  incarnations,
) {
  const shardId = "s1";
  const incarnation = incarnations[shardId];
  for (const tenant of tenants) {
    for (const database of databases) {
      await withAdmin(database, async (client) => {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL ROLE tenant_ownership_bootstrap");
          await client.query(
            "SELECT greenguard_internal.prepare_tenant_ownership($1::uuid,$2::text,$3::uuid,1)",
            [tenant, shardId, incarnation],
          );
          await client.query(
            "SELECT greenguard_internal.activate_tenant_ownership($1::uuid,$2::text,$3::uuid,1)",
            [tenant, shardId, incarnation],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw new Error(
            `ownership bootstrap ${database}/${tenant}: ${error.message}`,
            { cause: error },
          );
        }
      });
    }
  }
}

/**
 * Private registry for one service. Shard s1 is the service's direct database
 * URL; s2-s4 are distinct, never-connected loopback ports (the loaders
 * reject duplicate endpoints and non-loopback hosts without TLS).
 */
export function writeServiceRegistry({
  dir,
  service,
  database,
  directUrl,
  incarnations,
}) {
  const primary = new URL(directUrl);
  const shards = Object.fromEntries(
    SHARDS.map((id, index) => {
      const url = new URL(primary.toString());
      if (index > 0) url.port = String(Number(primary.port || 5432) + index);
      return [
        id,
        {
          incarnation: incarnations[id],
          primaryUrl: url.toString(),
          replicaUrls: [],
        },
      ];
    }),
  );
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${service}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      formatVersion: 1,
      service,
      database: `greenguard_${database}`,
      shards,
    }),
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return file;
}

/** Local placement authority: serves s1 placements for the registered tenants. */
export async function startPlacementAuthority(incarnations) {
  const token = randomBytes(32).toString("hex");
  const tenants = new Set();
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(404).end();
      return;
    }
    const tenant = req.url?.match(
      /^\/v1\/internal\/placements\/([0-9a-f-]{36})$/,
    )?.[1];
    if (!tenant || !tenants.has(tenant)) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(
        JSON.stringify({
          tenantId: tenant,
          shardId: "s1",
          shardIncarnation: incarnations.s1,
          placementEpoch: "1",
          state: "active",
          expiresAt: new Date(Date.now() + 1500).toISOString(),
        }),
      );
  });
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  return {
    token,
    url: `http://127.0.0.1:${server.address().port}`,
    add: (...ids) => ids.forEach((id) => tenants.add(id)),
    close: () => server.close(),
  };
}
