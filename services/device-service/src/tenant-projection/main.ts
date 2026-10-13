import { closeOwnerDatabase } from "@greenguard/membership-client/owner-db";
import { createDb } from "../db/client.js";
import {
  serveTenantProjectorHealth,
  startTenantProjector,
  TenantProjectorHealth,
} from "./worker.js";

const url = process.env.INVENTORY_PROJECTOR_DIRECT_URL;
const brokers = process.env.KAFKA_BROKERS;
if ((!url && !process.env.SHARD_REGISTRY_FILE) || !brokers)
  throw new Error(
    "INVENTORY_PROJECTOR_DIRECT_URL and KAFKA_BROKERS are required",
  );
const db = createDb(url ?? "", 10, process.env, "inventory_projector");
const health = new TenantProjectorHealth();
const healthServer = serveTenantProjectorHealth(
  health,
  Number(process.env.INVENTORY_TENANT_PROJECTOR_HEALTH_PORT ?? "8096"),
);
const stop = await startTenantProjector(
  db,
  brokers.split(","),
  process.env.INVENTORY_TENANT_GROUP ?? "greenguard-inventory-tenant-v1",
  (error) => {
    console.error("inventory tenant projector failed", error);
    process.exit(1);
  },
  health,
);
const shutdown = () => {
  void stop()
    .finally(
      () =>
        new Promise<void>((resolve, reject) =>
          healthServer.close((error) => (error ? reject(error) : resolve())),
        ),
    )
    .finally(() =>
      closeOwnerDatabase(db, 5000, (client) => client.$disconnect()),
    );
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
