import { createHash } from "node:crypto";

// Name-based UUID (version-5 layout over SHA-256). The same names always give the
// same ID, so a retried command or replayed seed never mints a second identity,
// organization, audit row or event (FIRST_VERTICAL_SLICE: IDs are created once).
export function nameId(...names: string[]): string {
  const bytes = createHash("sha256")
    .update(names.join("\n"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const identityIdOf = (issuer: string, subject: string) =>
  nameId("identity", issuer, subject);

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
