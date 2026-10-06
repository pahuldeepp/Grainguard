import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import { KnowledgeClient } from "./knowledge.js";
import { registerSummaryRoutes } from "./assistant-summary-routes.js";
test("summary job proxy rejects identity overrides, preserves verified tenant and forwards cancellation", async () => {
  const tenant = "00000000-0000-4000-8000-000000000001";
  const id = "00000000-0000-4000-8000-000000000002";
  const seen: { headers: Headers; method: string }[] = [];
  const app = express();
  registerSummaryRoutes(app, {
    verify: async (auth) => {
      if (auth !== "Bearer valid") throw new AuthError(401, "invalid_token");
      return {
        tenantId: tenant,
        subject: "user",
        roles: ["viewer"],
        expiresAt: new Date(Date.now() + 60_000),
      } as Principal;
    },
    knowledge: new KnowledgeClient(
      "http://127.0.0.1:58080",
      async (_url, init) => {
        seen.push({
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
        });
        return Response.json(
          {
            job_id: id,
            status: "queued",
            completed_batches: 0,
            total_batches: 0,
          },
          { status: 202 },
        );
      },
    ),
    allow: async () => true,
  });
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port");
  const base = `http://127.0.0.1:${address.port}/v1/assistant/summary-jobs`;
  const body = {
    document_id: id,
    document_version: 1,
    question: "Summarize completely",
    idempotency_key: id,
  };
  try {
    assert.equal(
      (
        await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base, {
          method: "POST",
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...body, tenant_id: "other" }),
        })
      ).status,
      400,
    );
    assert.equal(seen.length, 0);
    assert.equal(
      (
        await fetch(base, {
          method: "POST",
          headers: {
            Authorization: "Bearer valid",
            "X-Tenant-ID": "other",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        })
      ).status,
      202,
    );
    assert.equal(seen[0].headers.get("X-Tenant-ID"), tenant);
    await fetch(`${base}/${id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer valid" },
    });
    assert.equal(seen[1].method, "DELETE");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
