import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter, once } from "node:events";
import express from "express";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import type { AssistantAgent } from "./assistant-agent.js";
import { registerAgentRoutes } from "./assistant-agent-routes.js";

test(
  "Agent capacity reserves a bounded verified tenant share and releases errors and disconnects exactly once",
  { timeout: 10000 },
  async () => {
    const events = new EventEmitter();
    const runs: {
      tenant: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }[] = [];
    const agent = {
      jwks: { keys: [] },
      plan: (p: Principal, _q: string, _o: unknown, signal: AbortSignal) =>
        new Promise((resolve, reject) => {
          runs.push({ tenant: p.tenantId, resolve, reject });
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
              events.emit("aborted");
            },
            { once: true },
          );
          events.emit("added");
        }),
      call: async () => ({
        content: [{ type: "text", text: "Need a device ID" }],
      }),
    } as unknown as AssistantAgent;
    const app = express();
    registerAgentRoutes(app, {
      agent,
      maxConcurrentRuns: 4,
      verify: async (auth) => {
        if (!/^Bearer tenant:[ABC]$/.test(auth ?? ""))
          throw new AuthError(401, "invalid_token");
        return {
          issuer: "https://id.example",
          subject: "user",
          tenantId: auth!.slice(-1),
          roles: ["operator"],
          expiresAt: new Date(Date.now() + 60000),
        };
      },
      rateLimiter: {
        check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      },
    });
    const server = app.listen(0, "127.0.0.1");
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/v1/assistant/agent`;
    const call = (tenant: string, signal?: AbortSignal) =>
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer tenant:${tenant}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: "Read device facts" }),
        signal,
      });
    const waitCount = async (count: number) => {
      while (runs.length < count) await once(events, "added");
    };
    const finish = (index: number) =>
      runs[index]!.resolve({ tool: "abstain", args: {} });
    try {
      assert.equal((await call("foreign")).status, 401);
      assert.equal(runs.length, 0);
      const first = [call("A"), call("A")];
      await waitCount(2);
      assert.equal((await call("A")).status, 503);
      assert.equal(runs.length, 2);
      first.push(call("B"), call("B"));
      await waitCount(4);
      const globalDenied = await call("C");
      assert.equal(globalDenied.status, 503);
      assert.equal(globalDenied.headers.get("Retry-After"), "2");
      assert.equal(runs.length, 4);
      for (let i = 0; i < 4; i++) finish(i);
      assert.deepEqual(
        await Promise.all(
          first.map(async (response) => (await response).status),
        ),
        [200, 200, 200, 200],
      );
      const failed = call("A");
      await waitCount(5);
      runs[4]!.reject(new Error("planner unavailable"));
      assert.equal((await failed).status, 503);
      const controller = new AbortController();
      const disconnected = call("A", controller.signal).catch(() => null);
      await waitCount(6);
      const aborted = once(events, "aborted");
      controller.abort();
      await disconnected;
      await aborted;
      const recovered = [call("A"), call("A")];
      await waitCount(8);
      assert.equal((await call("A")).status, 503);
      finish(6);
      finish(7);
      assert.deepEqual(
        await Promise.all(
          recovered.map(async (response) => (await response).status),
        ),
        [200, 200],
      );
      assert.deepEqual(
        runs.slice(0, 4).map((r) => r.tenant),
        ["A", "A", "B", "B"],
      );
    } finally {
      for (const run of runs) run.resolve({ tool: "abstain", args: {} });
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
