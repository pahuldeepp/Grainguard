import { readFileSync } from "node:fs";
import express from "express";
import { createClient, createCluster } from "redis";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import {
  createMachineControlPlaneVerifier,
  machineAwareVerifier,
} from "@greenguard/tenant-auth/machine-control-plane";
import { startMembershipRuntime } from "@greenguard/membership-client";
import { ProvisioningClient } from "./provisioning.js";
import { createSagaMtlsClient } from "./saga-mtls.js";
import { ReadClient } from "./read-client.js";
import { createDeviceLoader } from "./device-loader.js";
import { AlertClient } from "./alerts.js";
import { attachSubscriptions } from "./subscriptions.js";
import { LiveFeed, type LiveSubscriber } from "./live-feed.js";
import { createApolloServer, type BffContext } from "./schema.js";
import {
  QueryPolicyError,
  resolvePersistedOperation,
  operations,
} from "./query-policy.js";
import {
  redisRateLimiter,
  type RateLimiter,
  type RateStore,
} from "./rate-limit.js";

export interface BffOptions {
  verify: (authorization: string | undefined) => Promise<Principal>;
  provisioning: ProvisioningClient;
  read?: ReadClient;
  alerts?: AlertClient;
  server?: ApolloServer<BffContext>;
  rateLimiter?: RateLimiter;
  ready?: () => boolean;
  rateCheckTimeoutMs?: number;
}

const machineReadOperations = new Set<string>([
  operations.deviceCurrent,
  operations.readingById,
  operations.deviceHistory,
  operations.deviceSearch,
  operations.siteDevices,
  operations.readingRollups,
]);

function createRateRedis(
  nodes: string[],
  url: string | undefined,
  addressMap?: string,
) {
  const socket = { connectTimeout: 2000 };
  if (nodes.length) {
    const nodeAddressMap: Record<string, { host: string; port: number }> = {};
    for (const pair of (addressMap ?? "").split(",").filter(Boolean)) {
      const [source, destination] = pair.split("=");
      if (!source || !destination) throw new Error("invalid Redis address map");
      const [host, portText] = destination.split(":");
      const port = Number(portText);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("invalid Redis address map");
      nodeAddressMap[source] = { host, port };
    }
    return createCluster({
      rootNodes: nodes.map((node) => ({ url: node })),
      defaults: { disableOfflineQueue: true, socket },
      nodeAddressMap,
    });
  }
  if (url) return createClient({ url, disableOfflineQueue: true, socket });
  return null;
}

async function boundedRateCheck<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("rate_check_timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createApp(options: BffOptions) {
  const app = express();
  const server = options.server ?? createApolloServer();
  await server.start();
  app.disable("x-powered-by");
  app.get("/healthz", (_request, response) => {
    response.status(204).end();
  });
  app.get("/readyz", (_request, response) => {
    response.status(options.ready?.() === false ? 503 : 204).end();
  });
  app.use(
    "/graphql",
    express.json({ limit: "32kb" }),
    async (request, response, next) => {
      try {
        const principal = await options.verify(request.header("Authorization"));
        response.locals.principal = principal;
        next();
      } catch (error) {
        if (error instanceof AuthError) {
          response.status(error.status).json({ code: error.code });
        } else {
          next(error);
        }
      }
    },
    (request, response, next) => {
      try {
        request.body = resolvePersistedOperation(request.body);
        if (
          (response.locals.principal as Principal).principalType ===
            "service" &&
          !machineReadOperations.has(
            (request.body as Record<string, unknown>).query as string,
          )
        ) {
          response.status(403).json({ code: "insufficient_role" });
          return;
        }
        next();
      } catch (error) {
        if (error instanceof QueryPolicyError) {
          response.status(400).json({ code: error.code });
        } else {
          next(error);
        }
      }
    },
    async (request, response, next) => {
      if (!options.rateLimiter) return next();
      try {
        const decision = await boundedRateCheck(
          options.rateLimiter.check(
            response.locals.principal as Principal,
            request.body as Record<string, unknown>,
          ),
          options.rateCheckTimeoutMs ?? 1000,
        );
        if (!decision.allowed) {
          response.setHeader("Retry-After", String(decision.retryAfterSeconds));
          response.status(429).json({ code: "rate_limited" });
          return;
        }
        next();
      } catch (error) {
        console.error("BFF rate limiter unavailable", error);
        response.status(503).json({ code: "rate_limit_unavailable" });
      }
    },
    expressMiddleware(server, {
      context: async ({ req, res }): Promise<BffContext> => {
        const authorization = req.header("Authorization") ?? "";
        return {
          principal: res.locals.principal as Principal,
          authorization,
          traceparent: req.header("traceparent"),
          provisioning: options.provisioning,
          read: options.read,
          alerts: options.alerts,
          deviceLoader: options.read
            ? createDeviceLoader(options.read, authorization)
            : undefined,
        };
      },
    }),
  );
  return { app, server };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  if (!process.env.SAGA_API_URL) throw new Error("SAGA_API_URL is required");
  const verifier = await startMembershipRuntime(
    (key) => process.env[key],
    (path) => readFileSync(path, "utf8"),
    "bff",
  );
  const machine =
    process.env.CONTROL_PLANE_URL && process.env.CONTROL_LOOKUP_TOKEN
      ? createMachineControlPlaneVerifier({
          endpoint: process.env.CONTROL_PLANE_URL,
          lookupToken: process.env.CONTROL_LOOKUP_TOKEN,
        })
      : undefined;
  const verify = machineAwareVerifier(
    verifier.verify,
    machine,
    "read:telemetry",
  );
  const sagaMtls = createSagaMtlsClient(process.env, process.env.SAGA_API_URL!);
  const rateNodes = (process.env.BFF_RATE_REDIS_CLUSTER_NODES ?? "")
    .split(",")
    .map((node) => node.trim())
    .filter(Boolean);
  const rateRedis = createRateRedis(rateNodes, process.env.BFF_RATE_REDIS_URL);
  if (process.env.NODE_ENV === "production" && rateNodes.length === 0)
    throw new Error("BFF_RATE_REDIS_CLUSTER_NODES is required in production");
  if (!rateRedis && process.env.BFF_ALLOW_NO_RATE_LIMIT !== "true")
    throw new Error(
      "Redis rate limiter is required; set BFF_ALLOW_NO_RATE_LIMIT=true only for local development",
    );
  let rateReady = !rateRedis;
  if (rateRedis) {
    rateRedis.on("error", (error) => {
      rateReady = false;
      console.error("BFF Redis error", error);
    });
    rateRedis.on("ready", () => {
      rateReady = true;
    });
    rateRedis.on("end", () => {
      rateReady = false;
    });
    rateRedis.on("reconnecting", () => {
      rateReady = false;
    });
    await rateRedis.connect();
    rateReady = true;
  }
  const liveNodes = (
    process.env.BFF_LIVE_REDIS_CLUSTER_NODES ??
    process.env.READ_REDIS_CLUSTER_NODES ??
    ""
  )
    .split(",")
    .map((node) => node.trim())
    .filter(Boolean);
  const liveRedis = createRateRedis(
    liveNodes,
    process.env.BFF_LIVE_REDIS_URL ?? process.env.READ_REDIS_URL,
    process.env.BFF_LIVE_REDIS_NODE_ADDRESS_MAP ??
      process.env.READ_REDIS_NODE_ADDRESS_MAP,
  );
  if (process.env.NODE_ENV === "production" && !liveRedis)
    throw new Error("BFF_LIVE_REDIS_CLUSTER_NODES is required in production");
  const liveFeed = liveRedis
    ? new LiveFeed(liveRedis as unknown as LiveSubscriber)
    : undefined;
  if (liveRedis) {
    try {
      await liveRedis.connect();
      await liveFeed?.start();
    } catch (error) {
      console.error(
        "BFF live Redis unavailable; using bounded fallback polling",
        error,
      );
      await liveFeed?.start();
    }
  }
  let stopping = false;
  const { app, server } = await createApp({
    verify,
    provisioning: new ProvisioningClient(
      process.env.SAGA_API_URL!,
      sagaMtls?.fetcher,
    ),
    read: process.env.READ_API_URL
      ? new ReadClient(process.env.READ_API_URL)
      : undefined,
    alerts: process.env.ALERT_API_URL
      ? new AlertClient(process.env.ALERT_API_URL)
      : undefined,
    rateLimiter: rateRedis
      ? redisRateLimiter(rateRedis as RateStore)
      : undefined,
    ready: () => !stopping && rateReady,
  });
  const listener = app.listen(Number(process.env.BFF_PORT ?? "4000"));
  const stopSubscriptions = process.env.READ_API_URL
    ? attachSubscriptions(listener, {
        verify: verifier.verify,
        read: new ReadClient(process.env.READ_API_URL),
        feed: liveFeed,
      })
    : undefined;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const parsedDrain = Number(process.env.BFF_DRAIN_MS ?? 1000);
    const drainMs = Number.isFinite(parsedDrain)
      ? Math.max(0, Math.min(10_000, parsedDrain))
      : 1000;
    const deadline = setTimeout(() => process.exit(1), drainMs + 10_000);
    deadline.unref();
    setTimeout(async () => {
      await stopSubscriptions?.();
      listener.close(async (listenerError) => {
        const results = await Promise.allSettled([
          server.stop(),
          rateRedis?.quit(),
          liveRedis?.quit(),
          sagaMtls?.close(),
          verifier.close(),
        ]);
        if (listenerError)
          console.error("BFF listener shutdown failed", listenerError);
        for (const result of results)
          if (result.status === "rejected")
            console.error("BFF shutdown failed", result.reason);
        process.exitCode =
          listenerError ||
          results.some((result) => result.status === "rejected")
            ? 1
            : 0;
        clearTimeout(deadline);
      });
    }, drainMs).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, shutdown);
  }
}
