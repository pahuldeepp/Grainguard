import { createMultiIssuerVerifier } from "@greenguard/tenant-auth/issuers";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { createAlertsApp } from "../app.js";
import { pooledDb } from "./fixtures.js";

export async function startApi() {
  const issuer = await createTestIssuer();
  const secondIssuer = await createTestIssuer({
    issuer: "https://second-issuer.test",
  });
  const verifier = createMultiIssuerVerifier(
    [issuer, secondIssuer].map((i) => ({
      issuer: i.issuer,
      audience: i.audience,
      keys: { getKey: i.getKey },
    })),
  );
  const db = pooledDb(5);
  const app = await createAlertsApp({
    db,
    actorHmacKey: "test-actor-key-at-least-32-bytes-long",
    historyCursorKey: "test-cursor-key-at-least-32-bytes-long",
    verifier: {
      verify: async (authorization) => {
        const result = await verifier.verify(authorization);
        return { ...result.principal, issuer: result.issuer };
      },
    },
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
  return { db, token, call, issuer, secondIssuer, close: () => app.close() };
}
