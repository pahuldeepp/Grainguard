import { defineConfig } from "prisma/config";

// CLI commands (migrate, diff) connect directly as the table-owning migrator role,
// never through PgBouncer. Runtime code uses INVENTORY_DATABASE_URL instead.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: process.env.INVENTORY_MIGRATIONS_PATH ?? "prisma/migrations" },
  datasource: { url: process.env.INVENTORY_MIGRATION_URL ?? "" },
});
