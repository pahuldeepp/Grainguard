import { createHash } from "node:crypto";

// Name-based UUID (version 5 layout over SHA-256): the same inputs always give the
// same ID, so a replayed risk event or a retried transition never mints a new ID.
export function deterministicId(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u001f")).digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
