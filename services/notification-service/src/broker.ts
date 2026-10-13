import amqp from "amqplib";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { declareTopology, EXCHANGE } from "./topology.js";

export interface Publish {
  exchange?: string;
  key: string;
  messageId: string;
  body: Buffer;
  headers?: Record<string, unknown>;
  expirationMs?: number;
}

/** publish() resolves only after the broker confirms the persistent message. */
export interface Broker {
  publish(message: Publish): Promise<void>;
}

export interface IncomingTask {
  body: Buffer;
  messageId?: string;
  headers: Record<string, unknown>;
  timestamp?: number;
}

export type Settlement = "ack" | "reject";

export class ConfirmBroker implements Broker {
  constructor(private readonly channel: Pick<ConfirmChannel, "publish">) {}

  publish(m: Publish): Promise<void> {
    return new Promise((resolve, reject) => {
      this.channel.publish(
        m.exchange ?? EXCHANGE,
        m.key,
        m.body,
        {
          persistent: true,
          contentType: "application/json",
          messageId: m.messageId,
          headers: m.headers,
          timestamp: Math.floor(Date.now() / 1000),
          expiration:
            m.expirationMs === undefined ? undefined : String(m.expirationMs),
        },
        (err: unknown) => (err ? reject(asError(err)) : resolve()),
      );
    });
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function toIncoming(msg: ConsumeMessage): IncomingTask {
  return {
    body: msg.content,
    messageId: msg.properties.messageId as string | undefined,
    headers: (msg.properties.headers ?? {}) as Record<string, unknown>,
    timestamp: msg.properties.timestamp as number | undefined,
  };
}

export type SettleChannel = Pick<ConfirmChannel, "ack" | "nack">;

/**
 * Settles a delivery only after the handler's durable outcome: ack on success, dead-letter
 * a reject, and requeue on any error (the ledger makes the retry idempotent).
 */
export async function settle(
  ch: SettleChannel,
  msg: ConsumeMessage,
  handle: (task: IncomingTask) => Promise<Settlement>,
): Promise<void> {
  let result: Settlement;
  try {
    result = await handle(toIncoming(msg));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.warn("notification task will be retried", {
      error: message
        .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]")
        .slice(0, 200),
    });
    ch.nack(msg, false, true);
    return;
  }
  if (result === "ack") ch.ack(msg);
  else ch.nack(msg, false, false);
}

export interface Connection {
  channel: ConfirmChannel;
  close: () => Promise<void>;
}

export async function connectBroker(url: string): Promise<Connection> {
  const model = await amqp.connect(url);
  const channel = await model.createConfirmChannel();
  await declareTopology(channel);
  return { channel, close: () => model.close() };
}
