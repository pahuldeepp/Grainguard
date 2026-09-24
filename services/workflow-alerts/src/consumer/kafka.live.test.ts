import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import kafkaJs from "kafkajs";
import {
  adminQuery,
  invalidationEvent,
  newStream,
  pooledDb,
  riskEvent,
} from "../testing/fixtures.js";
import { RISK_TOPICS, startRiskKafkaConsumer } from "./kafka.js";

const { Kafka, logLevel } = kafkaJs;

const waitFor = async (predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for alert Kafka effect");
};

test(
  "live Kafka assessment and invalidation resolve once across two tenants",
  {
    skip:
      process.env.ALERTS_KAFKA_LIVE !== "1" &&
      "set ALERTS_KAFKA_LIVE=1 with Kafka and alerts Postgres running",
  },
  async () => {
    const brokers = (process.env.KAFKA_BROKERS ?? "127.0.0.1:59092").split(",");
    const db = pooledDb();
    const kafka = new Kafka({
      clientId: "workflow-alerts-live-test",
      brokers,
      logLevel: logLevel.ERROR,
    });
    const producer = kafka.producer();
    const stop = await startRiskKafkaConsumer(
      db,
      brokers,
      `workflow-alerts-live-${randomUUID()}`,
    );
    await producer.connect();
    try {
      const a = newStream();
      const b = newStream();
      const assessed = riskEvent(a, 75);
      const other = riskEvent(b, 80);
      const invalidated = invalidationEvent(a, assessed);
      for (const [topic, event] of [
        [RISK_TOPICS[0], assessed],
        [RISK_TOPICS[0], other],
        [RISK_TOPICS[1], invalidated],
        [RISK_TOPICS[1], invalidated],
      ] as const) {
        await producer.send({
          topic,
          messages: [
            {
              key: event.aggregate_id,
              value: JSON.stringify(event),
              headers: {
                event_id: event.event_id,
                event_type: event.event_type,
                tenant_id: event.tenant_id,
              },
            },
          ],
        });
      }
      await waitFor(async () => {
        const rows = await adminQuery<{ tenant_id: string; state: string }>(
          "SELECT tenant_id, state FROM alert_episodes WHERE tenant_id IN ($1, $2)",
          [a.tenantId, b.tenantId],
        );
        return (
          rows.some(
            (r) => r.tenant_id === a.tenantId && r.state === "resolved",
          ) &&
          rows.some((r) => r.tenant_id === b.tenantId && r.state === "open")
        );
      });
      const outbox = await adminQuery<{ tenant_id: string; n: string }>(
        "SELECT tenant_id, count(*)::text AS n FROM outbox_events WHERE tenant_id IN ($1, $2) GROUP BY tenant_id",
        [a.tenantId, b.tenantId],
      );
      assert.equal(outbox.find((r) => r.tenant_id === a.tenantId)?.n, "2");
      assert.equal(outbox.find((r) => r.tenant_id === b.tenantId)?.n, "1");
    } finally {
      await producer.disconnect();
      await stop();
      await db.$disconnect();
    }
  },
);
