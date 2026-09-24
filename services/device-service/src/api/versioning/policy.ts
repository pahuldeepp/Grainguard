export interface ApiVersionPolicy {
  version: string;
  deprecatedAt?: Date;
  sunsetAt?: Date;
  successor?: string;
  documentationUrl?: string;
}

export interface VersionRegistry {
  defaultVersion: string;
  versions: ApiVersionPolicy[];
}

export interface ResolvedVersion {
  version: string;
  policy: ApiVersionPolicy;
  state: "current" | "deprecated";
}

export type ResolveResult =
  | { kind: "ok"; resolved: ResolvedVersion }
  | { kind: "unsupported"; requested: string }
  | { kind: "sunset"; policy: ApiVersionPolicy };

export const DEFAULT_REGISTRY: VersionRegistry = {
  defaultVersion: "1",
  versions: [{ version: "1" }],
};

const VERSION_PATTERN = /^[\w.-]{1,32}$/;
const ENV_NAME = "API_VERSION_POLICY";

function parseDate(
  value: unknown,
  field: string,
  version: string,
): Date | undefined {
  if (value === undefined) return undefined;
  const date =
    typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      `${ENV_NAME}: version "${version}" has an invalid ${field}`,
    );
  }
  return date;
}

function parseOptionalString(
  value: unknown,
  field: string,
  version: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new TypeError(
      `${ENV_NAME}: version "${version}" has an invalid ${field}`,
    );
  }
  return value;
}

function parsePolicy(entry: unknown): ApiVersionPolicy {
  const raw = (
    typeof entry === "object" && entry !== null ? entry : {}
  ) as Record<string, unknown>;
  const version = raw.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(
      `${ENV_NAME}: every version needs a valid "version" string`,
    );
  }
  const policy: ApiVersionPolicy = { version };
  const deprecatedAt = parseDate(raw.deprecatedAt, "deprecatedAt", version);
  const sunsetAt = parseDate(raw.sunsetAt, "sunsetAt", version);
  if (deprecatedAt && sunsetAt && sunsetAt < deprecatedAt) {
    throw new Error(
      `${ENV_NAME}: version "${version}" sunsetAt is earlier than deprecatedAt`,
    );
  }
  if (deprecatedAt) policy.deprecatedAt = deprecatedAt;
  if (sunsetAt) policy.sunsetAt = sunsetAt;
  const successor = parseOptionalString(raw.successor, "successor", version);
  if (successor) policy.successor = successor;
  const documentationUrl = parseOptionalString(
    raw.documentationUrl,
    "documentationUrl",
    version,
  );
  if (documentationUrl) policy.documentationUrl = documentationUrl;
  return policy;
}

export function loadVersionRegistry(env: NodeJS.ProcessEnv): VersionRegistry {
  const source = env[ENV_NAME];
  if (source === undefined) return DEFAULT_REGISTRY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${ENV_NAME} is not valid JSON`);
  }
  const raw = (
    typeof parsed === "object" && parsed !== null ? parsed : {}
  ) as Record<string, unknown>;
  if (typeof raw.defaultVersion !== "string" || !Array.isArray(raw.versions)) {
    throw new TypeError(
      `${ENV_NAME} must contain defaultVersion and a versions array`,
    );
  }
  const versions = raw.versions.map(parsePolicy);
  const names = new Set<string>();
  for (const policy of versions) {
    if (names.has(policy.version)) {
      throw new Error(`${ENV_NAME}: duplicate version "${policy.version}"`);
    }
    names.add(policy.version);
  }
  if (!names.has(raw.defaultVersion)) {
    throw new Error(
      `${ENV_NAME}: defaultVersion "${raw.defaultVersion}" is not in versions`,
    );
  }
  for (const policy of versions) {
    if (policy.successor && !names.has(policy.successor)) {
      throw new Error(
        `${ENV_NAME}: successor "${policy.successor}" of "${policy.version}" is not in versions`,
      );
    }
  }
  return { defaultVersion: raw.defaultVersion, versions };
}

export function isSunset(policy: ApiVersionPolicy, now: Date): boolean {
  return policy.sunsetAt !== undefined && now >= policy.sunsetAt;
}

export function resolveVersion(
  header: string | undefined,
  registry: VersionRegistry,
  now: Date,
): ResolveResult {
  const requested =
    header === undefined ? registry.defaultVersion : header.trim();
  const policy = VERSION_PATTERN.test(requested)
    ? registry.versions.find((candidate) => candidate.version === requested)
    : undefined;
  if (!policy)
    return { kind: "unsupported", requested: requested.slice(0, 64) };
  if (isSunset(policy, now)) return { kind: "sunset", policy };
  const deprecated =
    policy.sunsetAt !== undefined ||
    (policy.deprecatedAt !== undefined && now >= policy.deprecatedAt);
  return {
    kind: "ok",
    resolved: {
      version: policy.version,
      policy,
      state: deprecated ? "deprecated" : "current",
    },
  };
}
