import { request } from "node:http";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { createTokenVerifier } from "@greenguard/tenant-auth";
import { createApp } from "../app.js";
import type { VersionRegistry } from "../api/versioning/index.js";
import { pooledDb } from "./fixtures.js";

export interface ApiJson {
  [key: string]: unknown;
  siteId?: string;
  binId?: string;
  deviceId?: string;
  items?: { deviceId: string }[];
  nextCursor?: string | null;
  code?: string;
  status?: number;
  supported?: string[];
  bindingVersion?: string;
  correlation_id?: string;
}

export interface CallOptions {
  token?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

export async function startApi(
  options: {
    versions?: VersionRegistry;
    now?: () => Date;
    ping?: () => Promise<void>;
  } = {},
) {
  const issuer = await createTestIssuer();
  const db = pooledDb(5);
  const app = await createApp(
    { ping: options.ping ?? (async () => undefined) },
    {
      db,
      verifier: createTokenVerifier({
        issuer: issuer.issuer,
        audience: issuer.audience,
        keys: { getKey: issuer.getKey },
      }),
      versions: options.versions,
      now: options.now,
    },
  );
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();

  const token = (tenantId: string, roles: string[], sub = "user-1") =>
    issuer.sign({ tenant_id: tenantId, roles, sub });

  async function call(method: string, path: string, opts: CallOptions = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body = opts.rawBody;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const target = new URL(path, base);
    const response = await new Promise<{
      status: number;
      headers: Headers;
      text: string;
    }>((resolve, reject) => {
      const req = request(
        target,
        {
          method,
          headers: {
            ...headers,
            "content-length": Buffer.byteLength(body ?? ""),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const out = new Headers();
            for (const [name, value] of Object.entries(res.headers))
              out.set(
                name,
                Array.isArray(value) ? value.join(", ") : String(value),
              );
            resolve({
              status: res.statusCode ?? 0,
              headers: out,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    const { text } = response;
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: text ? (JSON.parse(text) as ApiJson) : undefined,
    };
  }

  return { base, issuer, db, token, call, close: () => app.close() };
}
