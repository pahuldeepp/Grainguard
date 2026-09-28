import { createDb } from "./db/client.js";
import {
  enrollFirstAdmin,
  validateFirstAdminEnrollment,
} from "./enroll-first-admin.js";
import { verifyFirstAdminAccessToken } from "./enroll-first-admin-token.js";

export async function main(
  env: NodeJS.ProcessEnv,
  accessToken: string,
): Promise<string> {
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
  if (!env.CONTROL_DIRECT_URL)
    throw new Error("CONTROL_DIRECT_URL is required");

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

  const db = createDb(env.CONTROL_DIRECT_URL, 2);
  try {
    const status = await enrollFirstAdmin(db, enrollment);
    return `OIDC first-admin enrollment: ${status}`;
  } finally {
    await db.$disconnect();
  }
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
