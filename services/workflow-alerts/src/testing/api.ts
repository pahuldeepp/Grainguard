import { createTokenVerifier } from "@greenguard/tenant-auth";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { createAlertsApp } from "../app.js";
import { pooledDb } from "./fixtures.js";

export async function startApi() {
  const issuer = await createTestIssuer();
  const db = pooledDb(5);
  const app = await createAlertsApp({
    db,
    verifier: createTokenVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { getKey: issuer.getKey },
    }),
  });
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  const token = (tenantId: string, roles: string[], sub = "user-1") =>
    issuer.sign({ tenant_id: tenantId, roles, sub });
  async function call(
    method: string,
    path: string,
    token?: string,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(new URL(path, base), {
      method,
      headers: {
        ...headers,
        ...(token && { authorization: `Bearer ${token}` }),
      },
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : undefined) as Record<string, unknown>,
    };
  }
  return { db, token, call, close: () => app.close() };
}
