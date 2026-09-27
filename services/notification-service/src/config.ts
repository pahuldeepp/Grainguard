import type { Policy } from "./worker.js";
import type { NotificationProviderConfig } from "./providers.js";

export interface Config {
  kafkaBrokers?: string[];
  flagSnapshot?: { url: string; token: string; allowInsecureHttp?: boolean };
  flagDynamo?: { tableName: string; region?: string; endpoint?: string };
  databaseUrl: string;
  rabbitUrl: string;
  httpPort: number;
  httpHost: string;
  prefetch: number;
  providerConcurrency: number;
  provider: "local" | "unconfigured" | "live";
  notificationProviders: NotificationProviderConfig;
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

interface SnapshotConfig {
  url: string;
  token: string;
  allowInsecureHttp?: boolean;
}

function snapshotConfig(
  getenv: Getenv,
  provider: Config["provider"],
): SnapshotConfig | undefined {
  const url = getenv("CONTROL_PLANE_URL");
  const token = getenv("CONTROL_LOOKUP_TOKEN");
  if (Boolean(url) !== Boolean(token))
    throw new Error(
      "CONTROL_PLANE_URL and CONTROL_LOOKUP_TOKEN must be set together",
    );
  const insecure = getenv("NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP");
  if (insecure !== undefined && insecure !== "true" && insecure !== "false")
    throw new Error(
      "NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP must be true or false",
    );
  if (!url || !token) return undefined;
  if (provider === "live" && !usesHttps(url))
    throw new Error(
      "CONTROL_PLANE_URL must use HTTPS for live notification providers",
    );
  return {
    url,
    token,
    ...(provider !== "live" && insecure === "true"
      ? { allowInsecureHttp: true }
      : {}),
  };
}

function usesHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function liveProviderCredentials(getenv: Getenv, snapshot?: SnapshotConfig) {
  const sendgridApiKey = getenv("SENDGRID_API_KEY");
  const sendgridFrom = getenv("SENDGRID_FROM_EMAIL");
  const twilioSid = getenv("TWILIO_ACCOUNT_SID");
  const twilioToken = getenv("TWILIO_AUTH_TOKEN");
  const twilioFrom = getenv("TWILIO_FROM_NUMBER");
  const complete = Boolean(
    snapshot &&
    sendgridApiKey &&
    sendgridFrom &&
    twilioSid &&
    twilioToken &&
    twilioFrom,
  );
  return {
    sendgridApiKey,
    sendgridFrom,
    twilioSid,
    twilioToken,
    twilioFrom,
    complete,
  };
}

function selectedProvider(getenv: Getenv): Config["provider"] {
  const provider = getenv("NOTIFICATIONS_PROVIDER") ?? "local";
  if (
    provider !== "local" &&
    provider !== "unconfigured" &&
    provider !== "live"
  )
    throw new Error(
      "NOTIFICATIONS_PROVIDER must be local, unconfigured, or live",
    );
  return provider;
}

/** Reads configuration from an injected getenv so entry points stay testable. */
export function loadConfig(getenv: Getenv): Config {
  const databaseUrl = getenv("NOTIFICATIONS_DATABASE_URL") ?? "";
  const rabbitUrl = getenv("RABBITMQ_URL") ?? "";
  if (!databaseUrl || !rabbitUrl)
    throw new Error("NOTIFICATIONS_DATABASE_URL and RABBITMQ_URL are required");
  const provider = selectedProvider(getenv);
  const snapshot = snapshotConfig(getenv, provider);
  const providerTimeoutMs = positive(
    getenv,
    "NOTIFICATIONS_PROVIDER_TIMEOUT_MS",
    5000,
  );
  if (providerTimeoutMs > 120_000)
    throw new Error("NOTIFICATIONS_PROVIDER_TIMEOUT_MS must not exceed 120000");
  const credentials = liveProviderCredentials(getenv, snapshot);
  if (provider === "live" && !credentials.complete)
    throw new Error(
      "live notification providers require CONTROL_PLANE_URL, CONTROL_LOOKUP_TOKEN, SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER",
    );
  return {
    kafkaBrokers: getenv("KAFKA_BROKERS")
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    flagSnapshot: snapshot,
    flagDynamo: getenv("FLAG_DYNAMODB_TABLE")
      ? {
          tableName: getenv("FLAG_DYNAMODB_TABLE")!,
          ...(getenv("AWS_REGION") ? { region: getenv("AWS_REGION") } : {}),
          ...(getenv("DYNAMODB_ENDPOINT")
            ? { endpoint: getenv("DYNAMODB_ENDPOINT") }
            : {}),
        }
      : undefined,
    databaseUrl,
    rabbitUrl,
    provider,
    notificationProviders: {
      timeoutMs: providerTimeoutMs,
      controlPlane: snapshot,
      sendgrid:
        credentials.sendgridApiKey && credentials.sendgridFrom
          ? {
              apiKey: credentials.sendgridApiKey,
              fromEmail: credentials.sendgridFrom,
            }
          : undefined,
      twilio:
        credentials.twilioSid &&
        credentials.twilioToken &&
        credentials.twilioFrom
          ? {
              accountSid: credentials.twilioSid,
              authToken: credentials.twilioToken,
              fromNumber: credentials.twilioFrom,
            }
          : undefined,
    },
    httpPort: positive(getenv, "NOTIFICATIONS_HTTP_PORT", 8096),
    httpHost: getenv("NOTIFICATIONS_HTTP_HOST") ?? "127.0.0.1",
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
      providerTimeoutMs,
    },
  };
}
