export interface AlertsConfig {
  databaseUrl: string;
  host: string;
  port: number;
  auth?: { issuer: string; audience: string; jwksUrl: string };
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
  const names = ["AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URL"];
  const present = names.filter((n) => env[n]);
  if (present.length === 0) return undefined;
  if (present.length < names.length)
    throw new Error(`${names.join(", ")} must be set together`);
  const jwks = new URL(required(env, "AUTH_JWKS_URL"));
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(jwks.hostname);
  if (jwks.protocol !== "https:" && !loopback)
    throw new Error("AUTH_JWKS_URL must use https outside loopback");
  return {
    issuer: required(env, "AUTH_ISSUER"),
    audience: required(env, "AUTH_AUDIENCE"),
    jwksUrl: jwks.toString(),
  };
}

export function readConfig(env: NodeJS.ProcessEnv): AlertsConfig {
  const port = Number(env.PORT ?? 3004);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT must be an integer from 0 to 65535");
  return {
    databaseUrl: required(env, "ALERTS_DATABASE_URL"),
    host: env.HOST || "127.0.0.1",
    port,
    auth: authFrom(env),
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    kafkaBrokers: (env.KAFKA_BROKERS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    kafkaGroup: env.ALERTS_KAFKA_GROUP || "workflow-alerts",
  };
}
