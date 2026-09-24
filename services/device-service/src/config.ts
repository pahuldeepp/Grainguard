export interface AuthConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
}
export interface OtelConfig {
  otlpEndpoint: string;
  sampleRatio: number;
}
export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  auth?: AuthConfig;
  otel?: OtelConfig;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The API is mounted only when all three AUTH_* settings are present; a partial
// set is a deployment mistake and must not silently leave the API disabled.
function readAuth(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  const {
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: jwksUrl,
  } = env;
  if (!issuer && !audience && !jwksUrl) return undefined;
  if (!issuer || !audience || !jwksUrl)
    throw new Error(
      "AUTH_ISSUER, AUTH_AUDIENCE and AUTH_JWKS_URL must be set together",
    );
  const url = new URL(jwksUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  )
    throw new Error(
      "AUTH_JWKS_URL must use https (http is allowed only for loopback)",
    );
  return { issuer, audience, jwksUrl };
}
// Tracing is on only when a collector endpoint is configured.
function readOtel(env: NodeJS.ProcessEnv): OtelConfig | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL");
  const sampleRatio = Number(env.OTEL_TRACES_SAMPLE_RATIO ?? 1);
  if (!(sampleRatio >= 0 && sampleRatio <= 1))
    throw new Error("OTEL_TRACES_SAMPLE_RATIO must be a number from 0 to 1");
  return { otlpEndpoint: endpoint, sampleRatio };
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const databaseUrl = env.INVENTORY_DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      "INVENTORY_DATABASE_URL is required. Run make bootstrap and make dev.",
    );
  const auth = readAuth(env);
  const otel = readOtel(env);
  return {
    databaseUrl,
    port: Number(env.PORT || 3001),
    host: env.HOST || "127.0.0.1",
    ...(auth && { auth }),
    ...(otel && { otel }),
  };
}
