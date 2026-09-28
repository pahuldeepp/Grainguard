import { createDb } from "./db/client.js";
import {
  enrollFirstCognitoAdmin,
  validateCognitoEnrollment,
} from "./enroll-cognito.js";

export async function main(env: NodeJS.ProcessEnv): Promise<string> {
  const input = validateCognitoEnrollment({
    issuer: env.ENROLL_ISSUER,
    subject: env.ENROLL_SUBJECT,
    tenantId: env.ENROLL_TENANT_ID,
    role: env.ENROLL_ROLE,
  });
  if (env.ENROLL_CONFIRM !== `${input.tenantId}:${input.subject}`)
    throw new Error("ENROLL_CONFIRM must equal TENANT_ID:SUBJECT");
  if (!env.CONTROL_DIRECT_URL)
    throw new Error("CONTROL_DIRECT_URL is required");
  const db = createDb(env.CONTROL_DIRECT_URL, 2);
  try {
    const status = await enrollFirstCognitoAdmin(db, input);
    return `Cognito first-admin enrollment: ${status}`;
  } finally {
    await db.$disconnect();
  }
}

if (
  process.argv[1]?.endsWith("tenant-control-plane/dist/enroll-cognito-cli.js")
)
  console.log(await main(process.env));
