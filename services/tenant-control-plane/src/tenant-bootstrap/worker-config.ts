import { isIP } from "node:net";

export interface TenantBootstrapWorkerConfig {
  databaseUrl: string;
  pollIntervalMs: number;
  errorBackoffMs: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function readTenantBootstrapWorkerConfig(
  env: NodeJS.ProcessEnv,
): TenantBootstrapWorkerConfig {
  const raw = env.CONTROL_BOOTSTRAP_DATABASE_URL;
  if (!raw) throw new Error("CONTROL_BOOTSTRAP_DATABASE_URL is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "CONTROL_BOOTSTRAP_DATABASE_URL must be a valid PostgreSQL URL",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    decodeURIComponent(url.username) !== "tenant_bootstrap_worker" ||
    !decodeURIComponent(url.password) ||
    url.pathname !== "/greenguard_control"
  )
    throw new Error(
      "bootstrap worker must use tenant_bootstrap_worker on greenguard_control",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    LOOPBACK.has(host) || (isIP(host) === 4 && host.startsWith("127."));
  if (
    !loopback &&
    (url.searchParams.get("sslmode") !== "verify-full" ||
      !url.searchParams.get("sslrootcert")?.startsWith("/"))
  )
    throw new Error(
      "non-loopback bootstrap worker DB URLs require sslmode=verify-full and sslrootcert",
    );
  return {
    databaseUrl: raw,
    pollIntervalMs: parseBoundedInt(
      env.CONTROL_BOOTSTRAP_POLL_MS,
      5_000,
      500,
      60_000,
    ),
    errorBackoffMs: parseBoundedInt(
      env.CONTROL_BOOTSTRAP_ERROR_BACKOFF_MS,
      5_000,
      500,
      60_000,
    ),
  };
}

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    throw new Error("bootstrap worker intervals must be integer milliseconds");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(
      `bootstrap worker interval must be between ${min} and ${max}ms`,
    );
  return parsed;
}
