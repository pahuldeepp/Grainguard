import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import { AuthError } from "@greenguard/tenant-auth";
import { createApp } from "./main.js";
import { KnowledgeClient } from "./knowledge.js";
import { ProvisioningClient } from "./provisioning.js";
import type { AssistantSuggestionStore } from "./assistant-suggestions.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const viewer: Principal = {
  subject: "user-1",
  tenantId,
  roles: ["viewer"],
  expiresAt: new Date(Date.now() + 60_000),
};

async function withApp(
  principal: Principal | null,
  run: (
    base: string,
    store: AssistantSuggestionStore,
    forwarded: Array<{ url: string; headers: Headers; body: string }>,
  ) => Promise<void>,
) {
  const store: AssistantSuggestionStore = {
    list: async (tenant) =>
      tenant === tenantId
        ? [
            {
              id: "grain_moisture",
              label: "What do my documents say about grain moisture?",
            },
          ]
        : [],
    recordUsage: async (tenant, id) => {
      assert.equal(tenant, tenantId);
      assert.equal(id, "grain_moisture");
    },
  };
  const forwarded: Array<{ url: string; headers: Headers; body: string }> = [];
  const knowledge = new KnowledgeClient(
    "http://127.0.0.1:8111",
    async (input, init) => {
      if (new Headers(init?.headers).get("Content-Type") === "application/pdf")
        assert.ok(init?.body instanceof Uint8Array);
      const body =
        init?.body instanceof Blob
          ? await init.body.text()
          : init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : String(init?.body ?? "");
      forwarded.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body,
      });
      return Response.json({ recorded: true }, { status: 202 });
    },
  );
  const { app, server } = await createApp({
    verify: async (authorization) => {
      if (!principal || authorization !== "Bearer valid")
        throw new AuthError(401, "invalid_token");
      return principal;
    },
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    knowledge,
    assistantSuggestions: store,
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    await run(`http://127.0.0.1:${address.port}`, store, forwarded);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
}

test("suggestions authenticate and return only tenant-ranked catalog items", async () => {
  await withApp(viewer, async (base) => {
    assert.equal((await fetch(`${base}/v1/assistant/suggestions`)).status, 401);
    const response = await fetch(`${base}/v1/assistant/suggestions`, {
      headers: { Authorization: "Bearer valid" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      suggestions: [
        {
          id: "grain_moisture",
          label: "What do my documents say about grain moisture?",
        },
      ],
    });
  });
});

test("successful use writes the tenant-scoped durable event before Redis ranking", async () => {
  const order: string[] = [];
  const store: AssistantSuggestionStore = {
    list: async () => [],
    recordUsage: async (tenant, id) => {
      order.push("redis");
      assert.equal(tenant, tenantId);
      assert.equal(id, "grain_moisture");
    },
  };
  const forwarded: Array<{ url: string; headers: Headers; body: string }> = [];
  const knowledge = new KnowledgeClient(
    "http://127.0.0.1:8111",
    async (input, init) => {
      order.push("postgres-outbox");
      forwarded.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return Response.json({ recorded: true }, { status: 202 });
    },
  );
  const { app, server } = await createApp({
    verify: async (authorization) => {
      if (authorization !== "Bearer valid")
        throw new AuthError(401, "invalid_token");
      return viewer;
    },
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    knowledge,
    assistantSuggestions: store,
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/assistant/suggestions/grain_moisture/used`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid" },
      },
    );
    assert.equal(response.status, 202);
    assert.deepEqual(order, ["postgres-outbox", "redis"]);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
  assert.equal(forwarded[0]?.headers.get("x-tenant-id"), tenantId);
  assert.match(
    forwarded[0]?.headers.get("idempotency-key") ?? "",
    /^[0-9a-f-]{36}$/i,
  );
  assert.equal(forwarded[0]?.body, "undefined");
});

test("unknown suggestion IDs are not persisted or ranked", async () => {
  const calls: string[] = [];
  const store: AssistantSuggestionStore = {
    list: async () => [],
    recordUsage: async () => {
      calls.push("redis");
    },
  };
  const knowledge = new KnowledgeClient("http://127.0.0.1:8111", async () => {
    calls.push("postgres");
    return Response.json({});
  });
  const { app, server } = await createApp({
    verify: async () => viewer,
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    knowledge,
    assistantSuggestions: store,
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/assistant/suggestions/arbitrary_text/used`,
      { method: "POST", headers: { Authorization: "Bearer valid" } },
    );
    assert.equal(response.status, 404);
    assert.deepEqual(calls, []);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
});

test("PDF upload requires an operator, binds identity on the server, and queues the raw PDF", async () => {
  const operator: Principal = { ...viewer, roles: ["operator"] };
  await withApp(operator, async (base, _store, forwarded) => {
    const documentId = "22222222-2222-4222-8222-222222222222";
    const response = await fetch(
      `${base}/v1/assistant/documents/${documentId}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/pdf",
        },
        body: "%PDF-test",
      },
    );
    assert.equal(response.status, 202);
    assert.equal(
      forwarded[0]?.url,
      `http://127.0.0.1:8111/v1/documents/${documentId}`,
    );
    assert.equal(forwarded[0]?.headers.get("x-tenant-id"), tenantId);
    assert.equal(forwarded[0]?.headers.get("x-document-version"), "1");
    assert.equal(forwarded[0]?.headers.get("content-type"), "application/pdf");
    assert.match(forwarded[0]?.headers.get("authorization") ?? "", /^Bearer /);
    assert.equal(forwarded[0]?.body, "%PDF-test");
  });
});

test("PDF upload rejects viewers and malformed PDF bytes before calling Knowledge", async () => {
  await withApp(viewer, async (base, _store, forwarded) => {
    const documentId = "22222222-2222-4222-8222-222222222222";
    const denied = await fetch(`${base}/v1/assistant/documents/${documentId}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/pdf",
      },
      body: "%PDF-test",
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { code: "insufficient_role" });
    assert.equal(forwarded.length, 0);
  });
});

test("malformed PDF bytes never reach Knowledge", async () => {
  await withApp(
    { ...viewer, roles: ["operator"] },
    async (base, _store, forwarded) => {
      const response = await fetch(
        `${base}/v1/assistant/documents/22222222-2222-4222-8222-222222222222`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/pdf",
          },
          body: "not a PDF",
        },
      );
      assert.equal(response.status, 415);
      assert.deepEqual(await response.json(), { code: "pdf_required" });
      assert.equal(forwarded.length, 0);
    },
  );
});

test("invalid upload ID rejects before verifier, limiter or owner egress", async () => {
  let verified = 0,
    forwarded = 0;
  const knowledge = new KnowledgeClient("http://127.0.0.1:8111", async () => {
    forwarded++;
    return Response.json({}, { status: 202 });
  });
  const { app, server } = await createApp({
    verify: async () => {
      verified++;
      throw new Error("must not verify");
    },
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    knowledge,
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/assistant/documents/not-a-uuid`,
      {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: "not PDF",
      },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: "invalid_document_id" });
    assert.equal(verified, 0);
    assert.equal(forwarded, 0);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
});
