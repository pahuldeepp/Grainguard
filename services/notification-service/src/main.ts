import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { closeOwnerDatabase } from "@greenguard/membership-client/owner-db";
import { createNotificationPool } from "./tenant.js";
import { renderPostgresPoolMetrics } from "@greenguard/otel";
import {
  LocalTestAdapter,
  UnconfiguredAdapter,
  type ProviderAdapter,
} from "./adapters.js";
import { ConfirmBroker, connectBroker, settle } from "./broker.js";
import { loadConfig, type Config } from "./config.js";
import {
  createProviderSelector,
  type ProviderDependencies,
} from "./providers.js";
import { Metrics } from "./metrics.js";
import { Semaphore } from "./pool.js";
import type { Channel } from "./task.js";
import { TASK_QUEUE } from "./topology.js";
import { handleTask, type Deps } from "./worker.js";
import { VersionedFlagStore } from "@greenguard/feature-flags";
import { controlPlaneFlagSnapshot, optionalSendGate } from "./flags.js";
import { startFlagFeed } from "./flag-feed.js";
import {
  createDynamoFeedStore,
  startDynamoFlagFeed,
} from "./dynamodb-flag-feed.js";
import { notificationReadHandler, notificationReadReady } from "./read-api.js";
import type { Principal } from "@greenguard/tenant-auth";
import { startMembershipRuntime } from "@greenguard/membership-client";
import { readFileSync } from "node:fs";
import { DeliveryDrain } from "./delivery-drain.js";

// The chart gives the pod 30 seconds to terminate; reserve time after this
// drain for closing RabbitMQ, HTTP, flag feeds and PostgreSQL.
const DELIVERY_DRAIN_TIMEOUT_MS = 20_000;

export function adapterFor(
  config: Config,
  dependencies: ProviderDependencies = {},
): (channel: Channel) => ProviderAdapter {
  if (config.provider === "local") {
    const local = new LocalTestAdapter();
    return () => local;
  }
  if (config.provider === "live") {
    const select = createProviderSelector(
      config.notificationProviders,
      dependencies,
    );
    const unsupported: ProviderAdapter = {
      send: async () => ({
        kind: "rejected",
        reason: "unsupported notification channel",
      }),
      reconcile: async () => ({ kind: "not_found" }),
    };
    return (channel) =>
      channel === "email" || channel === "sms"
        ? select("warning", channel)
        : unsupported;
  }
  return (channel) => new UnconfiguredAdapter(channel);
}

/** No configured flag source means optional warning delivery is ungated. */
export function optionalSendFor(config: Config, store: VersionedFlagStore) {
  if (!config.kafkaBrokers?.length && !config.flagSnapshot) return undefined;
  return optionalSendGate(
    store,
    config.flagSnapshot
      ? controlPlaneFlagSnapshot(
          config.flagSnapshot.url,
          config.flagSnapshot.token,
          {
            allowInsecureHttp:
              (config.provider !== "live" ||
                config.controlPlaneMeshHttp === true) &&
              config.flagSnapshot.allowInsecureHttp === true,
          },
        )
      : undefined,
  );
}

export function metricsServer(
  metrics: Metrics,
  providers: Semaphore,
  readApi?: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => Promise<boolean>,
  readReady?: () => Promise<boolean>,
): Server {
  return createServer((req, res) => {
    if (req.url === "/healthz") {
      res.end("ok\n");
      return;
    }
    if (req.url === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(
        `${metrics.render({ provider_in_flight: providers.inFlight })}${renderPostgresPoolMetrics()}`,
      );
      return;
    }
    if (req.url === "/readyz/notification-history") {
      if (!readReady) {
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "not_configured" }));
      } else {
        void readReady()
          .then((ready) => {
            res.statusCode = ready ? 204 : 503;
            if (!ready) {
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ status: "unavailable" }));
            } else res.end();
          })
          .catch(() => {
            res.statusCode = 503;
            res.end();
          });
      }
      return;
    }
    if (req.url?.startsWith("/internal/v1/deliveries/lookup")) {
      if (!readApi) {
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "owner_read_not_configured" }));
        return;
      }
      void readApi(req, res)
        .then((handled) => {
          if (!handled && !res.writableEnded) {
            res.statusCode = 404;
            res.end();
          }
        })
        .catch(() => {
          if (!res.writableEnded) {
            res.statusCode = 503;
            res.end();
          }
        });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}

/** Starts the consumer; returns a stop function for graceful shutdown. */
export async function start(config: Config): Promise<() => Promise<void>> {
  const pool = createNotificationPool(
    config.databaseUrl,
    config.prefetch + 2,
    config.ownerEnvironment,
  );
  const connection = await connectBroker(config.rabbitUrl);
  const metrics = new Metrics();
  const providers = new Semaphore(config.providerConcurrency);
  const flagStore = new VersionedFlagStore(60_000, Date.now, () =>
    metrics.inc("flags_stale"),
  );
  const stopFlagFeed = config.kafkaBrokers?.length
    ? startFlagFeed(flagStore, config.kafkaBrokers, {
        onUnavailable: () => metrics.inc("flags_feed_unavailable"),
      })
    : async () => {};
  const dynamoFlagStore = config.flagDynamo
    ? createDynamoFeedStore(config.flagDynamo)
    : undefined;
  const stopDynamoFlagFeed =
    dynamoFlagStore && config.kafkaBrokers?.length
      ? startDynamoFlagFeed(dynamoFlagStore, config.kafkaBrokers, {
          onUnavailable: () => metrics.inc("flags_dynamodb_feed_unavailable"),
        })
      : async () => {};
  const deps: Deps = {
    pool,
    broker: new ConfirmBroker(connection.channel),
    adapter: adapterFor(config),
    providers,
    policy: config.policy,
    metrics,
    optionalSendEnabled: optionalSendFor(config, flagStore),
  };
  // Prefetch bounds in-flight tasks; the provider semaphore separately bounds provider calls.
  await connection.channel.prefetch(config.prefetch);
  const deliveries = new DeliveryDrain();
  const { consumerTag } = await connection.channel.consume(
    TASK_QUEUE,
    (msg) => {
      if (!msg) return;
      if (!deliveries.isAccepting) {
        // cancel() prevents new broker sends, but callbacks already queued in
        // this process may still arrive. Requeue them before closing the channel.
        try {
          connection.channel.nack(msg, false, true);
        } catch {
          // A closed RabbitMQ connection requeues its unacked deliveries.
        }
        return;
      }
      deliveries.track(
        settle(connection.channel, msg, (task) => handleTask(deps, task)),
      );
    },
    { noAck: false },
  );
  const authReady = [
    "AUTH_ISSUER",
    "AUTH_AUDIENCE",
    "AUTH_JWKS_URL",
    "NOTIFICATIONS_AUDIT_HMAC_KEY",
  ].every((key) => !!process.env[key]);
  const verifier = authReady
    ? await startMembershipRuntime(
        (key) => process.env[key],
        (path) => readFileSync(path, "utf8"),
        "notification-service",
      )
    : undefined;
  const readApi = verifier
    ? notificationReadHandler(
        pool,
        (authorization): Promise<Principal> => verifier.verify(authorization),
        process.env.NOTIFICATIONS_AUDIT_HMAC_KEY!,
      )
    : undefined;
  const readReady = verifier
    ? () =>
        notificationReadReady(pool, process.env.NOTIFICATIONS_AUDIT_HMAC_KEY!)
    : undefined;
  const server = metricsServer(metrics, providers, readApi, readReady).listen(
    config.httpPort,
    config.httpHost,
  );
  return async () => {
    deliveries.stopAccepting();
    const cleanup: Array<() => unknown | Promise<unknown>> = [
      () => connection.channel.cancel(consumerTag),
      () => deliveries.wait(DELIVERY_DRAIN_TIMEOUT_MS),
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        }),
      () => connection.close(),
      () => stopFlagFeed(),
      () => stopDynamoFlagFeed(),
      () => dynamoFlagStore?.close(),
      () => closeOwnerDatabase(pool, 5000, (pool) => pool.end()),
      () => verifier?.close(),
    ];
    const failures: unknown[] = [];
    for (const close of cleanup) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "notification-service shutdown failed",
      );
  };
}

export async function main(
  getenv = (k: string) => process.env[k],
): Promise<void> {
  const stop = await start(loadConfig(getenv));
  const shutdown = () =>
    void stop().then(
      () => process.exit(0),
      (error) => {
        console.error("notification-service shutdown failed", error);
        process.exit(1);
      },
    );
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error("notification-service failed", error);
    process.exit(1);
  }
}
