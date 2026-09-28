import { Cluster, Redis } from "ioredis";
import type { CacheStore } from "./cache.js";

/** Parses `host:port=host:port,...` into an ioredis cluster NAT map. */
export function parseAddressMap(
  value: string | undefined,
): Record<string, { host: string; port: number }> {
  const map: Record<string, { host: string; port: number }> = {};
  for (const pair of (value ?? "").split(",").map((v) => v.trim())) {
    if (!pair) continue;
    const [from, to] = pair.split("=");
    const [host, port] = (to ?? "").split(":");
    if (!from || !host || !Number.isInteger(Number(port)))
      throw new Error("invalid_redis_address_map");
    map[from] = { host, port: Number(port) };
  }
  return map;
}

type Client = Redis | Cluster;
export type ReadRedis = CacheStore & {
  client: Client;
  /** Connects and opens every node connection so the first burst does not time out. */
  connect(): Promise<void>;
  close(): Promise<void>;
};

/** Adapts ioredis to the cache's small command surface. */
export function cacheStore(client: Client): ReadRedis {
  return {
    client,
    get: (key) => client.get(key),
    set: (key, value, options) =>
      options.NX
        ? client.set(key, value, "PX", options.PX, "NX")
        : client.set(key, value, "PX", options.PX),
    eval: (script, options) =>
      client.eval(
        script,
        options.keys.length,
        ...options.keys,
        ...options.arguments,
      ),
    connect: async () => {
      await client.connect();
      const nodes = client instanceof Cluster ? client.nodes("all") : [client];
      await Promise.all(nodes.map((node) => node.ping()));
    },
    close: async () => {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}

// Commands fail fast instead of queueing while Redis is unavailable; the cache
// then serves from the owning store. Reconnects use a capped backoff.
const retry = (times: number) => Math.min(50 * 2 ** times, 2_000);
const redisOptions = {
  connectTimeout: 500,
  maxRetriesPerRequest: 0,
  enableOfflineQueue: false,
  lazyConnect: true,
};

/** Builds the Read API cache client from env, or null when caching is off. */
export function createReadRedis(env: NodeJS.ProcessEnv): ReadRedis | null {
  const urls = (env.READ_REDIS_CLUSTER_NODES ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((url) => new URL(url));
  const nodes = urls.map((url) => {
    if (url.protocol !== "redis:" && url.protocol !== "rediss:")
      throw new Error("invalid_redis_scheme");
    return { host: url.hostname, port: Number(url.port || 6379) };
  });
  if (nodes.length) {
    const first = urls[0];
    const credentials = `${first.username}:${first.password}`;
    if (
      urls.some(
        (url) =>
          url.protocol !== first.protocol ||
          `${url.username}:${url.password}` !== credentials,
      )
    )
      throw new Error("inconsistent_redis_cluster_auth");
    return cacheStore(
      new Cluster(nodes, {
        enableOfflineQueue: false,
        lazyConnect: true,
        clusterRetryStrategy: retry,
        // Periodic refresh also repairs the slot map after a silent failover.
        slotsRefreshInterval: 1_000,
        slotsRefreshTimeout: 500,
        maxRedirections: 4,
        natMap: parseAddressMap(env.READ_REDIS_NODE_ADDRESS_MAP),
        redisOptions: {
          connectTimeout: 500,
          maxRetriesPerRequest: 0,
          ...(first.username && {
            username: decodeURIComponent(first.username),
          }),
          ...(first.password && {
            password: decodeURIComponent(first.password),
          }),
          ...(first.protocol === "rediss:" && { tls: {} }),
        },
      }),
    );
  }
  if (env.READ_REDIS_URL)
    return cacheStore(
      new Redis(env.READ_REDIS_URL, { ...redisOptions, retryStrategy: retry }),
    );
  return null;
}
