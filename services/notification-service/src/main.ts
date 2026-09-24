import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  LocalTestAdapter,
  UnconfiguredAdapter,
  type ProviderAdapter,
} from "./adapters.js";
import { ConfirmBroker, connectBroker, settle } from "./broker.js";
import { loadConfig, type Config } from "./config.js";
import { Metrics } from "./metrics.js";
import { Semaphore } from "./pool.js";
import type { Channel } from "./task.js";
import { TASK_QUEUE } from "./topology.js";
import { handleTask, type Deps } from "./worker.js";

export function adapterFor(
  config: Config,
): (channel: Channel) => ProviderAdapter {
  if (config.provider === "local") {
    const local = new LocalTestAdapter();
    return () => local;
  }
  return (channel) => new UnconfiguredAdapter(channel);
}

export function metricsServer(metrics: Metrics, providers: Semaphore): Server {
  return createServer((req, res) => {
    if (req.url === "/healthz") {
      res.end("ok\n");
      return;
    }
    if (req.url === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(metrics.render({ provider_in_flight: providers.inFlight }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}

/** Starts the consumer; returns a stop function for graceful shutdown. */
export async function start(config: Config): Promise<() => Promise<void>> {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.prefetch + 2,
  });
  const connection = await connectBroker(config.rabbitUrl);
  const metrics = new Metrics();
  const providers = new Semaphore(config.providerConcurrency);
  const deps: Deps = {
    pool,
    broker: new ConfirmBroker(connection.channel),
    adapter: adapterFor(config),
    providers,
    policy: config.policy,
    metrics,
  };
  // Prefetch bounds in-flight tasks; the provider semaphore separately bounds provider calls.
  await connection.channel.prefetch(config.prefetch);
  const { consumerTag } = await connection.channel.consume(
    TASK_QUEUE,
    (msg) => {
      if (msg)
        void settle(connection.channel, msg, (task) => handleTask(deps, task));
    },
    { noAck: false },
  );
  const server = metricsServer(metrics, providers).listen(
    config.httpPort,
    "127.0.0.1",
  );
  return async () => {
    await connection.channel.cancel(consumerTag);
    server.close();
    await connection.close();
    await pool.end();
  };
}

export async function main(
  getenv = (k: string) => process.env[k],
): Promise<void> {
  const stop = await start(loadConfig(getenv));
  const shutdown = () => void stop().then(() => process.exit(0));
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
