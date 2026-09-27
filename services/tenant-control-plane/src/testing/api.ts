import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { createControlPlaneApp } from "../app.js";
import { runtimeDb, uniqueSubject } from "./fixtures.js";

export const LOOKUP_TOKEN = "lookup-token-for-tests";

export async function startApi(globalFlagAdmin?: {
  token: string;
  actorId: string;
}) {
  const issuer = await createTestIssuer();
  const db = runtimeDb(5);
  const app = await createControlPlaneApp({
    db,
    auth: {
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { getKey: issuer.getKey },
    },
    lookupToken: LOOKUP_TOKEN,
    flagAdmin: globalFlagAdmin,
  });
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  // Every person is a fresh subject; IdP-asserted tenant/roles must be ignored.
  const person = async (
    label: string,
    claims: Record<string, unknown> = {},
  ) => {
    const subject = uniqueSubject(label);
    // Invitations bind to the verified email, so every person has one.
    const identity = {
      sub: subject,
      email: `${subject}@example.test`,
      email_verified: true,
    };
    return { subject, token: await issuer.sign({ ...identity, ...claims }) };
  };
  async function call(
    method: string,
    path: string,
    options: {
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    const res = await fetch(new URL(path, base), {
      method,
      headers: {
        ...(options.body !== undefined && {
          "content-type": "application/json",
        }),
        ...options.headers,
        ...(options.token && { authorization: `Bearer ${options.token}` }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : undefined) as Record<string, unknown> & {
        items?: Record<string, unknown>[];
      },
    };
  }
  return { db, issuer, baseUrl: base, person, call, close: () => app.close() };
}
