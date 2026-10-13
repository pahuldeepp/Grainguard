import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolConfig } from "pg";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

// Runtime traffic: control_app through PgBouncer transaction pooling.
export function createDb(connectionString: string, max = 10): Db {
  const adapter = new PrismaPg({
    connectionString,
    max,
    connectionTimeoutMillis: 2000,
  });
  return new PrismaClient({ adapter });
}

/** Every fresh pooled backend executes SET ROLE before Prisma can acquire it. */
export function bootstrapWorkerPoolConfig(
  connectionString: string,
  max = 4,
): PoolConfig {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("bootstrap worker database URL must use PostgreSQL");
  const options = url.searchParams.get("options")?.trim() ?? "";
  if (/\brole\s*=/.test(options))
    throw new Error(
      "bootstrap worker database URL cannot override its session role",
    );
  return {
    connectionString,
    max,
    connectionTimeoutMillis: 2_000,
    onConnect: async (client) => {
      await client.query("SET ROLE control_bootstrap_worker_role");
    },
  };
}

export function createBootstrapWorkerDb(connectionString: string, max = 4): Db {
  const pool = new Pool(bootstrapWorkerPoolConfig(connectionString, max));
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return new PrismaClient({ adapter });
}
