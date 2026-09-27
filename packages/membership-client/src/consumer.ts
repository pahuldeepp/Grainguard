import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import kafkaJs from "kafkajs";
import { createClient, createCluster } from "redis";
import { createRedisMembershipVersionStore } from "./redis-versions.js";
import { createVerifierFromEnv } from "./index.js";

const { CompressionCodecs, CompressionTypes, Kafka, logLevel } = kafkaJs;
const TOPIC = "greenguard.inventory.tenant.v1";

type Getenv = (key: string) => string | undefined;

// Every process gets a Kafka group of its own: the in-memory cache in each replica
// must see every change. Redis retains monotonic version floors across replicas.
export async function startMembershipRuntime(
  getenv: Getenv,
  readFile: (path: string) => string,
  serviceName: string,
) {
  if ((getenv("AUTH_MEMBERSHIP_SOURCE") || "file") !== "control-plane") {
    const verifier = createVerifierFromEnv(getenv, readFile);
    return { ...verifier, close: async () => verifier.close() };
  }
  const urls = (getenv("AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const url = getenv("AUTH_MEMBERSHIP_REDIS_URL");
  if (!urls.length && !url)
    throw new Error(
      "AUTH_MEMBERSHIP_REDIS_URL or AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES is required",
    );
  const brokers = (getenv("AUTH_MEMBERSHIP_KAFKA_BROKERS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!brokers.length)
    throw new Error("AUTH_MEMBERSHIP_KAFKA_BROKERS is required");
  const nodeAddressMap: Record<string, { host: string; port: number }> = {};
  for (const pair of (getenv("AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP") ?? "")
    .split(",")
    .filter(Boolean)) {
    const [source, target] = pair.split("=");
    const [host, portText] = (target ?? "").split(":");
    const port = Number(portText);
    if (!source || !host || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("invalid AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP");
    nodeAddressMap[source] = { host, port };
  }
  const redis = urls.length
    ? createCluster({
        rootNodes: urls.map((value) => ({ url: value })),
        defaults: {
          disableOfflineQueue: true,
          socket: { connectTimeout: 2000 },
        },
        nodeAddressMap,
      })
    : createClient({
        url,
        disableOfflineQueue: true,
        socket: { connectTimeout: 2000 },
      });
  redis.on("error", () => console.error("membership Redis unavailable"));
  await redis.connect();
  const verifier = createVerifierFromEnv(
    getenv,
    readFile,
    createRedisMembershipVersionStore(redis),
  );
  CompressionCodecs[CompressionTypes.Snappy] = createRequire(import.meta.url)(
    "kafkajs-snappy",
  );
  const kafka = new Kafka({
    clientId: serviceName,
    brokers,
    logLevel: logLevel.ERROR,
  });
  const consumer = kafka.consumer({
    groupId: `${serviceName}-membership-${randomUUID()}`,
    allowAutoTopicCreation: false,
  });
  consumer.on(consumer.events.CRASH, () =>
    console.error("membership Kafka consumer crashed"),
  );
  try {
    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        // Malformed records cannot affect the cache. Consumer progress occurs only
        // after the version floor is durable in Redis.
        let event:
          | {
              event_type: string;
              tenant_id?: unknown;
              payload: Record<string, unknown>;
            }
          | undefined;
        if (message.value && message.value.length <= 1 << 20) {
          try {
            const decoded: unknown = JSON.parse(message.value.toString("utf8"));
            if (
              decoded &&
              typeof decoded === "object" &&
              !Array.isArray(decoded) &&
              "payload" in decoded &&
              decoded.payload &&
              typeof decoded.payload === "object" &&
              !Array.isArray(decoded.payload)
            )
              event = decoded as typeof event;
          } catch {
            /* malformed JSON is skipped below */
          }
        }
        if (event) await verifier.onMembershipChanged?.(event);
        else console.error("malformed membership Kafka record skipped");
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString(),
          },
        ]);
      },
    });
  } catch (error) {
    await consumer.disconnect().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    verifier.close();
    throw error;
  }
  return {
    ...verifier,
    close: async () => {
      await consumer.disconnect();
      verifier.close();
      await redis.quit();
    },
  };
}
