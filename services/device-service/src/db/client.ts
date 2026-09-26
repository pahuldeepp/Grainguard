import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  recordPostgresQueryDuration,
  registerPostgresPool,
} from "@greenguard/otel";
import { PrismaClient } from "../generated/prisma/client.js";

export type Db = PrismaClient;

export function createDb(connectionString: string, maxConnections = 10): Db {
  const pool = new pg.Pool({ connectionString, max: maxConnections });
  registerPostgresPool(pool, "device_service");
  const client = new PrismaClient({
    log: [{ emit: "event", level: "query" }],
    adapter: new PrismaPg(pool, { disposeExternalPool: true }),
  });
  client.$on("query", (event) => recordPostgresQueryDuration(event.duration));
  return client;
}
