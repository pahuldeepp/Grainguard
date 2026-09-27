import type { Envelope } from "./event.js";
import { startEntitlementWorker } from "./worker.js";

interface Disconnectable {
  $disconnect(): Promise<void>;
}

export async function startEntitlementProjector<
  Database extends Disconnectable,
>(options: {
  databaseUrl?: string;
  databaseUrlName: string;
  brokers?: string;
  groupId: string;
  clientId: string;
  createDatabase: (url: string) => Database;
  apply: (database: Database, event: Envelope) => Promise<boolean>;
  heartbeat: (
    database: Database,
    partition: number,
    emittedAt: Date,
  ) => Promise<void>;
}): Promise<void> {
  if (!options.databaseUrl || !options.brokers)
    throw new Error(`${options.databaseUrlName} and KAFKA_BROKERS required`);
  const database = options.createDatabase(options.databaseUrl);
  const stop = await startEntitlementWorker({
    brokers: options.brokers.split(","),
    groupId: options.groupId,
    clientId: options.clientId,
    apply: (event) => options.apply(database, event),
    heartbeat: (partition, at) => options.heartbeat(database, partition, at),
    onFatal: (error) => {
      console.error(error);
      process.exit(1);
    },
  });
  const shutdown = () => {
    void stop().finally(() => database.$disconnect());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
