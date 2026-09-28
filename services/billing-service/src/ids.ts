import { createHash, randomUUID } from "node:crypto";

export const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

export function nameId(...names: string[]): string {
  const bytes = createHash("sha256").update(names.join("\n")).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const freshId = () => randomUUID();
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
