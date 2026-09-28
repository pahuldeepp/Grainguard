import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { UUID } from "./ids.js";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

export function createDb(connectionString: string, max = 10): Db {
  return new PrismaClient({ adapter: new PrismaPg({
    connectionString, max, connectionTimeoutMillis: 2000,
  }) });
}

export async function withTenant<T>(db: Db, tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("invalid tenant ID");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true),
      set_config('lock_timeout', '3s', true), set_config('statement_timeout', '5s', true)`;
    return work(tx);
  });
}
