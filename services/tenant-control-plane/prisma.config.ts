import { defineConfig } from "prisma/config";

// CLI commands (migrate, diff) connect directly as the table-owning migrator role,
// never through PgBouncer. Runtime code uses CONTROL_DATABASE_URL instead.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.CONTROL_MIGRATION_URL ?? "" },
});
