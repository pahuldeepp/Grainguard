import { randomBytes } from "node:crypto";
import { activeTraceparent } from "@greenguard/otel";

// Outbox rows carry the live span's traceparent (ADR-0004); without tracing a fresh
// sampled context keeps them contract-valid.
export function currentTraceparent(): string {
  const live = activeTraceparent();
  if (live) return live;
  return [
    "00",
    randomBytes(16).toString("hex"),
    randomBytes(8).toString("hex"),
    "01",
  ].join("-");
}
