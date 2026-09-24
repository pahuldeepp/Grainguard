import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "@greenguard/tenant-auth";
import type { ResolvedVersion } from "./versioning/index.js";

export type ApiRequest = IncomingMessage & {
  principal?: Principal;
  correlationId?: string;
  traceparent?: string;
  apiVersion?: ResolvedVersion;
  body?: unknown;
};
export type ApiResponse = ServerResponse;
export type NextFunction = (err?: unknown) => void;

export const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return value === undefined ? undefined : String(value);
};
