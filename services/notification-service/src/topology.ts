import type { Channel } from "amqplib";

/** Must match services/jobs-worker/rabbit/topology.go exactly (PRECONDITION_FAILED otherwise). */
export const EXCHANGE = "greenguard.notifications";
export const DEAD_EXCHANGE = "greenguard.notifications.dlx";
export const TASK_QUEUE = "notifications.tasks";
export const RETRY_QUEUE = "notifications.retry";
export const DEAD_QUEUE = "notifications.dlq";
export const RECEIPT_QUEUE = "notifications.receipts";
export const TASK_KEY = "task";
export const RETRY_KEY = "retry";
export const RECEIPT_KEY = "receipt";
export const DEAD_KEY = "notifications.dead";
export const ATTEMPT_HEADER = "x-attempt";
export const OPTIONAL_HOLD_ATTEMPT_HEADER = "x-optional-hold-attempt";
export const FIRST_HELD_HEADER = "x-first-held-at-ms";
export const DELIVERY_LIMIT = 5;

const QUORUM = { "x-queue-type": "quorum" };
const AT_LEAST_ONCE = {
  "x-dead-letter-strategy": "at-least-once",
  "x-overflow": "reject-publish",
};

export const QUEUES: {
  name: string;
  exchange: string;
  key: string;
  args: Record<string, unknown>;
}[] = [
  {
    name: TASK_QUEUE,
    exchange: EXCHANGE,
    key: TASK_KEY,
    args: {
      ...QUORUM,
      ...AT_LEAST_ONCE,
      "x-dead-letter-exchange": DEAD_EXCHANGE,
      "x-dead-letter-routing-key": DEAD_KEY,
      "x-delivery-limit": DELIVERY_LIMIT,
    },
  },
  {
    name: RETRY_QUEUE,
    exchange: EXCHANGE,
    key: RETRY_KEY,
    args: {
      ...QUORUM,
      ...AT_LEAST_ONCE,
      "x-dead-letter-exchange": EXCHANGE,
      "x-dead-letter-routing-key": TASK_KEY,
    },
  },
  { name: DEAD_QUEUE, exchange: DEAD_EXCHANGE, key: DEAD_KEY, args: QUORUM },
  {
    name: RECEIPT_QUEUE,
    exchange: EXCHANGE,
    key: RECEIPT_KEY,
    args: {
      ...QUORUM,
      "x-dead-letter-exchange": DEAD_EXCHANGE,
      "x-dead-letter-routing-key": DEAD_KEY,
    },
  },
];

export type Declarer = Pick<
  Channel,
  "assertExchange" | "assertQueue" | "bindQueue"
>;

export async function declareTopology(ch: Declarer): Promise<void> {
  for (const exchange of [EXCHANGE, DEAD_EXCHANGE])
    await ch.assertExchange(exchange, "direct", { durable: true });
  for (const q of QUEUES) {
    await ch.assertQueue(q.name, { durable: true, arguments: q.args });
    await ch.bindQueue(q.name, q.exchange, q.key);
  }
}
