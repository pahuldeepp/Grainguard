import { createDb } from "../db/client.js";
import { startTenantProjector } from "./worker.js";

const url = process.env.INVENTORY_PROJECTOR_DIRECT_URL;
const brokers = process.env.KAFKA_BROKERS;
if (!url || !brokers)
  throw new Error(
    "INVENTORY_PROJECTOR_DIRECT_URL and KAFKA_BROKERS are required",
  );
const db = createDb(url);
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
  void stop().finally(() => db.$disconnect());
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
