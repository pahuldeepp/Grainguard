import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { registerAgentRoutes } from "./assistant-agent-routes.js";
import type { AssistantAgent } from "./assistant-agent.js";
import type { Principal } from "@greenguard/tenant-auth";
const principal: Principal = {
  issuer: "https://id.example",
  subject: "operator",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  roles: ["operator"],
  expiresAt: new Date(Date.now() + 60000),
};
const proposal = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function fixture(
  verify: () => Promise<Principal> = async () => principal,
  allowed = true,
) {
  const minted: string[] = [];
  const seen: unknown[] = [];
  const agent = {
    jwks: { keys: [] },
    delegation: {
      mint: async (p: Principal, a: string, s: string) => {
        minted.push(a + ":" + s);
        return a + "-fresh-token";
      },
    },
    advisor: {
      request: async (...args: unknown[]) => {
        seen.push(args);
        return {
          status: 200,
          body: { execution_status: "succeeded", execution_receipt: "receipt" },
        };
      },
      status: async (...args: unknown[]) => {
        seen.push(args);
        return {
          status: 200,
          body: {
            proposal_id: proposal,
            execution_status: "succeeded",
            execution_receipt: "receipt",
          },
          etag: '"3"',
        };
      },
    },
  } as unknown as AssistantAgent;
  const app = express();
  registerAgentRoutes(app, {
    agent,
    verify,
    rateLimiter: { check: async () => ({ allowed, retryAfterSeconds: 2 }) },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return {
    minted,
    seen,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const body = { action_hash: "a".repeat(64), version: 3 };
test("execution proxy reauthorizes and mints fresh advisor and owner scopes", async () => {
  let checks = 0;
  const f = await fixture(async () => {
    checks++;
    return principal;
  });
  try {
    const r = await fetch(
      f.url + `/v1/advisor/proposals/${proposal}/execution`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "If-Match": '"3"' },
        body: JSON.stringify(body),
      },
    );
    assert.equal(r.status, 200);
    assert.equal(checks, 2);
    assert.deepEqual(f.minted, [
      "grain-advisor:advisor:decide",
      "workflow-alerts:alerts:acknowledge",
    ]);
    const args = f.seen[0] as unknown[];
    assert.deepEqual(args[3], body);
    assert.deepEqual(args[4], {
      "If-Match": '"3"',
      "X-Owner-Delegated-Token": "Bearer workflow-alerts-fresh-token",
    });
    assert.equal(r.headers.get("Cache-Control"), "no-store");
  } finally {
    await f.close();
  }
});
test("execution denies changed tenant, revoked role and machine identity before owner calls", async () => {
  for (const fresh of [
    { ...principal, tenantId: proposal },
    { ...principal, roles: ["viewer"] as Principal["roles"] },
    { ...principal, principalType: "service" as const },
  ]) {
    let checks = 0;
    const f = await fixture(async () => (++checks === 1 ? principal : fresh));
    try {
      const r = await fetch(
        f.url + `/v1/advisor/proposals/${proposal}/execution`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "If-Match": '"3"' },
          body: JSON.stringify(body),
        },
      );
      assert.equal(r.status, 403);
      assert.deepEqual(f.minted, []);
      assert.deepEqual(f.seen, []);
    } finally {
      await f.close();
    }
  }
});
test("execution closed schema and matching version prevent arbitrary actions", async () => {
  const f = await fixture();
  try {
    for (const value of [
      { ...body, action: "arbitrary" },
      { ...body, tenant_id: proposal },
      { ...body, version: 0 },
      { ...body, action_hash: "invalid" },
    ]) {
      const r = await fetch(
        f.url + `/v1/advisor/proposals/${proposal}/execution`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "If-Match": '"3"' },
          body: JSON.stringify(value),
        },
      );
      assert.equal(r.status, 400);
    }
    const r = await fetch(
      f.url + `/v1/advisor/proposals/${proposal}/execution`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "If-Match": '"2"' },
        body: JSON.stringify(body),
      },
    );
    assert.equal(r.status, 400);
    assert.deepEqual(f.minted, []);
  } finally {
    await f.close();
  }
});
test("rate denial does not mint tokens and status read returns fresh receipt and ETag", async () => {
  const limited = await fixture(undefined, false);
  try {
    const r = await fetch(
      limited.url + `/v1/advisor/proposals/${proposal}/execution`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "If-Match": '"3"' },
        body: JSON.stringify(body),
      },
    );
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("Retry-After"), "2");
    assert.deepEqual(limited.minted, []);
  } finally {
    await limited.close();
  }
  let checks = 0;
  const f = await fixture(async () => {
    checks++;
    return principal;
  });
  try {
    const r = await fetch(f.url + `/v1/advisor/proposals/${proposal}`);
    assert.equal(r.status, 200);
    assert.equal(checks, 2);
    assert.equal(r.headers.get("ETag"), '"3"');
    assert.equal(
      ((await r.json()) as { execution_status: string }).execution_status,
      "succeeded",
    );
    assert.deepEqual(f.minted, ["grain-advisor:advisor:decide"]);
  } finally {
    await f.close();
  }
});
