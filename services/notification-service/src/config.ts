import type { Policy } from "./worker.js";
import type { NotificationProviderConfig } from "./providers.js";

export interface Config {
  ownerEnvironment?: NodeJS.ProcessEnv;
  kafkaBrokers?: string[];
  flagSnapshot?: { url: string; token: string; allowInsecureHttp?: boolean };
  controlPlaneMeshHttp?: boolean;
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

// In EKS, application HTTP to a Kubernetes Service enters the local Envoy;
// strict Istio mTLS protects the pod-to-pod hop. Only this exact in-cluster
// control-plane endpoint may opt in. Public/plain HTTP remains forbidden for
// live notification providers.
function strictMeshControlPlaneHttp(url: URL, getenv: Getenv): boolean {
  return (
    getenv("GG_MESH_INTERNAL_HTTP") === "1" &&
    url.protocol === "http:" &&
    url.hostname === "tenant-control-plane.greenguard.svc.cluster.local" &&
    url.port === "3010" &&
    url.pathname === "/" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

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
  if ((!databaseUrl && !getenv("SHARD_REGISTRY_FILE")) || !rabbitUrl)
    throw new Error(
      "RABBITMQ_URL and either NOTIFICATIONS_DATABASE_URL or SHARD_REGISTRY_FILE are required",
    );
  const provider = getenv("NOTIFICATIONS_PROVIDER") ?? "local";
  if (
    provider !== "local" &&
    provider !== "unconfigured" &&
    provider !== "live"
  )
    throw new Error(
      "NOTIFICATIONS_PROVIDER must be local, unconfigured, or live",
    );
  const snapshotUrl = getenv("CONTROL_PLANE_URL");
  const snapshotToken = getenv("CONTROL_LOOKUP_TOKEN");
  if (!!snapshotUrl !== !!snapshotToken)
    throw new Error(
      "CONTROL_PLANE_URL and CONTROL_LOOKUP_TOKEN must be set together",
    );
  const insecureContactLookup = getenv(
    "NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP",
  );
  if (
    insecureContactLookup !== undefined &&
    !["true", "false"].includes(insecureContactLookup)
  )
    throw new Error(
      "NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP must be true or false",
    );
  const meshHttp = getenv("GG_MESH_INTERNAL_HTTP");
  if (meshHttp !== undefined && meshHttp !== "0" && meshHttp !== "1")
    throw new Error("GG_MESH_INTERNAL_HTTP must be 0 or 1");
  let allowedLiveMeshHttp = false;
  if (provider === "live" && snapshotUrl) {
    let lookupUrl: URL;
    try {
      lookupUrl = new URL(snapshotUrl);
    } catch {
      throw new Error(
        "CONTROL_PLANE_URL must use HTTPS for live notification providers",
      );
    }
    allowedLiveMeshHttp = strictMeshControlPlaneHttp(lookupUrl, getenv);
    if (lookupUrl.protocol !== "https:" && !allowedLiveMeshHttp)
      throw new Error(
        "CONTROL_PLANE_URL must use HTTPS or the exact strict-mesh control-plane URL for live notification providers",
      );
  }
  const providerTimeoutMs = positive(
    getenv,
    "NOTIFICATIONS_PROVIDER_TIMEOUT_MS",
    5000,
  );
  if (providerTimeoutMs > 120_000)
    throw new Error("NOTIFICATIONS_PROVIDER_TIMEOUT_MS must not exceed 120000");
  const sendgridApiKey = getenv("SENDGRID_API_KEY");
  const sendgridFrom = getenv("SENDGRID_FROM_EMAIL");
  const twilioSid = getenv("TWILIO_ACCOUNT_SID");
  const twilioToken = getenv("TWILIO_AUTH_TOKEN");
  const twilioFrom = getenv("TWILIO_FROM_NUMBER");
  if (
    provider === "live" &&
    (!snapshotUrl ||
      !snapshotToken ||
      !sendgridApiKey ||
      !sendgridFrom ||
      !twilioSid ||
      !twilioToken ||
      !twilioFrom)
  )
    throw new Error(
      "live notification providers require CONTROL_PLANE_URL, CONTROL_LOOKUP_TOKEN, SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER",
    );
  return {
    ownerEnvironment: Object.fromEntries(
      [
        "SHARD_REGISTRY_FILE",
        "SHARD_LOCAL_LOOPBACK",
        "CONTROL_PLANE_URL",
        "CONTROL_LOOKUP_TOKEN",
        "CONTROL_PLANE_MESH_MTLS",
        "GG_MESH_INTERNAL_HTTP",
      ].map((key) => [key, getenv(key)]),
    ),
    kafkaBrokers: getenv("KAFKA_BROKERS")
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    flagSnapshot:
      snapshotUrl && snapshotToken
        ? {
            url: snapshotUrl,
            token: snapshotToken,
            ...((provider !== "live" && insecureContactLookup === "true") ||
            allowedLiveMeshHttp
              ? { allowInsecureHttp: true }
              : {}),
          }
        : undefined,
    controlPlaneMeshHttp: allowedLiveMeshHttp,
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
      controlPlane:
        snapshotUrl && snapshotToken
          ? {
              url: snapshotUrl,
              token: snapshotToken,
              ...((provider !== "live" && insecureContactLookup === "true") ||
              allowedLiveMeshHttp
                ? { allowInsecureHttp: true }
                : {}),
            }
          : undefined,
      sendgrid:
        sendgridApiKey && sendgridFrom
          ? { apiKey: sendgridApiKey, fromEmail: sendgridFrom }
          : undefined,
      twilio:
        twilioSid && twilioToken && twilioFrom
          ? {
              accountSid: twilioSid,
              authToken: twilioToken,
              fromNumber: twilioFrom,
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
