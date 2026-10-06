import { requireShardRegistry } from "@greenguard/membership-client/owner-db";

export interface AuthConfig {
  issuer: string;
  audience?: string;
  jwksUrl: string;
  tokenMode: "audience" | "cognito-access";
}
export interface OtelConfig {
  otlpEndpoint: string;
  sampleRatio: number;
}
export interface ImportAuthConfig {
  sourceId: string;
  issuer: string;
  audience: string;
  jwksUrl: string;
  tenantClaim: string;
  controlUrl: string;
  lookupToken: string;
}
export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  auth?: AuthConfig;
  importAuth?: ImportAuthConfig;
  otel?: OtelConfig;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function meshServiceHttp(url: URL, env: NodeJS.ProcessEnv): boolean {
  return (
    env.GG_MESH_INTERNAL_HTTP === "1" &&
    url.protocol === "http:" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    /^(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.){2}svc(?:\.cluster\.local)?$/.test(
      url.hostname,
    )
  );
}

// The API is mounted only when all three AUTH_* settings are present; a partial
// set is a deployment mistake and must not silently leave the API disabled.
function readAuth(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  const {
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: jwksUrl,
  } = env;
  const tokenMode = env.AUTH_TOKEN_MODE || "audience";
  if (tokenMode !== "audience" && tokenMode !== "cognito-access")
    throw new Error("AUTH_TOKEN_MODE must be audience or cognito-access");
  if (tokenMode === "audience" && env.AUTH_COGNITO_CLIENT_IDS)
    throw new Error("AUTH_COGNITO_CLIENT_IDS requires cognito-access mode");
  if (
    !issuer &&
    !audience &&
    !jwksUrl &&
    tokenMode === "audience" &&
    !env.AUTH_COGNITO_CLIENT_IDS
  )
    return undefined;
  if (!issuer || !jwksUrl || (tokenMode === "audience" && !audience))
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
  const url = new URL(jwksUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  )
    throw new Error(
      "AUTH_JWKS_URL must use https (http is allowed only for loopback)",
    );
  return { issuer, audience, jwksUrl, tokenMode };
}
function readImportAuth(env: NodeJS.ProcessEnv): ImportAuthConfig | undefined {
  const importNames = [
    "IMPORT_SOURCE_ID",
    "IMPORT_AUTH_ISSUER",
    "IMPORT_AUTH_AUDIENCE",
    "IMPORT_AUTH_JWKS_URL",
    "IMPORT_AUTH_TENANT_CLAIM",
  ] as const;
  const names = [
    "IMPORT_SOURCE_ID",
    "IMPORT_AUTH_ISSUER",
    "IMPORT_AUTH_AUDIENCE",
    "IMPORT_AUTH_JWKS_URL",
    "IMPORT_AUTH_TENANT_CLAIM",
    "CONTROL_LOOKUP_URL",
    "CONTROL_LOOKUP_TOKEN",
  ] as const;
  if (
    importNames.every((name) => env[name] === undefined) &&
    env.CONTROL_LOOKUP_URL === undefined
  )
    return undefined;
  if (names.some((name) => !env[name]))
    throw new Error("import authentication settings must be set together");
  const jwksUrl = new URL(env.IMPORT_AUTH_JWKS_URL!);
  const controlUrl = new URL(env.CONTROL_LOOKUP_URL!);
  for (const url of [jwksUrl, controlUrl])
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && LOOPBACK.has(url.hostname)) &&
      !(url === controlUrl && meshServiceHttp(url, env))
    )
      throw new Error(
        "import JWKS and control lookup must use https (loopback http allowed)",
      );
  if (
    jwksUrl.username ||
    jwksUrl.password ||
    controlUrl.username ||
    controlUrl.password ||
    controlUrl.search ||
    controlUrl.hash
  )
    throw new Error(
      "import endpoints cannot contain credentials or query strings",
    );
  if (Buffer.byteLength(env.CONTROL_LOOKUP_TOKEN!) < 32)
    throw new Error("CONTROL_LOOKUP_TOKEN must hold at least 32 bytes");
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(env.IMPORT_AUTH_TENANT_CLAIM!))
    throw new Error("IMPORT_AUTH_TENANT_CLAIM is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(env.IMPORT_SOURCE_ID!))
    throw new Error("IMPORT_SOURCE_ID is invalid");
  return {
    sourceId: env.IMPORT_SOURCE_ID!,
    issuer: env.IMPORT_AUTH_ISSUER!,
    audience: env.IMPORT_AUTH_AUDIENCE!,
    jwksUrl: jwksUrl.toString(),
    tenantClaim: env.IMPORT_AUTH_TENANT_CLAIM!,
    controlUrl: controlUrl.toString(),
    lookupToken: env.CONTROL_LOOKUP_TOKEN!,
  };
}
function readImportAuth(env: NodeJS.ProcessEnv): ImportAuthConfig | undefined {
  const importNames = [
    "IMPORT_SOURCE_ID",
    "IMPORT_AUTH_ISSUER",
    "IMPORT_AUTH_AUDIENCE",
    "IMPORT_AUTH_JWKS_URL",
    "IMPORT_AUTH_TENANT_CLAIM",
  ] as const;
  const names = [
    "IMPORT_SOURCE_ID",
    "IMPORT_AUTH_ISSUER",
    "IMPORT_AUTH_AUDIENCE",
    "IMPORT_AUTH_JWKS_URL",
    "IMPORT_AUTH_TENANT_CLAIM",
    "CONTROL_LOOKUP_URL",
    "CONTROL_LOOKUP_TOKEN",
  ] as const;
  if (
    importNames.every((name) => env[name] === undefined) &&
    env.CONTROL_LOOKUP_URL === undefined
  )
    return undefined;
  if (names.some((name) => !env[name]))
    throw new Error("import authentication settings must be set together");
  const jwksUrl = new URL(env.IMPORT_AUTH_JWKS_URL!);
  const controlUrl = new URL(env.CONTROL_LOOKUP_URL!);
  for (const url of [jwksUrl, controlUrl])
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
    )
      throw new Error(
        "import JWKS and control lookup must use https (loopback http allowed)",
      );
  if (
    jwksUrl.username ||
    jwksUrl.password ||
    controlUrl.username ||
    controlUrl.password ||
    controlUrl.search ||
    controlUrl.hash
  )
    throw new Error(
      "import endpoints cannot contain credentials or query strings",
    );
  if (Buffer.byteLength(env.CONTROL_LOOKUP_TOKEN!) < 32)
    throw new Error("CONTROL_LOOKUP_TOKEN must hold at least 32 bytes");
  if (!/^[A-Za-z_]\w{0,63}$/.test(env.IMPORT_AUTH_TENANT_CLAIM!))
    throw new Error("IMPORT_AUTH_TENANT_CLAIM is invalid");
  if (!/^[A-Za-z\d][\w.:-]{0,127}$/.test(env.IMPORT_SOURCE_ID!))
    throw new Error("IMPORT_SOURCE_ID is invalid");
  return {
    sourceId: env.IMPORT_SOURCE_ID!,
    issuer: env.IMPORT_AUTH_ISSUER!,
    audience: env.IMPORT_AUTH_AUDIENCE!,
    jwksUrl: jwksUrl.toString(),
    tenantClaim: env.IMPORT_AUTH_TENANT_CLAIM!,
    controlUrl: controlUrl.toString(),
    lookupToken: env.CONTROL_LOOKUP_TOKEN!,
  };
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
  requireShardRegistry(env);
  const databaseUrl = env.INVENTORY_DATABASE_URL ?? "";
  if (!databaseUrl && !env.SHARD_REGISTRY_FILE)
    throw new Error(
      "INVENTORY_DATABASE_URL is required. Run make bootstrap and make dev.",
    );
  const auth = readAuth(env);
  const importAuth = readImportAuth(env);
  const otel = readOtel(env);
  return {
    databaseUrl,
    port: Number(env.PORT || 3001),
    host: env.HOST || "127.0.0.1",
    ...(auth && { auth }),
    ...(importAuth && { importAuth }),
    ...(otel && { otel }),
  };
}
