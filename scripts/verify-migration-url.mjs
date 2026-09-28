// Migration images run this before Prisma. Keep credentials out of diagnostics.
const envKey = process.argv[2];
if (!/^[A-Z][A-Z0-9_]*_MIGRATION_URL$/.test(envKey ?? "")) {
  console.error("A migration URL environment key is required");
  process.exit(1);
}

let valid = false;
try {
  const parsed = new URL(process.env[envKey] ?? "");
  valid =
    ["postgres:", "postgresql:"].includes(parsed.protocol) &&
    Boolean(parsed.hostname) &&
    Boolean(parsed.username) &&
    Boolean(parsed.pathname.slice(1)) &&
    parsed.searchParams.get("sslmode") === "verify-full" &&
    parsed.searchParams.get("sslrootcert") === "/rds-ca/ca.pem";
} catch {
  // Invalid URL is reported without echoing its contents.
}
if (!valid) {
  console.error(
    `${envKey} must be a direct PostgreSQL owner URL with verified RDS TLS`,
  );
  process.exit(1);
}
