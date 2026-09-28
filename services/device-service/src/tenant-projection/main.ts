import { closeOwnerDatabase } from "@greenguard/membership-client/owner-db";
import { createDb } from "../db/client.js";
import { startTenantProjector } from "./worker.js";

const url = process.env.INVENTORY_PROJECTOR_DIRECT_URL;
const brokers = process.env.KAFKA_BROKERS;
if ((!url && !process.env.SHARD_REGISTRY_FILE) || !brokers)
  throw new Error(
    "INVENTORY_PROJECTOR_DIRECT_URL and KAFKA_BROKERS are required",
  );
const db = createDb(url ?? "", 10, process.env, "inventory_projector");
const stop = await startTenantProjector(
  db,
  brokers.split(","),
  process.env.INVENTORY_TENANT_GROUP ?? "greenguard-inventory-tenant-v1",
  (error) => {
    console.error("inventory tenant projector failed", error);
    process.exit(1);
  },
);
const shutdown = () => {
  void stop().finally(() =>
    closeOwnerDatabase(db, 5000, (client) => client.$disconnect()),
  );
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
