import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

/**
 * Applies forward-only SQL migrations in file order, each in its own transaction, under a
 * session advisory lock (so it needs a direct connection as notifications_migrator).
 */
export async function migrate(
  url: string,
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('greenguard_notifications_migrate'))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (
        await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations",
        )
      ).rows.map((r) => r.version),
    );
    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .toSorted((a, b) => a.localeCompare(b));
    for (const file of files.filter((f) => !done.has(f))) {
      await applyOne(client, file, await readFile(`${dir}/${file}`, "utf8"));
      applied.push(file);
    }
    return applied;
  } finally {
    await client.end();
  }
}

async function applyOne(
  client: pg.Client,
  version: string,
  sql: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
      version,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrate(
  getenv = (k: string) => process.env[k],
): Promise<string[]> {
  const url = getenv("NOTIFICATIONS_MIGRATION_URL");
  if (!url) throw new Error("NOTIFICATIONS_MIGRATION_URL is required");
  return migrate(url);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const applied = await runMigrate();
    console.log(`notification migrations applied: ${applied.length}`);
  } catch (error) {
    console.error("notification migration failed", error);
    process.exit(1);
  }
}
