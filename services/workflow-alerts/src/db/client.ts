import { createOwnerDatabase } from "@greenguard/membership-client/owner-db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";
import {
  recordPostgresQueryDuration,
  registerPostgresPool,
} from "@greenguard/otel";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

// Runtime traffic goes through PgBouncer (transaction pooling) as alerts_app.
const createClient = (url: string, max: number): Db => {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  });
  registerPostgresPool(pool, "workflow_alerts");
  const client = new PrismaClient({
    log: [{ emit: "event", level: "query" }],
    adapter: new PrismaPg(pool, { disposeExternalPool: true }),
  });
  client.$on("query", (event) => recordPostgresQueryDuration(event.duration));
  return client;
};

export function createDb(
  url: string,
  max = 10,
  env: NodeJS.ProcessEnv = process.env,
): Db {
  return createOwnerDatabase({
    legacyUrl: url,
    env,
    service: "workflow-alerts",
    database: "greenguard_alerts",
    roles: ["alerts_app"],
    create: (url) => createClient(url, max),
    close: (db) => db.$disconnect(),
  });
}
