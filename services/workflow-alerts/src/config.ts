import { secret } from "./api/identity.js";

export interface AlertsConfig {
  databaseUrl: string;
  host: string;
  port: number;
  auth?: {
    issuer: string;
    audience?: string;
    jwksUrl: string;
    tokenMode: "audience" | "cognito-access";
  };
  actorHmacKey?: string;
  historyCursorKey?: string;
  otlpEndpoint?: string;
  kafkaBrokers: string[];
  kafkaGroup: string;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required (run make bootstrap)`);
  return value;
};

// AUTH_* is all-or-nothing: a partial set is a deployment error, not "API off".
function authFrom(env: NodeJS.ProcessEnv): AlertsConfig["auth"] {
  const tokenMode = env.AUTH_TOKEN_MODE || "audience";
  if (tokenMode !== "audience" && tokenMode !== "cognito-access")
    throw new Error("AUTH_TOKEN_MODE must be audience or cognito-access");
  if (tokenMode === "audience" && env.AUTH_COGNITO_CLIENT_IDS)
    throw new Error("AUTH_COGNITO_CLIENT_IDS requires cognito-access mode");
  if (
    !env.AUTH_ISSUER &&
    !env.AUTH_AUDIENCE &&
    !env.AUTH_JWKS_URL &&
    tokenMode === "audience" &&
    !env.AUTH_COGNITO_CLIENT_IDS
  )
    return undefined;
  if (
    !env.AUTH_ISSUER ||
    !env.AUTH_JWKS_URL ||
    (tokenMode === "audience" && !env.AUTH_AUDIENCE)
  )
    throw new Error(
      "AUTH_ISSUER, AUTH_JWKS_URL and AUTH_AUDIENCE in audience mode must be set together",
    );
  if (tokenMode === "cognito-access" && !env.AUTH_COGNITO_CLIENT_IDS)
    throw new Error("cognito-access requires AUTH_COGNITO_CLIENT_IDS");
  if (
    tokenMode === "cognito-access" &&
    (env.AUTH_MEMBERSHIP_SOURCE !== "control-plane" ||
      !env.CONTROL_PLANE_URL ||
      !env.CONTROL_LOOKUP_TOKEN)
  )
    throw new Error(
      "cognito-access requires control-plane membership and lookup configuration",
    );
  const jwks = new URL(required(env, "AUTH_JWKS_URL"));
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(jwks.hostname);
  if (jwks.protocol !== "https:" && !loopback)
    throw new Error("AUTH_JWKS_URL must use https outside loopback");
  return {
    issuer: required(env, "AUTH_ISSUER"),
    audience: env.AUTH_AUDIENCE || undefined,
    jwksUrl: jwks.toString(),
    tokenMode,
  };
}

export function readConfig(env: NodeJS.ProcessEnv): AlertsConfig {
  const auth = authFrom(env);
  if (auth) {
    secret(env.ALERTS_ACTOR_HMAC_KEY, "ALERTS_ACTOR_HMAC_KEY");
    secret(env.ALERTS_HISTORY_CURSOR_KEY, "ALERTS_HISTORY_CURSOR_KEY");
  }
  const port = Number(env.PORT ?? 3004);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT must be an integer from 0 to 65535");
  return {
    databaseUrl: env.SHARD_REGISTRY_FILE
      ? (env.ALERTS_DATABASE_URL ?? "")
      : required(env, "ALERTS_DATABASE_URL"),
    host: env.HOST || "127.0.0.1",
    port,
    auth,
    actorHmacKey: env.ALERTS_ACTOR_HMAC_KEY,
    historyCursorKey: env.ALERTS_HISTORY_CURSOR_KEY,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    kafkaBrokers: (env.KAFKA_BROKERS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    kafkaGroup: env.ALERTS_KAFKA_GROUP || "workflow-alerts",
  };
}
