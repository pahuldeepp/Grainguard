import { closeOwnerDatabase } from "@greenguard/membership-client/owner-db";
import { startWorkerHealth } from "@greenguard/entitlements/worker-health";
import { createDb } from "../db/client.js";
import { rejectTenantList, startInventorySagaWorker } from "./worker.js";

async function main() {
  const url = process.env.INVENTORY_DATABASE_URL;
  const brokerList = process.env.KAFKA_BROKERS;
  if ((!url && !process.env.SHARD_REGISTRY_FILE) || !brokerList)
    throw new Error("INVENTORY_DATABASE_URL and KAFKA_BROKERS are required");
  rejectTenantList(process.env);
  const db = createDb(url ?? "");
  const health = await startWorkerHealth();
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await startInventorySagaWorker(
      db,
      brokerList.split(","),
      process.env.INVENTORY_SAGA_GROUP ?? "greenguard-inventory-saga-v1",
      (error) => {
        console.error("inventory saga worker failed", error);
        process.exit(1);
      },
      health.kafkaHeartbeat,
      health.databaseSuccess,
    );
  } catch (error) {
    await health.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= Promise.resolve()
      .then(() => stop?.())
      .finally(() => health.close())
      .finally(() =>
        closeOwnerDatabase(db, 5000, (client) => client.$disconnect()),
      );
    void closing.catch((error) => {
      console.error("inventory saga worker shutdown failed", error);
      process.exitCode = 1;
    });
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
