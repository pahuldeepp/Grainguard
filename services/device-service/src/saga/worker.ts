import {
  connectWorker,
  createWorkerClients,
  processWithDlq,
} from "@greenguard/kafka-runtime";
import type { EachMessagePayload } from "kafkajs";
import type { Db } from "../db/client.js";
import { withTenant } from "../db/tenant.js";
import { resultHeaders } from "./trace.js";
import {
  applyInventoryCommand,
  decodeInventoryCommand,
  InvalidInventorySagaCommandError,
  type InventoryResult,
} from "./inventory.js";

export const COMMAND_TOPIC = "greenguard.saga.commands.v1";
export const RESULT_TOPIC = "greenguard.saga.results.v1";
export const COMMAND_DLQ_TOPIC = "greenguard.saga.commands.dlq.v1";

export const MAX_TENANTS_PER_PASS = 100;
export const MAX_RESULTS_PER_TENANT = 10;

// Replaces the retired static tenant list. Starting with one is a configuration
// error, so an operator cannot silently narrow the worker to a subset.
export function rejectTenantList(env: NodeJS.ProcessEnv): void {
  if (env.INVENTORY_SAGA_TENANT_IDS !== undefined)
    throw new Error(
      "INVENTORY_SAGA_TENANT_IDS is retired: the worker discovers tenants with pending results itself",
    );
}

// ID-only discovery through the SECURITY DEFINER selector; row data is read
// only inside each tenant's RLS transaction.
export async function tenantsWithPendingResults(
  db: Db,
  after: string | null,
  limit = MAX_TENANTS_PER_PASS,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ tenant_id: string }[]>`
    SELECT tenant_id::text FROM inventory_saga_result_tenants(${after}::uuid, ${limit}::int)`;
  return rows.map((row) => row.tenant_id);
}

// One bounded, round-robin pass: at most MAX_TENANTS_PER_PASS tenants after the
// cursor, at most MAX_RESULTS_PER_TENANT results each. Returns the next cursor;
// null wraps to the first tenant, so every tenant is reached within
// ceil(tenants / MAX_TENANTS_PER_PASS) + 1 passes.
export async function publishResultsPass(
  db: Db,
  cursor: string | null,
  publish: (key: string, value: string) => Promise<void>,
  include: (tenant: string) => boolean = () => true,
): Promise<string | null> {
  const tenants = await tenantsWithPendingResults(db, cursor);
  for (const tenant of tenants) {
    if (!include(tenant)) continue;
    let sent = 0;
    while (
      sent < MAX_RESULTS_PER_TENANT &&
      (await publishPendingResult(db, tenant, publish))
    )
      sent++;
  }
  return tenants.length < MAX_TENANTS_PER_PASS
    ? null
    : (tenants.at(-1) ?? null);
}

// The row lock spans the broker acknowledgement. A crash after acknowledgement
// and before DB commit may republish the same result_id; the saga inbox handles it.
export async function publishPendingResult(
  db: Db,
  tenantId: string,
  publish: (key: string, value: string) => Promise<void>,
): Promise<boolean> {
  let published = false;
  await withTenant(
    db,
    tenantId,
    async (tx) => {
      const rows = await tx.$queryRaw<
        (InventoryResult & { traceparent: string | null })[]
      >`
      SELECT tenant_id::text, saga_id::text, command_id::text, result_id::text,
        step, saga_version, fencing_token, outcome, traceparent
      FROM inventory_saga_result_outbox
      WHERE tenant_id=${tenantId}::uuid AND published_at IS NULL
      ORDER BY created_at, result_id FOR UPDATE SKIP LOCKED LIMIT 1`;
      const row = rows[0];
      if (!row) return;
      const { traceparent, ...fields } = row;
      const result: InventoryResult = {
        ...fields,
        saga_version: Number(row.saga_version),
        fencing_token: Number(row.fencing_token),
        ...(traceparent ? { traceparent } : {}),
      };
      await publish(
        `${result.tenant_id}:${result.saga_id}`,
        JSON.stringify(result),
      );
      await tx.$executeRaw`UPDATE inventory_saga_result_outbox SET published_at=now()
      WHERE tenant_id=${tenantId}::uuid AND result_id=${result.result_id}::uuid`;
      published = true;
    },
    { timeoutMs: 20_000 },
  );
  return published;
}

export async function startInventorySagaWorker(
  db: Db,
  brokers: string[],
  groupId = "greenguard-inventory-saga-v1",
  onFatal?: (error: Error) => void,
): Promise<() => Promise<void>> {
  const { consumer, producer, close } = createWorkerClients({
    moduleUrl: import.meta.url,
    brokers,
    clientId: "inventory-saga-worker",
    groupId,
    missingBrokersMessage: "inventory saga worker requires Kafka brokers",
    onFatal,
  });
  let active = true;
  let publishing = false;
  let cursor: string | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const publish = (key: string, value: string) =>
    producer
      .send({
        topic: RESULT_TOPIC,
        acks: -1,
        messages: [{ key, value, headers: resultHeaders(value) }],
      })
      .then(() => undefined);
  await connectWorker(consumer, producer);
  try {
    await consumer.subscribe({ topic: COMMAND_TOPIC, fromBeginning: true });
    ticker = setInterval(() => {
      if (!active || publishing) return;
      publishing = true;
      void publishResultsPass(db, cursor, publish)
        .then((next) => {
          cursor = next;
        })
        .catch((error: unknown) => onFatal?.(error as Error))
        .finally(() => {
          publishing = false;
        });
    }, 250);
    await consumer.run({
      autoCommit: false,
      eachMessage: async (payload: EachMessagePayload) => {
        await processWithDlq({
          consumer,
          producer,
          message: payload,
          dlqTopic: COMMAND_DLQ_TOPIC,
          isInvalid: (error): error is InvalidInventorySagaCommandError =>
            error instanceof InvalidInventorySagaCommandError,
          process: async (message) => {
            if (!message.value || !message.key)
              throw new InvalidInventorySagaCommandError(
                "saga command missing key/value",
              );
            const command = decodeInventoryCommand(message.value, message.key);
            // Every tenant's command runs in that tenant's RLS transaction.
            if (command) await applyInventoryCommand(db, command);
          },
        });
      },
    });
    return async () => {
      active = false;
      clearInterval(ticker);
      await close();
    };
  } catch (error) {
    active = false;
    clearInterval(ticker);
    await close();
    throw error;
  }
}
