import { createServer, type Server } from "node:http";
import {
  createContactsProjectorMetrics,
  createDynamoContactsProjectionStore,
  startContactsProjector,
  contactsProjectorReady,
} from "./contacts-cdc.js";

export class ProjectorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectorConfigurationError";
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ProjectorConfigurationError(`${name} is required`);
  return value;
}

export function positivePort(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ProjectorConfigurationError(
      "CONTACTS_PROJECTOR_HTTP_PORT must be a valid port",
    );
  return port;
}

export function projectorStartupFailure(error: unknown): {
  error_name: string;
  error_code?: string;
  message?: string;
} {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    error_name: name,
    ...(typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
      ? { error_code: code }
      : {}),
    ...(error instanceof ProjectorConfigurationError
      ? { message: error.message }
      : {}),
  };
}

export async function listenWithCleanup(
  server: Server,
  port: number,
  host: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

export async function main(): Promise<void> {
  const brokers = required("KAFKA_BROKERS")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (brokers.length === 0)
    throw new ProjectorConfigurationError(
      "KAFKA_BROKERS must include at least one broker",
    );
  const tableName = required("NOTIFICATION_STATE_TABLE");
  const schemaRegistryUrl = required("SCHEMA_REGISTRY_URL");
  const endpoint = process.env.DYNAMODB_ENDPOINT?.trim();
  const region = process.env.AWS_REGION?.trim() || "us-east-1";
  const port = positivePort(process.env.CONTACTS_PROJECTOR_HTTP_PORT, 8097);
  const store = createDynamoContactsProjectionStore({
    tableName,
    region,
    ...(endpoint && { endpoint }),
    ...(process.env.DYNAMODB_LOCAL_CREDENTIALS === "true" && {
      localCredentials: true,
    }),
  });
  const metrics = createContactsProjectorMetrics();
  const stopConsumer = startContactsProjector(store, brokers, metrics, {
    schemaRegistryUrl,
    onUnavailable: () => {
      // Never emit the failing Kafka/DynamoDB payload or exception details.
      console.error(
        "notification contacts CDC consumer unavailable; retry scheduled",
      );
    },
  });
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.statusCode = 200;
      response.end("ok\n");
      return;
    }
    if (request.url === "/readyz") {
      const ready = contactsProjectorReady(metrics);
      response.statusCode = ready ? 200 : 503;
      response.end(ready ? "ready\n" : "contact CDC heartbeat stale\n");
      return;
    }
    if (request.url === "/metrics") {
      response.setHeader(
        "content-type",
        "text/plain; version=0.0.4; charset=utf-8",
      );
      response.end(metrics.render());
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listenWithCleanup(
    server,
    port,
    process.env.CONTACTS_PROJECTOR_HTTP_HOST ?? "0.0.0.0",
    async () => {
      await stopConsumer();
      store.close();
    },
  );

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= stopProjector(server, stopConsumer, store.close.bind(store));
    return stopping;
  };
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
}

export async function stopProjector(
  server: Server,
  stopConsumer: () => Promise<void>,
  closeStore: () => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await stopConsumer();
  closeStore();
}

if (process.argv[1]?.endsWith("contacts-projector-main.js")) {
  try {
    await main();
  } catch (error) {
    console.error(
      "notification contacts projector failed to start",
      projectorStartupFailure(error),
    );
    process.exitCode = 1;
  }
}
