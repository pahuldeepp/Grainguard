import { compose } from "./events-lib.mjs";

export function resetBindingFeed(args, execute = compose) {
  if (args.length !== 1 || args[0] !== "--yes") {
    throw new Error(
      "Stop ingest admission and the binding consumer, plan replay, then pass --yes to clear telemetry checkpoints.",
    );
  }
  execute(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "greenguard_telemetry",
    ],
    {
      input:
        "BEGIN; LOCK TABLE public.binding_feed_checkpoints IN ACCESS EXCLUSIVE MODE; DELETE FROM public.binding_feed_checkpoints; COMMIT;",
    },
  );
}
if (import.meta.main) {
  resetBindingFeed(process.argv.slice(2));
  console.log(
    "Telemetry binding checkpoints cleared; admission requires fresh checkpoints from every partition.",
  );
}
