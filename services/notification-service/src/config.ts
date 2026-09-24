import type { Policy } from "./worker.js";

export interface Config {
  databaseUrl: string;
  rabbitUrl: string;
  httpPort: number;
  prefetch: number;
  providerConcurrency: number;
  provider: "local" | "unconfigured";
  policy: Policy;
}

type Getenv = (key: string) => string | undefined;

function positive(getenv: Getenv, key: string, fallback: number): number {
  const raw = getenv(key);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${key} must be a positive integer`);
  return value;
}

/** Reads configuration from an injected getenv so entry points stay testable. */
export function loadConfig(getenv: Getenv): Config {
  const databaseUrl = getenv("NOTIFICATIONS_DATABASE_URL") ?? "";
  const rabbitUrl = getenv("RABBITMQ_URL") ?? "";
  if (!databaseUrl || !rabbitUrl)
    throw new Error("NOTIFICATIONS_DATABASE_URL and RABBITMQ_URL are required");
  const provider = getenv("NOTIFICATIONS_PROVIDER") ?? "local";
  if (provider !== "local" && provider !== "unconfigured")
    throw new Error("NOTIFICATIONS_PROVIDER must be local or unconfigured");
  return {
    databaseUrl,
    rabbitUrl,
    provider,
    httpPort: positive(getenv, "NOTIFICATIONS_HTTP_PORT", 8096),
    prefetch: positive(getenv, "NOTIFICATIONS_MAX_IN_FLIGHT", 16),
    providerConcurrency: positive(
      getenv,
      "NOTIFICATIONS_PROVIDER_CONCURRENCY",
      4,
    ),
    policy: {
      maxAttempts: positive(getenv, "NOTIFICATIONS_MAX_ATTEMPTS", 5),
      maxReconciles: positive(getenv, "NOTIFICATIONS_MAX_RECONCILES", 3),
      baseBackoffMs: positive(getenv, "NOTIFICATIONS_BACKOFF_MS", 1000),
      maxBackoffMs: positive(getenv, "NOTIFICATIONS_MAX_BACKOFF_MS", 300000),
      providerTimeoutMs: positive(
        getenv,
        "NOTIFICATIONS_PROVIDER_TIMEOUT_MS",
        5000,
      ),
    },
  };
}
