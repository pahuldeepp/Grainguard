#!/usr/bin/env node
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verifySignedAuditExport, type AuditManifest } from "./index.js";

/** `verify-audit-export FILE MANIFEST SIGNATURE PUBLIC_KEY_PEM` */
export function verifyFiles(paths: readonly string[]): boolean {
  if (paths.length !== 4)
    throw new Error("expected file, manifest, signature and public key paths");
  const [filePath, manifestPath, signaturePath, keyPath] = paths;
  const file = readFileSync(filePath);
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as AuditManifest;
  const signature = readFileSync(signaturePath, "utf8").trim();
  const publicKey = createPublicKey(readFileSync(keyPath));
  return verifySignedAuditExport({ file, manifest, signature, publicKey });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!verifyFiles(process.argv.slice(2))) {
      console.error("audit export verification failed");
      process.exitCode = 1;
    } else {
      console.log("audit export verified");
    }
  } catch {
    console.error("audit export verification failed");
    process.exitCode = 1;
  }
}
