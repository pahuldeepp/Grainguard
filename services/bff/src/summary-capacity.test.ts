import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter, once } from "node:events";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import { createApp } from "./main.js";
import type { KnowledgeClient, DocumentSummaryScope } from "./knowledge.js";
import { ProvisioningClient } from "./provisioning.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const summary = {
  question: "Summarize selected PDF",
  mode: "document_summary",
  document_id: id,
  document_version: 1,
};

test("synchronous summary slots bound both routes globally and by verified tenant, then release on success, failure and disconnect", async () => {
  const events = new EventEmitter();
  const pending: {
    tenant: string;
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }[] = [];
  const work = (
    principal: Principal,
    scope?: DocumentSummaryScope,
    signal?: AbortSignal,
  ) => {
    if (scope?.mode !== "document_summary")
      return Promise.resolve({ status: 200, body: { answer: "normal" } });
    return new Promise((resolve, reject) => {
      pending.push({ tenant: principal.tenantId, resolve, reject });
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
          events.emit("aborted");
        },
        { once: true },
      );
      events.emit("added");
    });
  };
  const knowledge = {
    ask: (
      p: Principal,
      _a: string,
      _q: string,
      scope?: DocumentSummaryScope,
      signal?: AbortSignal,
    ) => work(p, scope, signal),
    appendConversationMessage: (
      p: Principal,
      _a: string,
      _id: string,
      _q: string,
      scope?: DocumentSummaryScope,
      signal?: AbortSignal,
    ) => work(p, scope, signal),
  } as unknown as KnowledgeClient;
  const { app, server } = await createApp({
    verify: async (auth) => {
      if (!auth?.startsWith("Bearer tenant:"))
        throw new AuthError(401, "invalid_token");
      return {
        subject: "user",
        tenantId: auth.endsWith(":A") ? tenantA : tenantB,
        roles: ["viewer"],
        expiresAt: new Date(Date.now() + 60000),
      };
    },
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    knowledge,
  });
  const listener = app.listen(0, "127.0.0.1");
  if (!listener.listening) await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (
    tenant: string,
    path = "/v1/knowledge/query",
    body = summary,
    signal?: AbortSignal,
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer tenant:${tenant}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  const waitCount = async (count: number) => {
    while (pending.length < count) await once(events, "added");
  };
  try {
    const unauth = await fetch(base + "/v1/knowledge/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    });
    assert.equal(unauth.status, 401);
    assert.equal(pending.length, 0);
    const first = [
      call("A"),
      call("A", `/v1/assistant/conversations/${id}/messages`),
    ];
    await waitCount(2);
    const tenantDenied = await call("A");
    assert.equal(tenantDenied.status, 503);
    assert.equal(tenantDenied.headers.get("Retry-After"), "1");
    assert.equal(pending.length, 2);
    first.push(
      call("B"),
      call("B", `/v1/assistant/conversations/${id}/messages`),
    );
    await waitCount(4);
    assert.equal((await call("B")).status, 503);
    assert.equal(pending.length, 4);
    assert.equal(
      (await call("A", "/v1/knowledge/query", { ...summary, mode: "question" }))
        .status,
      200,
    );
    for (const entry of pending)
      entry.resolve({ status: 200, body: { answer: "summary" } });
    assert.deepEqual(
      await Promise.all(first.map(async (response) => (await response).status)),
      [200, 200, 200, 200],
    );
    const failed = call("A");
    await waitCount(5);
    pending[4]!.reject(new Error("owner unavailable"));
    assert.equal((await failed).status, 503);
    const controller = new AbortController();
    const disconnected = call(
      "A",
      `/v1/assistant/conversations/${id}/messages`,
      summary,
      controller.signal,
    ).catch(() => null);
    await waitCount(6);
    const aborted = once(events, "aborted");
    controller.abort();
    await disconnected;
    await aborted;
    const recovered = [call("A"), call("A")];
    await waitCount(8);
    assert.equal((await call("A")).status, 503);
    for (const entry of pending.slice(6))
      entry.resolve({ status: 200, body: { answer: "recovered" } });
    assert.deepEqual(
      await Promise.all(
        recovered.map(async (response) => (await response).status),
      ),
      [200, 200],
    );
    assert.deepEqual(
      pending.slice(0, 4).map((p) => p.tenant),
      [tenantA, tenantA, tenantB, tenantB],
    );
  } finally {
    for (const entry of pending) entry.resolve({ status: 200, body: {} });
    listener.closeAllConnections();
    await new Promise<void>((r) => listener.close(() => r()));
    await server.stop();
  }
});
