import { createHash } from "node:crypto";

// Name-based UUID (version-5 layout over SHA-256): the same names always give the
// same ID. Shared by the control plane (identity, organization, event IDs) and by
// verifiers, which must compute the same identity key to address a cache entry.
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

// The only identity reference on the event bus (ADR-0017): raw IdP subjects stay in
// greenguard_control; consumers hash the issuer|subject they hold to find the entry.
export const identityKey = (issuer: string, subject: string) =>
  nameId("identity", issuer, subject);

export const identityIdOf = identityKey;

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
