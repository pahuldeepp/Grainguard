import { PrismaPg } from "@prisma/adapter-pg";
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
