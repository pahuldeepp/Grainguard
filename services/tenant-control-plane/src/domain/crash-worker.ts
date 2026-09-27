import { createOrganization } from "./store.js";
import { randomUUID } from "node:crypto";
import { ISSUER, runtimeDb } from "../testing/fixtures.js";

const [mode, subject, idempotencyKey, name] = process.argv.slice(2);
if (!mode || !subject || !idempotencyKey || !name)
  throw new Error("crash worker arguments required");
const db = runtimeDb();
try {
  await createOrganization(
    db,
    { issuer: ISSUER, subject },
    { name },
    {
      idempotencyKey,
      correlationId: randomUUID(),
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
  );
  if (mode === "after") process.kill(process.pid, "SIGKILL");
  else throw new Error("before-commit worker unexpectedly returned");
} finally {
  await db.$disconnect();
}
