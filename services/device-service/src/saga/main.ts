import { createDb } from "../db/client.js";
import { rejectTenantList, startInventorySagaWorker } from "./worker.js";

async function main() {
  const url = process.env.INVENTORY_DATABASE_URL;
  const brokerList = process.env.KAFKA_BROKERS;
  if (!url || !brokerList)
    throw new Error("INVENTORY_DATABASE_URL and KAFKA_BROKERS are required");
  rejectTenantList(process.env);
  const db = createDb(url);
  const stop = await startInventorySagaWorker(
    db,
    brokerList.split(","),
    process.env.INVENTORY_SAGA_GROUP ?? "greenguard-inventory-saga-v1",
    (error) => {
      console.error("inventory saga worker failed", error);
      process.exit(1);
    },
  );
  const shutdown = () => {
    void stop().finally(() => db.$disconnect());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

try {
  await main();
} catch (error: unknown) {
  console.error("inventory saga worker failed", error);
  process.exitCode = 1;
}
