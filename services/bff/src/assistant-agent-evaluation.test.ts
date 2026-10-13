import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import {
  AssistantAgent,
  type AgentPlan,
  validateAgentPlan,
} from "./assistant-agent.js";
import { registerAgentRoutes } from "./assistant-agent-routes.js";

// Authored synthetic contract fixtures, no independent human labels or live model.
const principal: Principal = {
  issuer: "https://id.example",
  subject: "synthetic-operator",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  roles: ["operator"],
  expiresAt: new Date(Date.now() + 60000),
};
const latest: AgentPlan = {
  tool: "query_device_facts",
  args: {
    device_id: principal.tenantId,
    operation: "telemetry_latest",
  },
};
const count: AgentPlan = {
  tool: "query_structured_knowledge",
  args: {
    question: "How many ready PDFs?",
  },
};
const search: AgentPlan = {
  tool: "search_knowledge",
  args: {
    query: "safe grain moisture",
    k: 5,
  },
};
const citation = {
  document_id: principal.tenantId,
  document_version: 1,
  chunk_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
  page_start: 1,
  page_end: 1,
};

for (const scenario of [
  "mixed count device",
  "mixed PDF device",
  "revoked between tools",
  "revoked after generation",
  "missing readings",
  "approval required",
  "owner unavailable",
] as const) {
  test(`authored Agent evaluation: ${scenario}`, async () => {
    let revoked = false;
    let plans = 0;
    let responses = 0;
    const errors: unknown[] = [];
    const originalError = console.error;
    if (scenario === "owner unavailable")
      console.error = (...values) => {
        errors.push(values);
      };
    const observed: AgentPlan[] = [];
    const sequence: AgentPlan[] =
      scenario === "owner unavailable"
        ? [latest]
        : scenario === "missing readings"
          ? [{ tool: "get_risk", args: { device_id: principal.tenantId } }]
          : scenario === "approval required"
            ? [
                {
                  tool: "propose_acknowledge_alert",
                  args: {
                    alert_id: principal.tenantId,
                    etag: '"1"',
                    note: "Reviewed",
                  },
                },
              ]
            : [scenario === "mixed count device" ? count : search, latest];
    const agent = {
      jwks: { keys: [] },
      plan: async (_p: Principal, _q: string, observations: string[]) => {
        assert.equal(observations.length, Math.min(plans, sequence.length));
        return sequence[plans++] ?? { tool: "abstain", args: {} };
      },
      call: async (_p: Principal, plan: AgentPlan) => {
        validateAgentPlan(plan);
        if (scenario === "owner unavailable")
          throw new Error("PRIVATE-SYNTHETIC-CANARY");
        // Fact replay is deliberately not counted as a new planned tool.
        if (observed.length < sequence.length) observed.push(plan);
        if (scenario === "revoked between tools") revoked = true;
        if (plan.tool === "get_risk")
          return { content: [{ type: "text", text: '{"data":null}' }] };
        if (plan.tool === "propose_acknowledge_alert")
          return { proposal_id: principal.tenantId };
        const body =
          plan.tool === "query_structured_knowledge"
            ? {
                answer: "2 ready PDFs",
                citations: [],
                structured_evidence: {
                  operation: "count",
                  status: "ready",
                  answer_sha256: createHash("sha256")
                    .update("2 ready PDFs")
                    .digest("hex"),
                },
              }
            : plan.tool === "search_knowledge"
              ? { answer: "13 percent", citations: [citation] }
              : { data: { temperature_c: 20 } };
        return {
          tool: plan.tool,
          content: [{ type: "text", text: JSON.stringify(body) }],
        };
      },
      respond: async (_p: Principal, _q: string, observations: string[]) => {
        responses++;
        assert.equal(observations.length, 2);
        assert.match(observations[0]!, /2 ready PDFs|13 percent/);
        assert.match(observations[1]!, /temperature_c/);
        if (scenario === "revoked after generation") revoked = true;
        return {
          content: [
            { type: "text", text: "13 percent; 2 ready PDFs; 20 degrees" },
          ],
          observation_ids: ["1", "2"],
        };
      },
    } as unknown as AssistantAgent;
    const app = express();
    registerAgentRoutes(app, {
      agent,
      verify: async () => {
        if (revoked) throw new AuthError(403, "invalid_claims");
        return principal;
      },
      knowledge: {
        documentSource: async () => ({ status: 200, body: {} }),
        authorizeStructured: async () => ({
          status: 200,
          body: { authorized: true },
        }),
      } as never,
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
            Authorization: "Bearer synthetic",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: "Compare authorized PDF facts and explicit device facts",
          }),
        },
      );
      const body = await response.json();
      const denied = scenario.startsWith("revoked");
      assert.equal(
        response.status,
        scenario === "owner unavailable" ? 503 : denied ? 403 : 200,
      );
      if (scenario === "owner unavailable") {
        assert.equal(body.content, undefined);
        assert.equal(responses, 0);
        const encoded = JSON.stringify(errors);
        assert.match(encoded, /query_device_facts/);
        assert.match(encoded, /dependency_failure/);
        assert.doesNotMatch(
          encoded,
          /PRIVATE-SYNTHETIC-CANARY|tenantId|device_id/,
        );
        return;
      }
      if (denied) {
        assert.equal(body.content, undefined);
        assert.equal(
          responses,
          scenario === "revoked after generation" ? 1 : 0,
        );
        assert.equal(
          observed.length,
          scenario === "revoked between tools" ? 1 : 2,
        );
      } else if (scenario === "missing readings") {
        assert.equal(responses, 0);
        assert.match(body.content[0].text, /No stored readings/);
        assert.doesNotMatch(body.content[0].text, /20 degrees/);
      } else if (scenario === "approval required") {
        assert.equal(body.approval_required, true);
        assert.equal(responses, 0);
        assert.equal(body.execution_status, undefined);
      } else {
        assert.equal(responses, 1);
        assert.deepEqual(observed, sequence);
        assert.deepEqual(
          body.tools_used,
          sequence.map((plan) => plan.tool),
        );
        assert.equal(body.tool_calls, 2);
        assert.equal(
          body.citations.length,
          scenario === "mixed PDF device" ? 1 : 0,
        );
      }
    } finally {
      if (scenario === "owner unavailable") console.error = originalError;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
