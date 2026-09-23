import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export type Db = PrismaClient;

export function createDb(connectionString: string, maxConnections = 10): Db {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: maxConnections }),
  });
}
