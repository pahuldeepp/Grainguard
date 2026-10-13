import { setTimeout as sleep } from "node:timers/promises";
import { createBootstrapWorkerDb } from "../db/client.js";
import { createTenantBootstrapProcessor } from "./run.js";
import { createRepositoryTenantBootstrapAdapters } from "./repository-adapters.js";
import { readTenantBootstrapWorkerConfig } from "./worker-config.js";

export async function runTenantBootstrapWorker(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  const config = readTenantBootstrapWorkerConfig(env);
  const db = createBootstrapWorkerDb(config.databaseUrl, 4);
  let repository:
    | Awaited<ReturnType<typeof createRepositoryTenantBootstrapAdapters>>
    | undefined;
  try {
    repository = await createRepositoryTenantBootstrapAdapters();
    const processNext = createTenantBootstrapProcessor(repository.adapters);
    const [identity] = await db.$queryRaw<
      { session_user: string; current_user: string }[]
    >`SELECT session_user,current_user`;
    if (
      identity?.session_user !== "tenant_bootstrap_worker" ||
      identity.current_user !== "control_bootstrap_worker_role"
    )
      throw new Error("bootstrap worker database role initialization failed");

    console.info(JSON.stringify({ event: "tenant_bootstrap_worker_started" }));
    while (!signal.aborted) {
      try {
        const didWork = await processNext(db);
        if (!didWork) await sleep(config.pollIntervalMs, undefined, { signal });
      } catch (error) {
        if (signal.aborted) break;
        console.error(
          JSON.stringify({
            event: "tenant_bootstrap_worker_iteration_failed",
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
        await sleep(config.errorBackoffMs, undefined, { signal });
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await repository?.close();
    await db.$disconnect();
    console.info(JSON.stringify({ event: "tenant_bootstrap_worker_stopped" }));
  }
}

if (
  process.argv[1]?.endsWith(
    "tenant-control-plane/dist/tenant-bootstrap/worker.js",
  )
) {
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await runTenantBootstrapWorker(process.env, controller.signal);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "tenant_bootstrap_worker_start_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}
