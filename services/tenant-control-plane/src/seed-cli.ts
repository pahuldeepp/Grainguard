import { readFileSync } from "node:fs";
import { createDb } from "./db/client.js";
import { seedFromMembershipFile } from "./seed.js";

// npm run seed -w @greenguard/tenant-control-plane (as control_app, direct URL).
export async function main(env: NodeJS.ProcessEnv): Promise<string> {
  const url = env.CONTROL_DIRECT_URL;
  if (!url)
    throw new Error("CONTROL_DIRECT_URL is required (run make bootstrap)");
  const db = createDb(url, 2);
  try {
    const file =
      env.AUTH_MEMBERSHIP_FILE?.trim() || "../../infra/oidc/memberships.json";
    const result = await seedFromMembershipFile(db, readFileSync(file, "utf8"));
    return `seeded memberships: created=${result.created} existing=${result.existing}`;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1]?.endsWith("tenant-control-plane/dist/seed-cli.js"))
  console.log(await main(process.env));
