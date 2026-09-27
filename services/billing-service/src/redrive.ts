import { readConfig } from "./config.js";
import { createDb } from "./db.js";
import { StripeSdkPort } from "./stripe-port.js";
import { BillingWebhooks } from "./webhooks.js";

// Operator command: exact event ID, named actor, and reason are mandatory.
// It cannot replay an already applied event or bypass the customer/tenant checks.
export async function redriveFromEnv(env: NodeJS.ProcessEnv, args: string[]): Promise<boolean> {
  const [eventId, actorId, reason, tenantId] = args;
  if (!eventId || !/^evt_[A-Za-z0-9]+$/.test(eventId) ||
      !actorId?.trim() || !reason?.trim() || args.length > 4)
    throw new Error("usage: redrive <evt_id> <actor_id> <reason> [tenant_uuid]");
  const config = readConfig(env);
  const db = createDb(config.databaseUrl);
  try {
    const webhooks = new BillingWebhooks(db, new StripeSdkPort(config.stripeApiKey), {
      secrets: config.webhookSecrets, encryptionKey: config.inboxEncryptionKey,
      graceDays: config.graceDays,
    });
    return await webhooks.redrive(eventId, actorId, reason, tenantId);
  } finally { await db.$disconnect(); }
}

if (process.argv[1]?.endsWith("billing-service/dist/src/redrive.js")) {
  const queued = await redriveFromEnv(process.env, process.argv.slice(2));
  process.stdout.write(queued ? "queued for replay\n" : "not found or already applied\n");
}
