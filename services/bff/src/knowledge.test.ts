import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import type { Principal } from "@greenguard/tenant-auth";
import { AuthError } from "@greenguard/tenant-auth";
import { createApp } from "./main.js";
import { parseAssistantQuery, KnowledgeClient } from "./knowledge.js";
import { ProvisioningClient } from "./provisioning.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const viewer: Principal = {
  subject: "user-1",
  tenantId,
  roles: ["viewer"],
  expiresAt: new Date(Date.now() + 60_000),
};

async function withServer(
  principal: Principal | null,
  knowledge: KnowledgeClient,
  run: (base: string) => Promise<void>,
) {
  const { app, server } = await createApp({
    verify: async (authorization) => {
      if (!principal || authorization !== "Bearer valid")
        throw new AuthError(401, "invalid_token");
      return principal;
    },
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    knowledge,
  });
  const listener = app.listen(0, "127.0.0.1");
  if (!listener.listening) await once(listener, "listening");
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
}

test("knowledge query authenticates and derives tenant from verified membership", async () => {
  const seen: { url: string; headers: Headers; body: string }[] = [];
  const knowledge = new KnowledgeClient(
    "http://127.0.0.1:8111",
    async (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return Response.json({
        answer: "Keep grain dry.",
        citations: [{ document_id: "doc-1", page_start: 3 }],
      });
    },
  );
  await withServer(viewer, knowledge, async (base) => {
    const unauthorized = await fetch(`${base}/v1/knowledge/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "How should grain be stored?" }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(seen.length, 0);
    const response = await fetch(`${base}/v1/knowledge/query`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: "How should grain be stored?",
        tenant_id: "attacker",
      }),
    });
    assert.equal(
      response.status,
      400,
      "caller-controlled tenant fields are rejected",
    );
    const accepted = await fetch(`${base}/v1/knowledge/query`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question: "How should grain be stored?" }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    assert.deepEqual(await accepted.json(), {
      answer: "Keep grain dry.",
      citations: [{ document_id: "doc-1", page_start: 3 }],
    });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "http://127.0.0.1:8111/v1/query");
  assert.equal(seen[0]?.headers.get("authorization"), "Bearer valid");
  assert.equal(seen[0]?.headers.get("x-tenant-id"), tenantId);
  assert.deepEqual(JSON.parse(seen[0]?.body ?? "{}"), {
    question: "How should grain be stored?",
  });
});

test("RAG operations reject non-operators and only expose the bounded section allowlist", async () => {
  let calls = 0;
  const knowledge = new KnowledgeClient("http://127.0.0.1:8111", async () => {
    calls++;
    return Response.json({ status: "connected" });
  });
  await withServer(viewer, knowledge, async (base) => {
    assert.equal(
      (
        await fetch(`${base}/v1/rag/ops/cache`, {
          headers: { Authorization: "Bearer valid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/v1/rag/ops/../../secret`, {
          headers: { Authorization: "Bearer valid" },
        })
      ).status,
      404,
    );
  });
  assert.equal(calls, 0);
  await withServer(
    { ...viewer, roles: ["operator"] },
    knowledge,
    async (base) => {
      const response = await fetch(`${base}/v1/rag/ops/cache`, {
        headers: { Authorization: "Bearer valid" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
    },
  );
  assert.equal(calls, 1);
});

test("Knowledge errors expose allowlisted machine codes and distinguish generic from provider throttling", async () => {
  const throttled = new KnowledgeClient("http://127.0.0.1:8111", async () =>
    Response.json(
      {
        code: "rate_limited",
        message: "provider secret response",
        details: { apiKey: "must-not-escape" },
      },
      { status: 429, headers: { "Retry-After": "8" } },
    ),
  );
  const result = await throttled.ask(
    viewer,
    "Bearer valid",
    "How should grain be stored?",
  );
  assert.equal(result.status, 429);
  assert.equal(result.retryAfter, 8);
  assert.deepEqual(result.body, { code: "rate_limited" });
  await withServer(viewer, throttled, async (base) => {
    const response = await fetch(`${base}/v1/knowledge/query`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question: "How should grain be stored?" }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "8");
    assert.deepEqual(await response.json(), { code: "rate_limited" });
  });

  for (const code of ["provider_rate_limited", "gateway_rate_limited"]) {
    const providerThrottled = new KnowledgeClient(
      "http://127.0.0.1:8111",
      async () =>
        Response.json(
          {
            code,
            message: "safe code, private details excluded",
          },
          { status: 429 },
        ),
    );
    const providerLimit = await providerThrottled.ask(
      viewer,
      "Bearer valid",
      "How should grain be stored?",
    );
    assert.equal(providerLimit.status, 429);
    assert.deepEqual(providerLimit.body, { code });
  }

  const configured = new KnowledgeClient("http://127.0.0.1:8111", async () =>
    Response.json(
      {
        code: "assistant_not_configured",
        message: "internal configuration detail",
      },
      { status: 503 },
    ),
  );
  const unavailable = await configured.ask(
    viewer,
    "Bearer valid",
    "How should grain be stored?",
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, { code: "assistant_not_configured" });

  const malicious = new KnowledgeClient("http://127.0.0.1:8111", async () =>
    Response.json(
      {
        code: "database_password=secret",
        error: "postgres://private-host/internal",
      },
      { status: 503 },
    ),
  );
  const sanitized = await malicious.ask(
    viewer,
    "Bearer valid",
    "How should grain be stored?",
  );
  assert.equal(sanitized.status, 503);
  assert.deepEqual(sanitized.body, { code: "service_unavailable" });
});

test("Knowledge 404s normalize code or error fields to not_found and keep HTTP 404", async () => {
  for (const body of [
    { code: "not_found", details: "hidden" },
    { error: "not_found", message: "hidden" },
  ]) {
    const knowledge = new KnowledgeClient("http://127.0.0.1:8111", async () =>
      Response.json(body, { status: 404 }),
    );
    const result = await knowledge.ask(
      viewer,
      "Bearer valid",
      "How should grain be stored?",
    );
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { code: "not_found" });
  }
});

test("Knowledge transport failure and timeout map to separate safe statuses", async () => {
  const networkFailure = new KnowledgeClient(
    "http://127.0.0.1:8111",
    async () => {
      throw new TypeError("socket failure with sensitive host details");
    },
  );
  const unavailable = await networkFailure.ask(
    viewer,
    "Bearer valid",
    "How should grain be stored?",
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, { code: "service_unavailable" });

  const timeout = new KnowledgeClient("http://127.0.0.1:8111", async () => {
    throw new DOMException("internal timeout details", "TimeoutError");
  });
  const timedOut = await timeout.ask(
    viewer,
    "Bearer valid",
    "How should grain be stored?",
  );
  assert.equal(timedOut.status, 504);
  assert.deepEqual(timedOut.body, { code: "service_unavailable" });
});

test("the BFF Redis limiter keeps its rate_limited code separate from a provider 429", async () => {
  let upstreamCalls = 0;
  const knowledge = new KnowledgeClient("http://127.0.0.1:8111", async () => {
    upstreamCalls++;
    return Response.json({ code: "rate_limited" }, { status: 429 });
  });
  const { app, server } = await createApp({
    verify: async () => viewer,
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    knowledge,
    rateLimiter: {
      check: async () => ({ allowed: false, retryAfterSeconds: 4 }),
    },
  });
  const listener = app.listen(0, "127.0.0.1");
  if (!listener.listening) await once(listener, "listening");
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/knowledge/query`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: "How should grain be stored?" }),
      },
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "4");
    assert.deepEqual(await response.json(), { code: "rate_limited" });
    assert.equal(upstreamCalls, 0);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
});

test("explicit PDF summaries forward scope for both query paths without accepting identity fields", async () => {
  const seen: { body: unknown; headers: Headers }[] = [];
  const knowledge = new KnowledgeClient(
    "http://127.0.0.1:8111",
    async (_input, init) => {
      seen.push({
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      return Response.json({ answer: "All pages covered", citations: [] });
    },
  );
  const scope = {
    question: "Summarize every section.",
    mode: "document_summary",
    document_id: "22222222-2222-4222-8222-222222222222",
    document_version: 2,
  };
  await withServer(viewer, knowledge, async (base) => {
    for (const path of [
      "/v1/knowledge/query",
      "/v1/assistant/conversations/33333333-3333-4333-8333-333333333333/messages",
    ]) {
      for (const body of [
        { ...scope, document_id: "not-a-uuid" },
        { ...scope, document_version: 0 },
        { ...scope, document_version: 1.5 },
        { ...scope, document_version: 2147483648 },
        { ...scope, mode: "agent" },
        { ...scope, tenant_id: "attacker" },
        { ...scope, user_id: "attacker" },
        { question: scope.question, document_id: scope.document_id },
      ]) {
        const invalid = await fetch(base + path, {
          method: "POST",
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        assert.equal(invalid.status, 400);
      }
      const result = await fetch(base + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "X-Tenant-ID": "attacker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(scope),
      });
      assert.equal(result.status, 200);
    }
  });
  assert.equal(seen.length, 2);
  for (const request of seen) {
    assert.deepEqual(request.body, scope);
    assert.equal(request.headers.get("X-Tenant-ID"), viewer.tenantId);
    assert.equal(request.headers.get("Authorization"), "Bearer valid");
  }
});

test("summary safety and source-change errors preserve safe public codes", async () => {
  for (const [status, code] of [
    [409, "document_summary_source_changed"],
    [422, "document_summary_too_large"],
    [422, "document_summary_unsafe"],
    [422, "document_summary_incomplete"],
  ] as const) {
    const client = new KnowledgeClient("http://127.0.0.1:8111", async () =>
      Response.json({ detail: code }, { status }),
    );
    const scope = {
      mode: "document_summary" as const,
      document_id: "22222222-2222-4222-8222-222222222222",
      document_version: 1,
    };
    const result = await client.ask(
      viewer,
      "Bearer valid",
      "Summarize every section.",
      scope,
    );
    assert.equal(result.status, status);
    assert.deepEqual(result.body, { code });
  }
});

test("selected document scopes ordinary questions and rejects partial or identity scope", () => {
  const body = {
    question: "What is the target?",
    mode: "question",
    document_id: "22222222-2222-4222-8222-222222222222",
    document_version: 1,
  };
  assert.deepEqual(parseAssistantQuery(body), {
    question: body.question,
    scope: {
      mode: body.mode,
      document_id: body.document_id,
      document_version: 1,
    },
  });
  assert.equal(
    parseAssistantQuery({ ...body, document_version: undefined }),
    null,
  );
  assert.equal(parseAssistantQuery({ ...body, tenant_id: tenantId }), null);
});

test("selected-document questions retain ordinary deadlines and forward cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const knowledge = new KnowledgeClient(
    "http://127.0.0.1:8111",
    async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      return Response.json({
        answer: "No provider call in this fixture",
        citations: [],
      });
    },
  );
  await knowledge.ask(
    viewer,
    "Bearer valid",
    "What is the target?",
    {
      mode: "question",
      document_id: "22222222-2222-4222-8222-222222222222",
      document_version: 1,
    },
    controller.signal,
  );
});

test("source preview proxies PDF bytes with authenticated tenant and private cache headers", async () => {
  const knowledge = new KnowledgeClient(
    "http://127.0.0.1:8111",
    async (input, init) => {
      assert.match(String(input), /versions\/2\/source$/);
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer valid",
      );
      assert.equal(new Headers(init?.headers).get("X-Tenant-ID"), tenantId);
      return new Response("%PDF-1.7\nfixture", {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "inline; filename*=UTF-8''Manual.pdf",
        },
      });
    },
  );
  await withServer(viewer, knowledge, async (base) => {
    const response = await fetch(
      base +
        "/v1/assistant/documents/22222222-2222-4222-8222-222222222222/versions/2/source",
      { headers: { Authorization: "Bearer valid" } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/pdf");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "%PDF-1.7\nfixture");
  });
});

test("source preview rejects malformed binary content and forwards source denial", async () => {
  const knowledge = new KnowledgeClient(
    "http://127.0.0.1:8111",
    async () =>
      new Response("<script>bad</script>", {
        headers: { "Content-Type": "application/pdf" },
      }),
  );
  const result = await knowledge.documentSource(
    viewer,
    "Bearer valid",
    "22222222-2222-4222-8222-222222222222",
    1,
    false,
  );
  assert.equal(result.status, 503);
  assert.equal("pdf" in result, false);
  const denied = new KnowledgeClient("http://127.0.0.1:8111", async () =>
    Response.json({ error: "not_found" }, { status: 404 }),
  );
  assert.equal(
    (
      await denied.documentSource(
        viewer,
        "Bearer valid",
        "22222222-2222-4222-8222-222222222222",
        1,
        false,
      )
    ).status,
    404,
  );
});

test("structured catalog mode is explicit and cannot supply caller identity", () => {
  const body = {
    question: "How many ready PDFs do I have?",
    mode: "structured",
  };
  assert.deepEqual(parseAssistantQuery(body), {
    question: body.question,
    scope: { mode: "structured" },
  });
  assert.equal(parseAssistantQuery({ ...body, tenant_id: tenantId }), null);
  assert.equal(parseAssistantQuery({ ...body, user_id: "injected" }), null);
  assert.equal(parseAssistantQuery({ ...body, document_version: 1 }), null);
});
