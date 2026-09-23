export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
}
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const databaseUrl = env.INVENTORY_DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      "INVENTORY_DATABASE_URL is required. Run make bootstrap and make dev.",
    );
  return {
    databaseUrl,
    port: Number(env.PORT || 3001),
    host: env.HOST || "127.0.0.1",
  };
}
