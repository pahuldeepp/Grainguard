// Test fixture (Stage 09e live test): runs one export against the configured S3
// store and SIGKILLs itself just before the manifest upload, i.e. mid-publish.
import { createPrivateKey } from "node:crypto";
import {
  createS3ExportStorage,
  readS3StorageConfig,
  type ExportStorage,
} from "@greenguard/audit";
import { processNextAuditExport } from "../audit/worker.js";
import { createDb } from "../db/client.js";
import { env } from "./fixtures.js";

const config = readS3StorageConfig(process.env);
if (!config)
  throw new Error("crash worker requires AUDIT_EXPORT_S3_* settings");
const real = createS3ExportStorage(config);
const dying: ExportStorage = {
  kind: "s3",
  head: (key) => real.head(key),
  presignGet: (key, ttl, options) => real.presignGet(key, ttl, options),
  put: async (key, body, meta) => {
    if (key.endsWith("/manifest.json")) process.kill(process.pid, "SIGKILL");
    return real.put(key, body, meta);
  },
};
const db = createDb(env("CONTROL_DATABASE_URL"), 1);
const pem = env("AUDIT_CRASH_PRIVATE_KEY_PEM").replaceAll("\\n", "\n");
await processNextAuditExport(db, {
  storage: dying,
  privateKey: createPrivateKey(pem),
  publicKeyId: "crash",
});
await db.$disconnect();
