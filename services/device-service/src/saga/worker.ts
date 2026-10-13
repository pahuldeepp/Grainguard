import { ownerDatabases } from "@greenguard/membership-client/owner-db";
import { PlacementError } from "@greenguard/membership-client";
import { kafkaSecurityFromEnv } from "@greenguard/kafka-security";
import { createRequire } from "node:module";
import kafkaJs, { type EachMessagePayload } from "kafkajs";
import type { Db } from "../db/client.js";
import { withTenant } from "../db/tenant.js";
import { resultHeaders } from "./trace.js";
import {
  applyInventoryCommand,
  decodeInventoryCommand,
  InvalidInventorySagaCommandError,
  type InventoryResult,
} from "./inventory.js";

const { CompressionCodecs, CompressionTypes, Kafka, logLevel } = kafkaJs;
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
  return (await discoverResultTenants(db, after, limit)).tenants;
}

async function discoverResultTenants(
  db: Db,
  after: string | null,
  limit = MAX_TENANTS_PER_PASS,
) {
  const pages = await Promise.allSettled(
    ownerDatabases(db).map(
      (owner) => owner.$queryRaw<{ tenant_id: string }[]>`
    SELECT tenant_id::text FROM inventory_saga_result_tenants(${after}::uuid, ${limit}::int)`,
    ),
  );
  let complete = true;
  const tenants: string[] = [];
  pages.forEach((page, index) => {
    if (page.status === "fulfilled")
      tenants.push(...page.value.map((row) => row.tenant_id));
    else {
      complete = false;
      // Do not log database credentials, row data or a tenant identifier.
      console.error("inventory saga result discovery unavailable", {
        ownerIndex: index,
      });
    }
  });
  return {
    tenants: [...new Set(tenants)]
      .sort((a, b) => (a < b ? -1 : Number(a > b)))
      .slice(0, limit),
    complete,
  };
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
  const { tenants, complete } = await discoverResultTenants(db, cursor);
  for (const tenant of tenants) {
    if (!include(tenant)) continue;
    try {
      let sent = 0;
      while (
        sent < MAX_RESULTS_PER_TENANT &&
        (await publishPendingResult(db, tenant, publish))
      )
        sent++;
    } catch (error) {
      // Leave durable results pending while placement is unavailable/quiescing.
      if (!(error instanceof PlacementError)) throw error;
    }
  }
  return !complete || tenants.length < MAX_TENANTS_PER_PASS
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
  onKafkaHeartbeat?: () => void,
  onDatabaseSuccess?: () => void,
): Promise<() => Promise<void>> {
  if (!brokers.length || brokers.some((broker) => !broker))
    throw new Error("inventory saga worker requires Kafka brokers");
  CompressionCodecs[CompressionTypes.Snappy] = createRequire(import.meta.url)(
    "kafkajs-snappy",
  );
  const kafka = new Kafka({
    clientId: "inventory-saga-worker",
    brokers,
    logLevel: logLevel.ERROR,
    ...kafkaSecurityFromEnv(),
  });
  const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  let active = true;
  let publishing: Promise<void> | undefined;
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
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    if (!payload.restart) onFatal?.(payload.error);
  });
  consumer.on(consumer.events.HEARTBEAT, onKafkaHeartbeat ?? (() => undefined));
  await producer.connect();
  try {
    await consumer.connect();
    await consumer.subscribe({ topic: COMMAND_TOPIC, fromBeginning: true });
    ticker = setInterval(() => {
      if (!active || publishing) return;
      publishing = publishResultsPass(db, cursor, publish)
        .then((next) => {
          cursor = next;
          onDatabaseSuccess?.();
        })
        .catch((error: unknown) => {
          if (active) onFatal?.(error as Error);
        })
        .finally(() => {
          publishing = undefined;
        });
    }, 250);
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({
        topic,
        partition,
        message,
      }: EachMessagePayload) => {
        try {
          if (!message.value || !message.key)
            throw new InvalidInventorySagaCommandError(
              "saga command missing key/value",
            );
          const command = decodeInventoryCommand(message.value, message.key);
          // Every tenant's command runs in that tenant's RLS transaction.
          if (command) await applyInventoryCommand(db, command);
          if (command) onDatabaseSuccess?.();
        } catch (error) {
          if (!(error instanceof InvalidInventorySagaCommandError)) throw error;
          await producer.send({
            topic: COMMAND_DLQ_TOPIC,
            acks: -1,
            messages: [
              {
                key: `${topic}:${partition}:${message.offset}`,
                value: JSON.stringify({
                  source_topic: topic,
                  partition,
                  offset: message.offset,
                  reason: error.message,
                  key_base64: message.key?.toString("base64") ?? "",
                  value_base64: message.value?.toString("base64") ?? "",
                }),
              },
            ],
          });
        }
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString(),
          },
        ]);
      },
    });
    return async () => {
      active = false;
      clearInterval(ticker);
      await publishing?.catch(() => undefined);
      await consumer.disconnect();
      await producer.disconnect();
    };
  } catch (error) {
    active = false;
    clearInterval(ticker);
    await consumer.disconnect().catch(() => undefined);
    await producer.disconnect();
    throw error;
  }
}
