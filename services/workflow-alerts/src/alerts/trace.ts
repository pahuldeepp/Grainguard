import { randomBytes } from "node:crypto";
import { activeTraceparent } from "@greenguard/otel";

// With tracing on, the live span is the origin of any event written; otherwise a
// fresh sampled traceparent keeps outbox rows contract-valid.
export const currentTraceparent = (): string =>
  activeTraceparent() ??
  `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
