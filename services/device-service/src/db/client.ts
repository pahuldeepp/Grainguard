import { createOwnerDatabase } from "@greenguard/membership-client/owner-db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  recordPostgresQueryDuration,
  registerPostgresPool,
} from "@greenguard/otel";
import { PrismaClient } from "../generated/prisma/client.js";

export type Db = PrismaClient;

function createClient(connectionString: string, maxConnections: number): Db {
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  });
  registerPostgresPool(pool, "device_service");
  const client = new PrismaClient({
    log: [{ emit: "event", level: "query" }],
    adapter: new PrismaPg(pool, { disposeExternalPool: true }),
  });
  client.$on("query", (event) => recordPostgresQueryDuration(event.duration));
  return client;
}

export function createDb(
  connectionString: string,
  maxConnections = 10,
  env: NodeJS.ProcessEnv = process.env,
  role: "inventory_app" | "inventory_projector" = "inventory_app",
): Db {
  return createOwnerDatabase({
    legacyUrl: connectionString,
    env,
    service: "device-service",
    database: "greenguard_inventory",
    roles: [role],
    create: (url) => createClient(url, maxConnections),
    close: (db) => db.$disconnect(),
  });
}
