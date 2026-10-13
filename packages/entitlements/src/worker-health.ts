import { createServer, type Server } from "node:http";

const KAFKA_MAX_AGE_MS = 20_000;
const DATABASE_MAX_AGE_MS = 15_000;

export type WorkerHealth = {
  kafkaHeartbeat(): void;
  databaseSuccess(): void;
  port(): number;
  close(): Promise<void>;
};

/**
 * Exposes a private health listener for a Kafka worker. Readiness requires both
 * a recent broker group heartbeat and a recent successful database operation. The
 * liveness endpoint only reports that the process/event loop is responsive;
 * dependency outages therefore remove readiness without causing restart loops.
 */
export async function startWorkerHealth(
  options: { port?: number; now?: () => number } = {},
): Promise<WorkerHealth> {
  const port = options.port ?? Number(process.env.WORKER_HEALTH_PORT ?? 8090);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("WORKER_HEALTH_PORT must be a valid TCP port");

  const now = options.now ?? Date.now;
  let lastKafkaHeartbeat = 0;
  let lastDatabaseSuccess = 0;
  let closing = false;
  const server: Server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.url === "/healthz") {
      response.writeHead(closing ? 503 : 200).end();
      return;
    }
    if (request.url === "/readyz") {
      const at = now();
      const ready =
        !closing &&
        at - lastKafkaHeartbeat <= KAFKA_MAX_AGE_MS &&
        at - lastDatabaseSuccess <= DATABASE_MAX_AGE_MS;
      response.writeHead(ready ? 200 : 503).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    kafkaHeartbeat() {
      lastKafkaHeartbeat = now();
    },
    databaseSuccess() {
      lastDatabaseSuccess = now();
    },
    port() {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("worker health server is not listening");
      return address.port;
    },
    async close() {
      closing = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
