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
export const createDb = (url: string, max = 10): Db => {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 2000,
  });
  registerPostgresPool(pool, "workflow_alerts");
  const client = new PrismaClient({
    log: [{ emit: "event", level: "query" }],
    adapter: new PrismaPg(pool, { disposeExternalPool: true }),
  });
  client.$on("query", (event) => recordPostgresQueryDuration(event.duration));
  return client;
};
