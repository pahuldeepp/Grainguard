import { createDb } from "./db/client.js";
import { lookupMembership } from "./domain/store.js";
import { identityIdOf } from "./domain/ids.js";
import {
  enrollFirstAdmin,
  validateFirstAdminEnrollment,
} from "./enroll-first-admin.js";
import { verifyFirstAdminAccessToken } from "./enroll-first-admin-token.js";

export async function main(
  env: NodeJS.ProcessEnv,
  accessToken: string,
): Promise<string> {
  const outputFormat = env.ENROLL_OUTPUT_FORMAT || "text";
  if (outputFormat !== "text" && outputFormat !== "json")
    throw new Error("ENROLL_OUTPUT_FORMAT must be text or json");
  const tenantId = env.ENROLL_TENANT_ID;
  const issuer = required(env, "AUTH_ISSUER");
  const tokenMode = env.AUTH_TOKEN_MODE || "audience";
  if (tokenMode !== "audience" && tokenMode !== "cognito-access")
    throw new Error("AUTH_TOKEN_MODE must be audience or cognito-access");
  const input = validateFirstAdminEnrollment({
    issuer,
    // Filled only after OIDC signature, issuer, audience, expiry and claim
    // checks below have completed.
    subject: "pending-verification",
    tenantId,
    role: env.ENROLL_ROLE,
  });
  if (env.ENROLL_CONFIRM !== `${input.tenantId}:${issuer}`)
    throw new Error("ENROLL_CONFIRM must equal TENANT_ID:ISSUER");
  const databaseUrl = validateFirstAdminDatabaseUrl(
    required(env, "CONTROL_DATABASE_URL"),
  );

  const principal = await verifyFirstAdminAccessToken(
    accessToken,
    input.tenantId,
    {
      issuer,
      jwksUrl: required(env, "AUTH_JWKS_URL"),
      audience: env.AUTH_AUDIENCE || undefined,
      tokenMode,
      clientIds: (env.AUTH_COGNITO_CLIENT_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    },
  );
  const enrollment = validateFirstAdminEnrollment({
    issuer,
    subject: principal.subject,
    tenantId,
    role: env.ENROLL_ROLE,
  });
  if (env.ENROLL_CONFIRM !== `${enrollment.tenantId}:${enrollment.issuer}`)
    throw new Error("ENROLL_CONFIRM must equal TENANT_ID:ISSUER");

  const db = createDb(databaseUrl, 2);
  try {
    const status = await enrollFirstAdmin(db, enrollment);
    await waitForFirstAdminMembership(
      async () => lookupMembership(db, enrollment.issuer, enrollment.subject),
      enrollment,
      {
        timeoutMs: parseBoundedWait(
          env.ENROLL_WAIT_TIMEOUT_MS,
          900_000,
          10_000,
          3_600_000,
        ),
        pollIntervalMs: parseBoundedWait(
          env.ENROLL_WAIT_POLL_MS,
          2_000,
          250,
          10_000,
        ),
      },
    );
    return formatFirstAdminResult(enrollment, status, outputFormat);
  } finally {
    await db.$disconnect();
  }
}

// Called only after signature verification, enrollment and ACTIVE membership
// read-back. AI consumers receive the stable control-plane identity, never the
// Dex static-password UUID, raw subject, access token or database credentials.
export function formatFirstAdminResult(
  enrollment: { tenantId: string; issuer: string; subject: string },
  status: "provisioning" | "existing",
  outputFormat: "text" | "json",
): string {
  if (outputFormat === "text")
    return `OIDC first-admin enrollment: ACTIVE admin membership read-back verified (${status})`;
  return JSON.stringify({
    version: 1,
    tenant_id: enrollment.tenantId,
    user_id: identityIdOf(enrollment.issuer, enrollment.subject),
    issuer: enrollment.issuer,
    role: "admin",
    state: "active",
    enrollment: status,
  });
}

export function validateFirstAdminDatabaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CONTROL_DATABASE_URL must be a valid PostgreSQL URL");
  }
  const keys = [...url.searchParams.keys()].sort();
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    decodeURIComponent(url.username) !== "control_app" ||
    !decodeURIComponent(url.password) ||
    !url.hostname ||
    url.port !== "5432" ||
    url.pathname !== "/greenguard_control" ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    url.searchParams.get("sslrootcert") !== "/etc/greenguard/rds/ca.pem" ||
    keys.join("\0") !== ["sslmode", "sslrootcert"].join("\0")
  )
    throw new Error(
      "CONTROL_DATABASE_URL must use the control_app role, control database and mounted verified RDS CA",
    );
  return raw;
}

export interface FirstAdminMembershipReadback {
  tenantId: string;
  roles: string[];
  state: string;
}

export interface FirstAdminWaitOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function waitForFirstAdminMembership(
  lookup: () => Promise<FirstAdminMembershipReadback | null>,
  enrollment: { tenantId: string },
  options: FirstAdminWaitOptions,
): Promise<void> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > 3_600_000 ||
    !Number.isSafeInteger(options.pollIntervalMs) ||
    options.pollIntervalMs < 250 ||
    options.pollIntervalMs > 10_000
  )
    throw new Error("first-admin wait bounds are invalid");
  const now = options.now ?? Date.now;
  const pause =
    options.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + options.timeoutMs;
  while (true) {
    const membership = await lookup();
    if (membership?.state === "active") {
      if (
        membership.tenantId !== enrollment.tenantId ||
        !membership.roles.includes("admin")
      )
        throw new Error(
          "first-admin active membership read-back did not match requested tenant/admin",
        );
      return;
    }
    if (membership && membership.tenantId !== enrollment.tenantId)
      throw new Error(
        "verified identity is already attached to another tenant",
      );
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error(
        "timed out waiting for active first-admin membership read-back",
      );
    await pause(Math.min(options.pollIntervalMs, remaining));
  }
}

function parseBoundedWait(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    throw new Error("first-admin wait settings must be integer milliseconds");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(
      `first-admin wait setting must be between ${min} and ${max}ms`,
    );
  return parsed;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (
  process.argv[1]?.endsWith(
    "tenant-control-plane/dist/enroll-first-admin-cli.js",
  )
) {
  let token = "";
  for await (const chunk of process.stdin) {
    token += chunk;
    if (token.length > 16_384)
      throw new Error("OIDC access token exceeds maximum input size");
  }
  console.log(await main(process.env, token.trim()));
}
