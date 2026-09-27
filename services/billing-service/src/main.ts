import { readFileSync } from "node:fs";
import { createVerifierFromEnv } from "@greenguard/membership-client";
import { createBillingApp } from "./app.js";
import { readConfig } from "./config.js";
import { createDb } from "./db.js";
import { StripeSdkPort } from "./stripe-port.js";
import { BillingCommands } from "./commands.js";
import { BillingWebhooks } from "./webhooks.js";
import { BillingUsage } from "./usage.js";
import { BillingWorker, startBillingWorker } from "./worker.js";
import { startBillingConsumer } from "./consumer.js";
import { ConsumerLag } from "./lag.js";

export async function start(env: NodeJS.ProcessEnv) {
  const config = readConfig(env); // Reject live Stripe credentials before any network call.
  const db = createDb(config.databaseUrl);
  const stripe = new StripeSdkPort(config.stripeApiKey);
  const commands = new BillingCommands(db, stripe, config);
  const webhooks = new BillingWebhooks(db, stripe, {
    secrets: config.webhookSecrets, encryptionKey: config.inboxEncryptionKey,
    graceDays: config.graceDays,
  });
  const usage = new BillingUsage(db);
  const verifier = createVerifierFromEnv((key) => env[key], readFileSync as (path: string) => string);
  const app = await createBillingApp({ db, commands, webhooks, verifier });
  const lag = new ConsumerLag();
  const worker = new BillingWorker(db, commands, webhooks, usage, {
    closeLagMs: Number(env.BILLING_CLOSE_LAG_MS ?? 15 * 60_000),
    consumerLagMs: () => lag.lagMs() });
  let stopWorker: (() => Promise<void>) | undefined;
  let consumer: Awaited<ReturnType<typeof startBillingConsumer>> | undefined;
  try {
    await app.listen(config.port, config.host);
    stopWorker = startBillingWorker(worker);
    const brokers = env.BILLING_KAFKA_BROKERS?.split(",").map((part) => part.trim()).filter(Boolean);
    if (brokers?.length) consumer = await startBillingConsumer({ brokers, commands, usage, lag });
  } catch (error) {
    await stopWorker?.();
    await consumer?.disconnect();
    await app.close();
    verifier.close();
    await db.$disconnect();
    throw error;
  }
  const close = async () => {
    await stopWorker?.();
    await consumer?.disconnect();
    await app.close();
    verifier.close();
    await db.$disconnect();
  };
  return { app, close };
}

if (process.argv[1]?.endsWith("billing-service/dist/src/main.js")) {
  const runtime = await start(process.env);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => { void runtime.close().then(() => process.exit(0)); });
}
