import { createServer, type Server } from "node:http";

export type ProbeHealth = {
  ready(): void;
  notReady(): void;
  port(): number;
  close(): Promise<void>;
};

/** Loopback-only process probes for workers with their own readiness signal. */
export async function startProbeHealth(
  options: { port?: number } = {},
): Promise<ProbeHealth> {
  const port = options.port ?? Number(process.env.WORKER_HEALTH_PORT ?? 8090);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("WORKER_HEALTH_PORT must be a valid TCP port");

  let isReady = false;
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
      response.writeHead(!closing && isReady ? 200 : 503).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    ready() {
      isReady = true;
    },
    notReady() {
      isReady = false;
    },
    port() {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("worker health server is not listening");
      return address.port;
    },
    async close() {
      closing = true;
      isReady = false;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
