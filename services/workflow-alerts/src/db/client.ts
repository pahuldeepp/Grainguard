import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

// Runtime traffic goes through PgBouncer (transaction pooling) as alerts_app.
export const createDb = (url: string, max = 10): Db =>
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      max,
      connectionTimeoutMillis: 2000,
    }),
  });
