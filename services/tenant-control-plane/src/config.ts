import { readS3StorageConfig, type S3StorageConfig } from "@greenguard/audit";

export interface ControlPlaneConfig {
  databaseUrl: string;
  lookupToken: string;
  host: string;
  port: number;
  auth?:
    | {
        issuer: string;
        audience?: string;
        jwksUrl: string;
        tokenMode?: "cognito-access";
        cognitoClientIds?: string[];
      }
    | { issuers: { issuer: string; audience: string; jwksUrl: string }[] };
  otlpEndpoint?: string;
  apiKeyPepper?: string;
  apiKeyEnvironment?: string;
  m2m?: {
    issuer: string;
    audience: string;
    jwksUrl: string;
    tenantClaim: string;
  };
  /** Issuers a tenant admin may register machine clients for (ADR-0020); fail closed when empty. */
  machineIssuers?: string[];
  flagAdmin?: { token: string; actorId: string };
  audit?: {
    /** Filesystem backend (local/dev); absent when an S3 bucket is configured. */
    directory?: string;
    publicKeyPem: string;
    /** HMAC secret for the filesystem download route; unused with S3. */
    linkSecret?: string;
    inventoryDatabaseUrl: string;
    billingDatabaseUrl: string;
    /** S3-compatible object store; presigned downloads. */
    s3?: S3StorageConfig;
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function need(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value) return value;
  throw new Error(`${name} is required (run make bootstrap)`);
}

function readAuth(env: NodeJS.ProcessEnv): ControlPlaneConfig["auth"] {
  const tokenMode = env.AUTH_TOKEN_MODE || "audience";
  if (tokenMode !== "audience" && tokenMode !== "cognito-access")
    throw new Error("AUTH_TOKEN_MODE must be audience or cognito-access");
  if (env.AUTH_ISSUERS_JSON) {
    if (tokenMode !== "audience" || env.AUTH_COGNITO_CLIENT_IDS)
      throw new Error(
        "Cognito token mode requires single-issuer AUTH_* settings",
      );
    if (env.AUTH_ISSUER || env.AUTH_AUDIENCE || env.AUTH_JWKS_URL)
      throw new Error(
        "AUTH_ISSUERS_JSON cannot be combined with single-issuer AUTH_* settings",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.AUTH_ISSUERS_JSON);
    } catch {
      throw new Error("AUTH_ISSUERS_JSON must be valid JSON");
    }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16)
      throw new Error("AUTH_ISSUERS_JSON must contain 1-16 issuers");
    const seen = new Set<string>();
    const issuers = parsed.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("AUTH_ISSUERS_JSON contains an invalid issuer");
      const record = entry as Record<string, unknown>;
      if (
        Object.keys(record).some(
          (key) => !["issuer", "audience", "jwksUrl"].includes(key),
        ) ||
        typeof record.issuer !== "string" ||
        !record.issuer ||
        typeof record.audience !== "string" ||
        !record.audience ||
        typeof record.jwksUrl !== "string" ||
        !record.jwksUrl ||
        seen.has(record.issuer)
      )
        throw new Error(
          "AUTH_ISSUERS_JSON contains a duplicate or invalid issuer",
        );
      const issuerUrl = new URL(record.issuer);
      const jwks = new URL(record.jwksUrl);
      for (const url of [issuerUrl, jwks]) {
        if (
          url.protocol !== "https:" &&
          !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
        )
          throw new Error(
            "AUTH_ISSUERS_JSON issuer and JWKS URLs must use https unless loopback",
          );
      }
      seen.add(record.issuer);
      return {
        issuer: record.issuer,
        audience: record.audience,
        jwksUrl: jwks.toString(),
      };
    });
    return { issuers };
  }
  const {
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: jwks,
  } = env;
  const set = [issuer, jwks].filter(Boolean).length;
  if (set === 0 && !audience && tokenMode === "audience") {
    if (env.AUTH_COGNITO_CLIENT_IDS)
      throw new Error("AUTH_COGNITO_CLIENT_IDS requires cognito-access mode");
    return undefined;
  }
  if (set !== 2 || (tokenMode === "audience" && !audience))
    throw new Error(
      "AUTH_ISSUER, AUTH_AUDIENCE and AUTH_JWKS_URL must be set together",
    );
  const clientIds = (env.AUTH_COGNITO_CLIENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (tokenMode === "cognito-access" && !clientIds.length)
    throw new Error("AUTH_COGNITO_CLIENT_IDS is required for cognito-access");
  if (tokenMode === "audience" && clientIds.length)
    throw new Error("AUTH_COGNITO_CLIENT_IDS requires cognito-access mode");
  const url = new URL(jwks as string);
  if (url.protocol !== "https:" && !LOOPBACK.has(url.hostname))
    throw new Error(
      "AUTH_JWKS_URL must use https unless it is a loopback address",
    );
  return {
    issuer: issuer as string,
    ...(audience ? { audience } : {}),
    jwksUrl: url.toString(),
    ...(tokenMode === "cognito-access"
      ? { tokenMode, cognitoClientIds: clientIds }
      : {}),
  };
}

function readMachineIssuers(
  env: NodeJS.ProcessEnv,
  m2m: ControlPlaneConfig["m2m"],
): string[] | undefined {
  const listed = (env.MACHINE_ISSUER_ALLOWLIST ?? "")
    .split(",")
    .map((issuer) => issuer.trim())
    .filter(Boolean);
  if (listed.some((issuer) => !issuer.startsWith("https://")))
    throw new Error(
      "MACHINE_ISSUER_ALLOWLIST entries must be https:// issuers",
    );
  const issuers = listed.length ? listed : m2m ? [m2m.issuer] : [];
  return issuers.length ? issuers : undefined;
}

function readM2M(env: NodeJS.ProcessEnv): ControlPlaneConfig["m2m"] {
  const issuer = env.CONTROL_M2M_ISSUER,
    audience = env.CONTROL_M2M_AUDIENCE,
    jwks = env.CONTROL_M2M_JWKS_URL;
  const set = [issuer, audience, jwks].filter(Boolean).length;
  if (set === 0) return undefined;
  if (set !== 3)
    throw new Error(
      "CONTROL_M2M_ISSUER, CONTROL_M2M_AUDIENCE and CONTROL_M2M_JWKS_URL must be set together",
    );
  const url = new URL(jwks!);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  )
    throw new Error("CONTROL_M2M_JWKS_URL must use https unless loopback");
  const tenantClaim = env.CONTROL_M2M_TENANT_CLAIM || "gg_tenant";
  if (!/^[A-Za-z_][\w.-]{0,63}$/.test(tenantClaim))
    throw new Error("CONTROL_M2M_TENANT_CLAIM must be a valid claim name");
  return {
    issuer: issuer!,
    audience: audience!,
    jwksUrl: url.toString(),
    tenantClaim,
  };
}

function readAuditConfig(env: NodeJS.ProcessEnv): ControlPlaneConfig["audit"] {
  const {
    AUDIT_EXPORT_DIRECTORY: directory,
    AUDIT_EXPORT_PUBLIC_KEY_PEM: publicKey,
    AUDIT_EXPORT_LINK_SECRET: linkSecret,
    INVENTORY_DATABASE_URL: inventoryUrl,
    BILLING_DATABASE_URL: billingUrl,
  } = env;
  const s3 = readS3StorageConfig(env);
  const set = [directory, publicKey, linkSecret].filter(Boolean).length;
  if (s3 && !publicKey)
    throw new Error(
      "AUDIT_EXPORT_S3_BUCKET and AUDIT_EXPORT_PUBLIC_KEY_PEM must be set together",
    );
  if (!s3 && set !== 0 && set !== 3)
    throw new Error(
      "AUDIT_EXPORT_DIRECTORY, AUDIT_EXPORT_PUBLIC_KEY_PEM and AUDIT_EXPORT_LINK_SECRET must be set together",
    );
  const enabled = Boolean(s3) || set === 3;
  if (enabled && (!inventoryUrl || !billingUrl))
    throw new Error(
      "INVENTORY_DATABASE_URL and BILLING_DATABASE_URL are required when audit export is enabled",
    );
  if (linkSecret && Buffer.byteLength(linkSecret) < 32)
    throw new Error("AUDIT_EXPORT_LINK_SECRET must contain at least 32 bytes");
  if (!enabled) return undefined;
  const owners = {
    publicKeyPem: publicKey!,
    inventoryDatabaseUrl: inventoryUrl!,
    billingDatabaseUrl: billingUrl!,
  };
  return s3
    ? { ...owners, ...(linkSecret && { linkSecret }), s3 }
    : { directory: directory!, linkSecret: linkSecret!, ...owners };
}

export function readConfig(env: NodeJS.ProcessEnv): ControlPlaneConfig {
  const port = Number(env.PORT ?? 3010);
  const m2m = readM2M(env);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT must be an integer from 0 to 65535");
  if (
    env.CONTROL_API_KEY_PEPPER &&
    Buffer.byteLength(env.CONTROL_API_KEY_PEPPER) < 32
  )
    throw new Error("CONTROL_API_KEY_PEPPER must contain at least 32 bytes");
  if (
    env.CONTROL_API_KEY_ENV &&
    !/^[a-z0-9]{2,12}$/.test(env.CONTROL_API_KEY_ENV)
  )
    throw new Error(
      "CONTROL_API_KEY_ENV must be 2-12 lowercase letters or digits",
    );
  const flagAdminToken = env.CONTROL_FLAG_ADMIN_TOKEN;
  const flagAdminActorId = env.CONTROL_FLAG_ADMIN_ACTOR_ID;
  if (Boolean(flagAdminToken) !== Boolean(flagAdminActorId))
    throw new Error(
      "CONTROL_FLAG_ADMIN_TOKEN and CONTROL_FLAG_ADMIN_ACTOR_ID must be set together",
    );
  if (flagAdminToken && Buffer.byteLength(flagAdminToken) < 32)
    throw new Error("CONTROL_FLAG_ADMIN_TOKEN must contain at least 32 bytes");
  if (
    flagAdminActorId &&
    !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
      flagAdminActorId,
    )
  )
    throw new Error("CONTROL_FLAG_ADMIN_ACTOR_ID must be a UUID");
  const audit = readAuditConfig(env);
  const machineIssuers = readMachineIssuers(env, m2m);
  const databaseUrl = need(env, "CONTROL_DATABASE_URL");
  const lookupToken = need(env, "CONTROL_LOOKUP_TOKEN");
  if (Buffer.byteLength(lookupToken) < 32)
    throw new Error("CONTROL_LOOKUP_TOKEN must contain at least 32 bytes");
  return {
    databaseUrl,
    lookupToken,
    host: env.HOST || "127.0.0.1",
    port,
    auth: readAuth(env),
    ...(m2m && { m2m }),
    ...(machineIssuers && { machineIssuers }),
    ...(flagAdminToken &&
      flagAdminActorId && {
        flagAdmin: { token: flagAdminToken, actorId: flagAdminActorId },
      }),
    ...(audit && { audit }),
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    ...(env.CONTROL_API_KEY_PEPPER && {
      apiKeyPepper: env.CONTROL_API_KEY_PEPPER,
    }),
    ...(env.CONTROL_API_KEY_ENV && {
      apiKeyEnvironment: env.CONTROL_API_KEY_ENV,
    }),
  };
}
