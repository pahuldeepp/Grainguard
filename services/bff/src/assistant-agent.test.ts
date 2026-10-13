import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import {
  AssistantAgent,
  AgentRateLimitError,
  validateAgentPlan,
} from "./assistant-agent.js";
import { registerAgentRoutes } from "./assistant-agent-routes.js";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
const p: Principal = {
  issuer: "https://id.example",
  subject: "alice",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  roles: ["operator"],
  expiresAt: new Date(Date.now() + 60000),
};
test("agent schemas reject authority injection and direct execution", () => {
  assert.throws(() => validateAgentPlan({ tool: "execute_alert", args: {} }));
  assert.throws(() =>
    validateAgentPlan({
      tool: "get_alert",
      args: {
        alert_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        tenant_id: "foreign",
      },
    }),
  );
  assert.throws(() =>
    validateAgentPlan({
      tool: "propose_acknowledge_alert",
      args: {
        alert_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        etag: "evil",
        note: "ack",
      },
    }),
  );
  assert.equal(
    validateAgentPlan({
      tool: "search_knowledge",
      args: { query: "grain moisture", k: 5 },
    }).tool,
    "search_knowledge",
  );
});
test("fresh identity changed after planning denies MCP call", async () => {
  let verifies = 0,
    calls = 0;
  const agent = {
    jwks: { keys: [] },
    plan: async () => ({ tool: "get_alert", args: { alert_id: p.tenantId } }),
    call: async () => {
      calls++;
      return {};
    },
  } as unknown as AssistantAgent;
  const app = express();
  registerAgentRoutes(app, {
    agent,
    verify: async () =>
      ++verifies === 1
        ? p
        : { ...p, tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    rateLimiter: {
      check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const r = await fetch(
      `http://127.0.0.1:${address.port}/v1/assistant/agent`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: "Read this alert" }),
      },
    );
    assert.equal(r.status, 403);
    assert.equal(calls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("MCP call mints and forwards only the selected owner audience and scope", async () => {
  const calls: string[] = [];
  const ownerCases = [
    [
      { tool: "search_knowledge", args: { query: "grain moisture", k: 3 } },
      "knowledge-service",
      "knowledge:read",
      "knowledge",
    ],
    [
      { tool: "get_alert", args: { alert_id: p.tenantId } },
      "workflow-alerts",
      "alerts:read",
      "alerts_read",
    ],
    [
      { tool: "get_risk", args: { device_id: p.tenantId } },
      "read-api",
      "telemetry:read",
      "read",
    ],
    [
      {
        tool: "propose_acknowledge_alert",
        args: { alert_id: p.tenantId, etag: '"17"', note: "Please review" },
      },
      "grain-advisor",
      "advisor:propose",
      "advisor_propose",
    ],
  ] as const;
  for (const [plan, audience, scope, ownerKey] of ownerCases) {
    let captured: RequestInit | undefined;
    const agent = new AssistantAgent(
      "http://127.0.0.1:18089",
      "http://127.0.0.1:58093",
      "base",
      "model",
      {
        mint: async (_principal, audience, scope) => {
          calls.push(`${audience}:${scope}`);
          return `base:${scope}`;
        },
      },
      {} as import("./advisor.js").AdvisorClient,
      {},
      async (_input, init) => {
        captured = init;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "run-id",
            result: { content: [{ type: "text", text: "owner result" }] },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      undefined,
      {
        mint: async (_principal, actualAudience, actualScope) => {
          calls.push(`${actualAudience}:${actualScope}`);
          return `owner:${actualAudience}:${actualScope}`;
        },
      },
    );
    await agent.call(p, plan, "run-id");
    assert(captured);
    const headers = new Headers(captured.headers);
    assert.deepEqual(
      JSON.parse(headers.get("X-GG-Owner-Delegations") ?? "{}"),
      { [ownerKey]: `owner:${audience}:${scope}` },
    );
    assert.equal(
      headers.get("Authorization"),
      `Bearer base:${plan.tool === "propose_acknowledge_alert" ? "tools:propose" : "tools:read"}`,
    );
  }
  assert.deepEqual(calls, [
    "greenguard-mcp:tools:read",
    "knowledge-service:knowledge:read",
    "greenguard-mcp:tools:read",
    "workflow-alerts:alerts:read",
    "greenguard-mcp:tools:read",
    "read-api:telemetry:read",
    "greenguard-mcp:tools:propose",
    "grain-advisor:advisor:propose",
  ]);
  assert.equal(calls.includes("workflow-alerts:alerts:acknowledge"), false);
});
test("viewer cannot approve, including an exact hash and version", async () => {
  let minted = 0;
  const agent = {
    jwks: { keys: [] },
    delegation: {
      mint: async () => {
        minted++;
        return "token";
      },
    },
  } as unknown as AssistantAgent;
  const app = express();
  registerAgentRoutes(app, {
    agent,
    verify: async () => ({ ...p, roles: ["viewer"] }),
    rateLimiter: {
      check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const a = server.address();
    assert(a && typeof a !== "string");
    const r = await fetch(
      `http://127.0.0.1:${a.port}/v1/advisor/proposals/${p.tenantId}/decision`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": p.tenantId,
          "If-Match": '"1"',
        },
        body: JSON.stringify({
          decision: "approved",
          action_hash: "a".repeat(64),
          version: 1,
        }),
      },
    );
    assert.equal(r.status, 403);
    assert.equal(minted, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("read loop inspects results then stops and synthesizes a final answer", async () => {
  let plans = 0,
    calls = 0,
    syntheses = 0;
  const agent = {
    jwks: { keys: [] },
    plan: async (_p: Principal, _q: string, observations: string[]) => {
      plans++;
      return observations.length
        ? { tool: "abstain", args: {} }
        : { tool: "search_knowledge", args: { query: "grain moisture", k: 5 } };
    },
    call: async () => {
      calls++;
      return {
        tool: "search_knowledge",
        content: [
          { type: "text", text: '{"answer":"13 percent","citations":[]}' },
        ],
      };
    },
    respond: async (_p: Principal, _q: string, observations: string[]) => {
      syntheses++;
      assert.equal(observations.length, 1);
      return {
        content: [{ type: "text", text: "Store at 13 percent." }],
        observation_ids: ["1"],
      };
    },
  } as unknown as AssistantAgent;
  const app = express();
  registerAgentRoutes(app, {
    agent,
    verify: async () => p,
    rateLimiter: {
      check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const a = server.address();
    assert(a && typeof a !== "string");
    const r = await fetch(`http://127.0.0.1:${a.port}/v1/assistant/agent`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question: "What grain moisture?" }),
    });
    assert.equal(r.status, 200);
    assert.equal(plans, 2);
    assert.equal(calls, 1);
    assert.equal(syntheses, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Gateway caller tokens selected only from authenticated tenant", async () => {
  const { AdvisorClient } = await import("./advisor.js");
  const seen: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get("Authorization")!);
    return Response.json({
      tool: "search_knowledge",
      args: { query: "grain moisture", k: 5 },
    });
  };
  const agent = new AssistantAgent(
    "http://127.0.0.1:1",
    "http://127.0.0.1:2",
    "",
    "answer-v1",
    { mint: async () => "delegated" },
    new AdvisorClient("http://127.0.0.1:3"),
    { keys: [] },
    fetcher,
    {
      [p.tenantId]: "a".repeat(32),
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb": "b".repeat(32),
    },
  );
  await agent.plan(p, "grain moisture");
  await agent.plan(
    { ...p, tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    "grain moisture",
  );
  assert.deepEqual(seen, [
    "Bearer " + "a".repeat(32),
    "Bearer " + "b".repeat(32),
  ]);
  await assert.rejects(() =>
    agent.plan(
      { ...p, tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      "grain moisture",
    ),
  );
  assert.equal(seen.length, 2);
});

test("approved operator action uses real limiter charge and newly minted scoped owner token", async () => {
  const { redisRateLimiter } = await import("./rate-limit.js");
  let evaluations = 0;
  const minted: string[] = [];
  let forwarded: Record<string, string> | undefined;
  const agent = {
    jwks: { keys: [] },
    delegation: {
      mint: async (_p: Principal, a: string, s: string) => {
        minted.push(a + ":" + s);
        return "fresh-" + s;
      },
    },
    advisor: {
      request: async (
        _p: Principal,
        _t: string,
        _path: string,
        _body: unknown,
        headers: Record<string, string>,
      ) => {
        forwarded = headers;
        return {
          status: 200,
          body: { status: "approved", execution_status: "succeeded" },
        };
      },
    },
  } as unknown as AssistantAgent;
  const app = express();
  registerAgentRoutes(app, {
    agent,
    verify: async () => p,
    rateLimiter: redisRateLimiter({
      eval: async () => {
        evaluations++;
        return [1, 0];
      },
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const a = server.address();
    assert(a && typeof a !== "string");
    const r = await fetch(
      `http://127.0.0.1:${a.port}/v1/advisor/proposals/${p.tenantId}/decision`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer external-user-token",
          "Content-Type": "application/json",
          "Idempotency-Key": p.tenantId,
          "If-Match": '"1"',
        },
        body: JSON.stringify({
          decision: "approved",
          action_hash: "a".repeat(64),
          version: 1,
        }),
      },
    );
    assert.equal(r.status, 200);
    assert.equal(evaluations, 1);
    assert.deepEqual(minted, [
      "grain-advisor:advisor:decide",
      "workflow-alerts:alerts:acknowledge",
    ]);
    assert.equal(
      forwarded?.["X-Owner-Delegated-Token"],
      "Bearer fresh-alerts:acknowledge",
    );
    assert.equal(forwarded?.["If-Match"], '"1"');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const revoke of [false, true])
  test(`Agent preserves selected PDF citations and final ACL ${revoke ? "revocation" : "authorization"}`, async () => {
    const selected = {
      document_id: "12345678-abcd-4000-8000-000000000001",
      document_version: 2,
    };
    const citation = {
      ...selected,
      chunk_id: "12345678-abcd-4000-8000-000000000002",
      page_start: 3,
      page_end: 3,
    };
    let revoked = false;
    const agent = {
      jwks: {},
      plan: async (_p: Principal, _q: string, observations: string[]) =>
        observations.length
          ? { tool: "abstain", args: {} }
          : {
              tool: "search_knowledge",
              args: { query: "grain moisture", k: 5 },
            },
      call: async (
        _p: Principal,
        _plan: unknown,
        _run: string,
        _signal: unknown,
        scope: unknown,
      ) => {
        assert.deepEqual(scope, selected);
        return {
          tool: "search_knowledge",
          content: [
            {
              type: "text",
              text: JSON.stringify({ answer: "fact", citations: [citation] }),
            },
          ],
        };
      },
      respond: async () => {
        revoked = revoke;
        return {
          tool: "answer",
          content: [{ type: "text", text: "fact" }],
          observation_ids: ["1"],
        };
      },
    } as unknown as AssistantAgent;
    const app = express();
    registerAgentRoutes(app, {
      agent,
      verify: async () => p,
      rateLimiter: {
        check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      },
      knowledge: {
        documentSource: async () => ({ status: revoked ? 404 : 200, body: {} }),
      } as unknown as import("./knowledge.js").KnowledgeClient,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/assistant/agent`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: "What grain moisture?",
            selected_document: selected,
          }),
        },
      );
      assert.equal(response.status, revoke ? 403 : 200);
      const body = await response.json();
      if (!revoke) assert.deepEqual(body.citations, [citation]);
      else assert.equal(body.content, undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

test("Agent owner pacing retains 429 and Retry-After", async () => {
  const app = express();
  registerAgentRoutes(app, {
    agent: {
      jwks: { keys: [] },
      plan: async () => {
        throw new AgentRateLimitError(17);
      },
    } as unknown as AssistantAgent,
    verify: async () => p,
    rateLimiter: {
      check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/assistant/agent`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: "temperature" }),
      },
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "17");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Gateway planning and final generation preserve upstream cooldowns", async () => {
  const agent = new AssistantAgent(
    "http://127.0.0.1:18089",
    "http://127.0.0.1:58093",
    "test-token",
    "test-model",
    { mint: async () => "test" },
    {} as import("./advisor.js").AdvisorClient,
    {},
    async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "26" } }),
  );
  await assert.rejects(
    agent.plan(p, "temperature"),
    (error) =>
      error instanceof AgentRateLimitError && error.retryAfterSeconds === 26,
  );
  await assert.rejects(
    agent.respond(p, "temperature", ["authorized facts"]),
    (error) =>
      error instanceof AgentRateLimitError && error.retryAfterSeconds === 26,
  );
});

test("device serial is resolved before planning and revocation during lookup blocks model calls", async () => {
  let revoked = false,
    checks = 0,
    plans = 0;
  const deviceId = "ebd4596c-5143-49c9-9cac-9b7647e97df4";
  const agent = {
    jwks: { keys: [] },
    plan: async (_p: unknown, q: string) => {
      plans++;
      assert(q.includes(deviceId));
      assert(!q.includes("DEMO-SENSOR-1"));
      return { tool: "abstain", args: {} };
    },
    call: async () => ({ answer: "No current sensor readings are available." }),
  } as unknown as AssistantAgent;
  const app = express();
  registerAgentRoutes(app, {
    agent,
    agentDevice: {
      resolve: async (serial: string, auth: string) => {
        assert.equal(serial, "DEMO-SENSOR-1");
        assert.equal(auth, "Bearer test");
        revoked = checks > 2;
        return deviceId;
      },
    } as never,
    verify: async () => {
      checks++;
      if (revoked) throw new AuthError(403, "invalid_claims");
      return p;
    },
    rateLimiter: {
      check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const a = server.address();
    assert(a && typeof a !== "string");
    const send = () =>
      fetch(`http://127.0.0.1:${a.port}/v1/assistant/agent`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: "DEMO-SENSOR-1",
        }),
      });
    assert.equal((await send()).status, 200);
    const before = plans;
    assert.equal((await send()).status, 403);
    assert.equal(plans, before);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

for (const scenario of [
  "reformulated",
  "reordered duplicate",
  "cross document",
  "revoked between searches",
  "tenant changed between searches",
  "cooldown retry",
  "cooldown ACL revoked",
  "cooldown deadline",
] as const)
  test(`Agent repeated retrieval: ${scenario}`, async () => {
    const selected = {
      document_id: "12345678-abcd-4000-8000-000000000001",
      document_version: 2,
    };
    const other = "12345678-abcd-4000-8000-000000000099";
    let calls = 0;
    let plans = 0;
    let responses = 0;
    let afterCooldown = false;
    const scopes: unknown[] = [];
    const contexts: string[][] = [];
    const agent = {
      jwks: {},
      plan: async (
        _principal: Principal,
        _question: string,
        observations: string[],
      ) => {
        contexts.push([...observations]);
        plans++;
        if (plans > 2 || (scenario.startsWith("cooldown") && plans > 1))
          return { tool: "abstain", args: {} };
        return {
          tool: "search_knowledge",
          args:
            plans === 2 && scenario === "reordered duplicate"
              ? { k: 5, query: "moisture threshold" }
              : {
                  query:
                    plans === 1
                      ? "moisture threshold"
                      : "temperature correction",
                  k: 5,
                },
        };
      },
      call: async (
        _principal: Principal,
        _plan: unknown,
        _run: string,
        _signal: unknown,
        scope: unknown,
      ) => {
        calls++;
        if (scenario.startsWith("cooldown") && calls === 1)
          throw new AgentRateLimitError(1);
        scopes.push(scope);
        return {
          tool: "search_knowledge",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                answer:
                  calls === 1
                    ? "Threshold is 13 percent; correction missing."
                    : "Correction is 2 percent.",
                citations: [
                  {
                    ...selected,
                    document_id:
                      scenario === "cross document"
                        ? other
                        : selected.document_id,
                    chunk_id: `12345678-abcd-4000-8000-00000000000${calls + 1}`,
                    page_start: calls,
                    page_end: calls,
                  },
                ],
              }),
            },
          ],
        };
      },
      respond: async () => {
        responses++;
        return {
          tool: "answer",
          content: [
            { type: "text", text: "13 percent with 2 percent correction." },
          ],
          observation_ids:
            calls === 2 && !scenario.startsWith("cooldown")
              ? ["1", "2"]
              : ["1"],
        };
      },
    } as unknown as AssistantAgent;
    const app = express();
    registerAgentRoutes(app, {
      agent,
      verify: async () =>
        scenario === "tenant changed between searches" && calls > 0
          ? { ...p, tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
          : p,
      runTimeoutMs: scenario === "cooldown deadline" ? 20 : 120000,
      cooldownWait: async (_ms, signal) => {
        assert.equal(signal.aborted, false);
        afterCooldown = true;
      },
      rateLimiter: {
        check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      },
      knowledge: {
        documentSource: async () => ({
          status:
            (scenario === "revoked between searches" && calls > 0) ||
            (scenario === "cooldown ACL revoked" && afterCooldown)
              ? 404
              : 200,
          body: {},
        }),
      } as unknown as import("./knowledge.js").KnowledgeClient,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/assistant/agent`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: "Compare moisture threshold and temperature correction.",
            selected_document: selected,
          }),
        },
      );
      const body = await response.json();
      const denied = [
        "cross document",
        "revoked between searches",
        "tenant changed between searches",
        "cooldown ACL revoked",
        "cooldown deadline",
      ].includes(scenario);
      assert.equal(
        response.status,
        scenario === "cross document"
          ? 503
          : scenario === "cooldown deadline"
            ? 429
            : denied
              ? 403
              : 200,
      );
      if (denied) {
        assert.equal(calls, 1);
        assert.equal(responses, 0);
        assert.equal(body.content, undefined);
      } else {
        assert.equal(
          calls,
          ["reformulated", "cooldown retry"].includes(scenario) ? 2 : 1,
        );
        assert.equal(
          body.tool_calls,
          scenario === "cooldown retry" ? 1 : calls,
        );
        assert.equal(
          body.citations.length,
          scenario === "cooldown retry" ? 1 : calls,
        );
        assert.equal(contexts[1]?.length, 1);
        if (scenario !== "cooldown retry")
          assert.match(contexts[1]![0]!, /correction missing/);
        for (const scope of scopes) assert.deepEqual(scope, selected);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

test("structured and device fact tools reject injected authority and unbounded ranges", () => {
  assert.equal(
    validateAgentPlan({
      tool: "query_structured_knowledge",
      args: { question: "Count ready PDFs" },
    }).tool,
    "query_structured_knowledge",
  );
  assert.throws(() =>
    validateAgentPlan({
      tool: "query_structured_knowledge",
      args: { question: "Count ready PDFs", tenant_id: p.tenantId },
    }),
  );
  assert.equal(
    validateAgentPlan({
      tool: "query_device_facts",
      args: { device_id: p.tenantId, operation: "device_alerts" },
    }).tool,
    "query_device_facts",
  );
  for (const extra of [
    { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" },
    { tenant_id: p.tenantId },
    { bucket: "hour" },
  ])
    assert.throws(() =>
      validateAgentPlan({
        tool: "query_device_facts",
        args: { device_id: p.tenantId, operation: "device_alerts", ...extra },
      }),
    );
  const args = {
    device_id: p.tenantId,
    operation: "telemetry_rollups",
    from: "2026-10-01T00:00:00Z",
    to: "2026-10-02T00:00:00Z",
    bucket: "hour",
  };
  assert.equal(
    validateAgentPlan({ tool: "query_device_facts", args }).tool,
    "query_device_facts",
  );
  for (const invalid of [
    { ...args, to: "2027-01-01T00:00:00Z" },
    { ...args, sql: "SELECT secret" },
    { ...args, bucket: "minute" },
    { ...args, from: args.to },
  ])
    assert.throws(() =>
      validateAgentPlan({ tool: "query_device_facts", args: invalid }),
    );
});

test("structured Agent evidence is replayed before final answer and changes deny", async () => {
  for (const revoked of [false, true]) {
    let replays = 0,
      responds = 0,
      plans = 0;
    const evidence = {
      operation: "count",
      status: "ready",
      answer_sha256: createHash("sha256").update("2 ready PDFs").digest("hex"),
    };
    const agent = {
      jwks: { keys: [] },
      plan: async () =>
        ++plans === 1
          ? {
              tool: "query_structured_knowledge",
              args: { question: "How many ready PDFs?" },
            }
          : { tool: "abstain", args: {} },
      call: async () => ({
        tool: "query_structured_knowledge",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answer: "2 ready PDFs",
              citations: [],
              structured_evidence: evidence,
            }),
          },
        ],
      }),
      respond: async () => {
        responds++;
        return {
          observation_ids: ["1"],
          content: [{ type: "text", text: "2 ready PDFs" }],
        };
      },
    } as unknown as AssistantAgent;
    const app = express();
    registerAgentRoutes(app, {
      agent,
      verify: async () => p,
      rateLimiter: {
        check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      },
      knowledge: {
        authorizeStructured: async () => {
          replays++;
          return {
            status: revoked ? 403 : 200,
            body: { authorized: !revoked },
          };
        },
      } as never,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    try {
      const addr = server.address();
      assert(addr && typeof addr !== "string");
      const response = await fetch(
        `http://127.0.0.1:${addr.port}/v1/assistant/agent`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ question: "How many ready PDFs do I have?" }),
        },
      );
      assert.equal(response.status, revoked ? 403 : 200);
      assert(replays >= 1);
      assert.equal(responds, revoked ? 0 : 1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});

test("Agent capacity is bounded and released after completion", async () => {
  let release!: () => void,
    entered!: () => void,
    plans = 0;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const agent = {
    jwks: { keys: [] },
    plan: async () => {
      if (++plans === 1) {
        entered();
        await gate;
      }
      return { tool: "abstain", args: {} };
    },
    call: async () => ({
      content: [{ type: "text", text: "Need a device ID" }],
    }),
  } as unknown as AssistantAgent;
  const app = express();
  registerAgentRoutes(app, {
    agent,
    maxConcurrentRuns: 1,
    verify: async () => p,
    rateLimiter: {
      check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const addr = server.address();
    assert(addr && typeof addr !== "string");
    const request = () =>
      fetch(`http://127.0.0.1:${addr.port}/v1/assistant/agent`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: "Read device facts" }),
      });
    const first = request();
    await started;
    const second = await request();
    assert.equal(second.status, 503);
    assert.equal(second.headers.get("Retry-After"), "2");
    assert.equal((await second.json()).code, "agent_capacity_exhausted");
    release();
    assert.equal((await first).status, 200);
    assert.equal((await request()).status, 200);
  } finally {
    release();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("device evidence changes before or after generation block final answer", async () => {
  for (const [operation, changeAt] of [
    ["telemetry_latest", 2],
    ["telemetry_latest", 3],
    ["device_alerts", 2],
    ["device_alerts", 3],
  ] as const) {
    let calls = 0,
      plans = 0,
      responds = 0;
    const agent = {
      jwks: { keys: [] },
      plan: async () =>
        ++plans === 1
          ? {
              tool: "query_device_facts",
              args: { device_id: p.tenantId, operation },
            }
          : { tool: "abstain", args: {} },
      call: async () => ({
        tool: "query_device_facts",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: { temperature_c: ++calls >= changeAt ? 99 : 20 },
            }),
          },
        ],
      }),
      respond: async () => {
        responds++;
        return {
          observation_ids: ["1"],
          content: [{ type: "text", text: "20 degrees" }],
        };
      },
    } as unknown as AssistantAgent;
    const app = express();
    registerAgentRoutes(app, {
      agent,
      verify: async () => p,
      rateLimiter: {
        check: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    try {
      const addr = server.address();
      assert(addr && typeof addr !== "string");
      const response = await fetch(
        `http://127.0.0.1:${addr.port}/v1/assistant/agent`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: `Read latest facts for device ${p.tenantId}`,
          }),
        },
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "device_evidence_changed");
      assert.equal(responds, changeAt === 2 ? 0 : 1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});

for (const format of [
  "json",
  "sse notifications",
  "sse CRLF multiline",
  "sse missing ID",
  "sse duplicate ID",
  "sse unterminated",
] as const)
  test(`MCP response framing: ${format}`, async () => {
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const response = {
      jsonrpc: "2.0",
      id: runId,
      result: { content: [{ type: "text", text: "authorized facts" }] },
    };
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progress: 1 },
    };
    const unrelated = {
      ...response,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    const frame = (value: unknown) => `data:${JSON.stringify(value)}\n\n`;
    const raw =
      format === "json"
        ? JSON.stringify(response)
        : format === "sse CRLF multiline"
          ? ': keepalive\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":"' +
            runId +
            '","result":{"content":[{"type":"text","text":"authorized facts"}]}}\r\n\r\n'
          : format === "sse missing ID"
            ? frame(notification) + frame(unrelated)
            : format === "sse duplicate ID"
              ? frame(response) + frame(response)
              : format === "sse unterminated"
                ? frame(response).slice(0, -2)
                : frame(notification) +
                  frame(unrelated) +
                  ": keepalive\n\n" +
                  frame(response);
    const agent = new AssistantAgent(
      "http://127.0.0.1:18089",
      "http://127.0.0.1:58093",
      "token",
      "model",
      { mint: async () => "delegated" },
      {} as import("./advisor.js").AdvisorClient,
      {},
      async () =>
        new Response(raw, {
          headers: {
            "Content-Type":
              format === "json" ? "application/json" : "text/event-stream",
          },
        }),
    );
    const call = () =>
      agent.call(p, { tool: "get_alert", args: { alert_id: runId } }, runId);
    if (
      ["sse missing ID", "sse duplicate ID", "sse unterminated"].includes(
        format,
      )
    )
      await assert.rejects(call, /agent tool unavailable/);
    else assert.deepEqual((await call()).content, response.result.content);
  });

test("Advisor mesh HTTP is limited to exact Kubernetes Service DNS and explicit opt-in", async () => {
  const { AdvisorClient } = await import("./advisor.js");
  const previous = process.env.GG_MESH_INTERNAL_HTTP;
  try {
    delete process.env.GG_MESH_INTERNAL_HTTP;
    assert.throws(
      () =>
        new AdvisorClient(
          "http://grain-advisor.greenguard.svc.cluster.local:8088",
        ),
      /unsafe advisor URL/,
    );
    process.env.GG_MESH_INTERNAL_HTTP = "1";
    assert.doesNotThrow(
      () =>
        new AdvisorClient(
          "http://grain-advisor.greenguard.svc.cluster.local:8088",
        ),
    );
    for (const url of [
      "http://attacker.example",
      "http://user@grain-advisor.greenguard.svc",
      "http://grain-advisor.greenguard.svc/path",
    ])
      assert.throws(() => new AdvisorClient(url), /unsafe advisor URL/);
  } finally {
    if (previous === undefined) delete process.env.GG_MESH_INTERNAL_HTTP;
    else process.env.GG_MESH_INTERNAL_HTTP = previous;
  }
});
