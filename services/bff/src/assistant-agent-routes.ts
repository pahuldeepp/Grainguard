import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { AgentDeviceLookup, AgentDeviceError } from "./agent-device.js";
import express, { type Express } from "express";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import {
  AssistantAgent,
  type AgentPlan,
  AgentRateLimitError,
  randomUUID,
} from "./assistant-agent.js";
import { boundedRateCheck, type RateLimiter } from "./rate-limit.js";
import type { KnowledgeClient } from "./knowledge.js";

export function registerAgentRoutes(
  app: Express,
  options: {
    agent?: AssistantAgent;
    verify: (auth: string | undefined) => Promise<Principal>;
    rateLimiter?: RateLimiter;
    rateCheckTimeoutMs?: number;
    knowledge?: KnowledgeClient;
    agentDevice?: AgentDeviceLookup;
    runTimeoutMs?: number;
    maxConcurrentRuns?: number;
    cooldownWait?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
) {
  const capacity = options.maxConcurrentRuns ?? 4;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64)
    throw new Error("invalid Agent concurrency capacity");
  let activeRuns = 0;
  const tenantRuns = new Map<string, number>();
  const tenantCapacity = Math.max(1, Math.ceil(capacity / 2));
  if (options.agent)
    app.get("/.well-known/delegated-jwks.json", (_req, res) =>
      res.json(options.agent!.jwks),
    );
  const human = async (auth: string | undefined) => {
    const p = await options.verify(auth);
    if (p.principalType === "service" || !p.issuer)
      throw new AuthError(403, "invalid_claims");
    return p;
  };
  app.post(
    "/v1/assistant/agent",
    express.json({ limit: "8kb" }),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      let stage = "authentication";
      let chosenTool = "none";
      let releaseRun: (() => void) | undefined;
      try {
        const p = await human(req.header("Authorization"));
        if (!options.agent) {
          res.status(503).json({ code: "agent_not_configured" });
          return;
        }
        if (
          !req.body ||
          typeof req.body !== "object" ||
          Array.isArray(req.body) ||
          Object.keys(req.body).some(
            (key) => !["question", "selected_document"].includes(key),
          ) ||
          typeof req.body.question !== "string" ||
          req.body.question.trim().length < 4 ||
          req.body.question.length > 2000
        ) {
          res.status(400).json({ code: "invalid_request" });
          return;
        }
        const scope = req.body.selected_document as
          { document_id: string; document_version: number } | undefined;
        if (
          scope !== undefined &&
          (!scope ||
            typeof scope !== "object" ||
            Array.isArray(scope) ||
            Object.keys(scope)
              .sort((a, b) => (a < b ? -1 : Number(a > b)))
              .join() !== "document_id,document_version" ||
            typeof scope.document_id !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              scope.document_id,
            ) ||
            !Number.isSafeInteger(scope.document_version) ||
            scope.document_version < 1 ||
            scope.document_version > 2147483647)
        ) {
          res.status(400).json({ code: "invalid_request" });
          return;
        }
        if (!options.rateLimiter) {
          res.status(503).json({ code: "rate_limit_unavailable" });
          return;
        }
        const limit = await boundedRateCheck(
          options.rateLimiter.check(p, { query: "knowledgeQuery" }),
          options.rateCheckTimeoutMs ?? 1000,
        );
        if (!limit.allowed) {
          res.setHeader("Retry-After", String(limit.retryAfterSeconds));
          res.status(429).json({ code: "rate_limited" });
          return;
        }
        const tenantActive = tenantRuns.get(p.tenantId) ?? 0;
        if (activeRuns >= capacity || tenantActive >= tenantCapacity) {
          res.setHeader("Retry-After", "2");
          res.status(503).json({ code: "agent_capacity_exhausted" });
          return;
        }
        activeRuns++;
        tenantRuns.set(p.tenantId, tenantActive + 1);
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            activeRuns--;
            const remaining = (tenantRuns.get(p.tenantId) ?? 1) - 1;
            if (remaining > 0) tenantRuns.set(p.tenantId, remaining);
            else tenantRuns.delete(p.tenantId);
            res.off("finish", release);
            res.off("close", release);
          }
        };
        releaseRun = release;
        res.once("finish", release);
        res.once("close", release);
        const runId = randomUUID();
        const observations: string[] = [];
        const calls = new Set<string>();
        const factReads: { plan: AgentPlan; observation: string }[] = [];
        let cooldownRetried = false;
        const disconnect = new AbortController();
        const close = () => {
          if (!res.writableEnded) disconnect.abort();
        };
        res.once("close", close);
        res.once("finish", () => res.off("close", close));
        const deadline = Date.now() + (options.runTimeoutMs ?? 120000);
        const signal = AbortSignal.any([
          AbortSignal.timeout(options.runTimeoutMs ?? 120000),
          disconnect.signal,
        ]);
        const freshPrincipal = async () => {
          const fresh = await human(req.header("Authorization"));
          if (
            fresh.tenantId !== p.tenantId ||
            fresh.subject !== p.subject ||
            fresh.issuer !== p.issuer
          )
            throw new AuthError(403, "invalid_claims");
          return fresh;
        };
        let question = req.body.question as string;
        const serialOnly =
          /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(question.trim()) &&
          /[0-9_-]/.test(question.trim());
        const serial = serialOnly
          ? question.trim()
          : question.match(
              /\bdevice\s+([A-Za-z0-9][A-Za-z0-9_-]{2,127})\b/i,
            )?.[1];
        if (
          serial &&
          /[0-9_-]/.test(serial) &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            serial,
          )
        ) {
          stage = "device_resolution";
          if (!options.agentDevice)
            throw new AgentDeviceError(503, "device_lookup_unavailable");
          const deviceId = await options.agentDevice.resolve(
            serial,
            req.header("Authorization")!,
            signal,
          );
          await freshPrincipal();
          question = serialOnly
            ? `Read the latest available telemetry for device ${deviceId}. Report temperature only if stored readings exist.`
            : question.replace(serial, deviceId);
        }
        const authorizeDocument = async (
          principal: Principal,
          document: { document_id: string; document_version: number },
        ) => {
          if (!options.knowledge)
            throw new Error("knowledge authorization unavailable");
          const access = await options.knowledge.documentSource(
            principal,
            req.header("Authorization")!,
            document.document_id,
            document.document_version,
            true,
            signal,
          );
          if ([401, 403, 404, 409].includes(access.status))
            throw new AuthError(403, "invalid_claims");
          if (access.status !== 200)
            throw new Error("knowledge authorization unavailable");
        };
        const evidenceCitations = (observation: string) => {
          const value = JSON.parse(observation) as {
            tool?: string;
            content?: { type?: string; text?: string }[];
          };
          if (
            value.tool !== "search_knowledge" &&
            value.tool !== "query_structured_knowledge"
          )
            return [];
          return (value.content ?? [])
            .filter((part) => part.type === "text")
            .flatMap((part) => {
              const body = JSON.parse(part.text ?? "{}") as {
                citations?: {
                  document_id: string;
                  document_version: number;
                  chunk_id: string;
                  page_start: number;
                  page_end: number;
                }[];
              };
              if (!Array.isArray(body.citations))
                throw new Error("invalid knowledge evidence");
              return body.citations.map((citation) => {
                if (
                  !citation ||
                  typeof citation.document_id !== "string" ||
                  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                    citation.document_id,
                  ) ||
                  typeof citation.chunk_id !== "string" ||
                  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                    citation.chunk_id,
                  ) ||
                  !Number.isSafeInteger(citation.document_version) ||
                  citation.document_version < 1 ||
                  !Number.isSafeInteger(citation.page_start) ||
                  citation.page_start < 1 ||
                  !Number.isSafeInteger(citation.page_end) ||
                  citation.page_end < citation.page_start ||
                  (scope &&
                    (citation.document_id !== scope.document_id ||
                      citation.document_version !== scope.document_version))
                )
                  throw new Error("invalid knowledge citation");
                return citation;
              });
            });
        };
        const reauthorizeEvidence = async (
          principal: Principal,
          values: string[],
        ) => {
          const documents = new Map<
            string,
            { document_id: string; document_version: number }
          >();
          if (scope)
            documents.set(
              `${scope.document_id}:${scope.document_version}`,
              scope,
            );
          for (const observation of values) {
            const value = JSON.parse(observation) as {
              tool?: string;
              content?: { type?: string; text?: string }[];
            };
            if (value.tool !== "query_structured_knowledge") continue;
            if (
              !options.knowledge ||
              value.content?.length !== 1 ||
              value.content[0]?.type !== "text"
            )
              throw new Error("invalid knowledge evidence");
            const body = JSON.parse(value.content[0].text ?? "{}") as {
              answer?: unknown;
              structured_evidence?: unknown;
            };
            const evidence = body.structured_evidence as {
              operation?: unknown;
              status?: unknown;
              answer_sha256?: unknown;
            };
            if (
              !evidence ||
              Object.keys(evidence)
                .sort((a, b) => (a < b ? -1 : Number(a > b)))
                .join() !== "answer_sha256,operation,status" ||
              !["count", "list", "pages"].includes(
                String(evidence.operation),
              ) ||
              !(
                evidence.status === null ||
                ["queued", "parsed", "ready", "failed"].includes(
                  String(evidence.status),
                )
              ) ||
              typeof evidence.answer_sha256 !== "string" ||
              !/^[a-f0-9]{64}$/.test(evidence.answer_sha256)
            )
              throw new Error("invalid knowledge evidence");
            if (
              typeof body.answer !== "string" ||
              createHash("sha256").update(body.answer).digest("hex") !==
                evidence.answer_sha256
            )
              throw new Error("invalid knowledge evidence");
            const access = await options.knowledge.authorizeStructured(
              principal,
              req.header("Authorization")!,
              evidence as {
                operation: string;
                status: string | null;
                answer_sha256: string;
              },
              scope,
              signal,
            );
            if ([401, 403, 404, 409].includes(access.status))
              throw new AuthError(403, "invalid_claims");
            if (access.status !== 200)
              throw new Error("knowledge authorization unavailable");
          }
          for (const observation of values)
            for (const citation of evidenceCitations(observation))
              documents.set(
                `${citation.document_id}:${citation.document_version}`,
                citation,
              );
          for (const document of documents.values())
            await authorizeDocument(principal, document);
        };
        for (let step = 0; step < 3; step++) {
          const current = await freshPrincipal();
          await reauthorizeEvidence(current, observations);
          stage = "planning";
          const plan = await options.agent.plan(
            current,
            question,
            observations,
            signal,
          );
          if (plan.tool === "abstain" && observations.length === 0) {
            const clarification = await options.agent.call(
              await freshPrincipal(),
              plan,
              runId,
              signal,
            );
            await freshPrincipal();
            res.json({ run_id: runId, ...clarification });
            return;
          }
          if (plan.tool === "abstain") break;
          // Object field order carries no meaning: normalize it so a reordered
          // model response cannot bypass the duplicate-call bound.
          const fingerprint = JSON.stringify([
            plan.tool,
            Object.entries(plan.args).sort(([a], [b]) => a.localeCompare(b)),
          ]);
          if (calls.has(fingerprint)) break;
          if (
            (plan.tool === "get_risk" || plan.tool === "query_device_facts") &&
            factReads.length >= 2
          )
            break;
          calls.add(fingerprint);
          stage = "tool";
          chosenTool = [
            "query_structured_knowledge",
            "search_knowledge",
            "query_device_facts",
            "get_alert",
            "get_risk",
            "propose_acknowledge_alert",
            "abstain",
          ].includes(plan.tool)
            ? plan.tool
            : "unknown";
          let result: Awaited<ReturnType<AssistantAgent["call"]>>;
          try {
            const invoke = async () =>
              options.agent!.call(
                await freshPrincipal(),
                plan,
                runId,
                signal,
                scope,
              );
            try {
              result = await invoke();
            } catch (error) {
              // One owner-requested cooldown retry per run fits inside the
              // existing overall deadline. Renew identity and document access
              // after waiting; a stale retrieval never gains authority.
              if (
                !(error instanceof AgentRateLimitError) ||
                cooldownRetried ||
                (plan.tool !== "search_knowledge" &&
                  plan.tool !== "query_structured_knowledge") ||
                error.retryAfterSeconds > 65 ||
                Date.now() + error.retryAfterSeconds * 1000 + 20000 >= deadline
              )
                throw error;
              cooldownRetried = true;
              await reauthorizeEvidence(await freshPrincipal(), observations);
              if (options.cooldownWait)
                await options.cooldownWait(
                  error.retryAfterSeconds * 1000,
                  signal,
                );
              else
                await pause(error.retryAfterSeconds * 1000, undefined, {
                  signal,
                });
              const fresh = await freshPrincipal();
              await reauthorizeEvidence(fresh, observations);
              result = await options.agent.call(
                fresh,
                plan,
                runId,
                signal,
                scope,
              );
            }
          } catch (error) {
            if (
              plan.tool === "get_risk" &&
              !(error instanceof AuthError) &&
              !(error instanceof AgentRateLimitError)
            )
              throw new AgentDeviceError(503, "device_read_unavailable");
            throw error;
          }
          if (plan.tool === "propose_acknowledge_alert") {
            await freshPrincipal();
            res.json({ run_id: runId, approval_required: true, ...result });
            return;
          }
          if (plan.tool === "get_risk") {
            const content = (
              result as { content?: { type?: string; text?: string }[] }
            ).content;
            if (content?.length === 1 && content[0]?.type === "text") {
              const facts = JSON.parse(content[0].text ?? "{}") as {
                data?: unknown;
              };
              if (facts.data === null) {
                await freshPrincipal();
                res.json({
                  run_id: runId,
                  tool: "answer",
                  tool_calls: calls.size,
                  citations: [],
                  content: [
                    {
                      type: "text",
                      text: `No stored readings are available for device ${plan.args.device_id}. I cannot report its temperature or risk from the available data.`,
                    },
                  ],
                });
                return;
              }
            }
          }
          const observation = JSON.stringify(result);
          if (observation.length > 12000)
            throw new Error("oversized agent observation");
          if (plan.tool === "get_risk" || plan.tool === "query_device_facts")
            factReads.push({ plan, observation });
          observations.push(observation);
        }
        const reauthorizeFacts = async () => {
          for (const fact of factReads) {
            const current = await options.agent!.call(
              await freshPrincipal(),
              fact.plan,
              runId,
              signal,
            );
            if (JSON.stringify(current) !== fact.observation)
              throw new AgentDeviceError(409, "device_evidence_changed");
          }
        };
        stage = "final_generation";
        await reauthorizeFacts();
        await reauthorizeEvidence(await freshPrincipal(), observations);
        const result = await options.agent.respond(
          await freshPrincipal(),
          question,
          observations,
          signal,
        );
        await reauthorizeEvidence(await freshPrincipal(), observations);
        await reauthorizeFacts();
        const citations = result.observation_ids.flatMap((id) =>
          evidenceCitations(observations[Number(id) - 1]!),
        );
        await freshPrincipal();
        res.json({
          run_id: runId,
          tool_calls: calls.size,
          tools_used: [
            ...new Set(
              [...calls].map((value) => JSON.parse(value)[0] as string),
            ),
          ],
          ...result,
          citations,
        });
      } catch (e) {
        if (e instanceof AgentDeviceError)
          res.status(e.status).json({ code: e.code });
        else if (e instanceof AgentRateLimitError) {
          res.setHeader("Retry-After", String(e.retryAfterSeconds));
          res.status(429).json({ code: "rate_limited" });
        } else if (e instanceof AuthError)
          res.status(e.status).json({ code: e.code });
        else {
          console.error("assistant_agent_failure", {
            stage,
            chosenTool,
            error: e instanceof Error ? e.name : "unknown",
            reason:
              e instanceof Error &&
              /^(?:invalid knowledge (?:citation|evidence)|oversized agent observation|invalid agent (?:plan|answer|evidence references)|knowledge authorization unavailable|agent tool unavailable|agent (?:answer|planner) unavailable \([0-9]{3}\))$/.test(
                e.message,
              )
                ? e.message
                : "dependency_failure",
          });
          res.status(503).json({ code: "agent_unavailable" });
        }
      } finally {
        releaseRun?.();
      }
    },
  );
  app.get("/v1/advisor/proposals", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const p = await human(req.header("Authorization"));
      if (!options.agent) {
        res.status(503).json({ code: "agent_not_configured" });
        return;
      }
      if (!p.roles.some((r) => r === "operator" || r === "admin"))
        throw new AuthError(403, "insufficient_role");
      if (!options.rateLimiter) {
        res.status(503).json({ code: "rate_limit_unavailable" });
        return;
      }
      const limit = await boundedRateCheck(
        options.rateLimiter.check(p, { query: "assistantConversationRead" }),
        options.rateCheckTimeoutMs ?? 1000,
      );
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        res.status(429).json({ code: "rate_limited" });
        return;
      }
      const fresh = await human(req.header("Authorization"));
      if (
        fresh.tenantId !== p.tenantId ||
        fresh.subject !== p.subject ||
        fresh.issuer !== p.issuer ||
        !fresh.roles.some((role) => role === "operator" || role === "admin")
      )
        throw new AuthError(403, "invalid_claims");
      const t = await options.agent.delegation.mint(
        fresh,
        "grain-advisor",
        "advisor:decide",
      );
      const result = await options.agent.advisor.list(fresh, t);
      res.status(result.status).json(result.body);
    } catch (e) {
      if (e instanceof AuthError) res.status(e.status).json({ code: e.code });
      else res.status(503).json({ code: "advisor_unavailable" });
    }
  });
  app.post(
    "/v1/advisor/proposals/:proposalId/decision",
    express.json({ limit: "8kb" }),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const p = await human(req.header("Authorization"));
        if (!options.agent) {
          res.status(503).json({ code: "agent_not_configured" });
          return;
        }
        if (!p.roles.some((r) => r === "operator" || r === "admin"))
          throw new AuthError(403, "insufficient_role");
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        const b = req.body;
        const key = req.header("Idempotency-Key");
        if (
          !uuid.test(String(req.params.proposalId)) ||
          !key ||
          !uuid.test(key) ||
          !b ||
          typeof b !== "object" ||
          Array.isArray(b) ||
          Object.keys(b)
            .sort((a, b) => (a < b ? -1 : Number(a > b)))
            .join() !== "action_hash,decision,version" ||
          !["approved", "rejected"].includes(b.decision) ||
          typeof b.action_hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(b.action_hash) ||
          !Number.isSafeInteger(b.version) ||
          b.version < 1 ||
          req.header("If-Match") !== `"${b.version}"`
        ) {
          res.status(400).json({ code: "invalid_decision" });
          return;
        }
        if (!options.rateLimiter) {
          res.status(503).json({ code: "rate_limit_unavailable" });
          return;
        }
        const limit = await boundedRateCheck(
          options.rateLimiter.check(p, {
            query: "assistantConversationWrite",
          }),
          options.rateCheckTimeoutMs ?? 1000,
        );
        if (!limit.allowed) {
          res.setHeader("Retry-After", String(limit.retryAfterSeconds));
          res.status(429).json({ code: "rate_limited" });
          return;
        }
        const fresh = await human(req.header("Authorization"));
        if (
          fresh.tenantId !== p.tenantId ||
          fresh.subject !== p.subject ||
          fresh.issuer !== p.issuer ||
          !fresh.roles.some((r) => r === "operator" || r === "admin")
        )
          throw new AuthError(403, "invalid_claims");
        const token = await options.agent.delegation.mint(
          fresh,
          "grain-advisor",
          "advisor:decide",
        );
        const headers: Record<string, string> = {
          "Idempotency-Key": key,
          "If-Match": `"${b.version}"`,
        };
        if (b.decision === "approved")
          headers["X-Owner-Delegated-Token"] =
            `Bearer ${await options.agent.delegation.mint(fresh, "workflow-alerts", "alerts:acknowledge")}`;
        const result = await options.agent.advisor.request(
          fresh,
          token,
          req.path,
          b,
          headers,
        );
        res.status(result.status).json(result.body);
      } catch (e) {
        if (e instanceof AuthError) res.status(e.status).json({ code: e.code });
        else res.status(503).json({ code: "advisor_unavailable" });
      }
    },
  );
  app.get("/v1/advisor/proposals/:proposalId", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const p = await human(req.header("Authorization"));
      if (!options.agent) {
        res.status(503).json({ code: "agent_not_configured" });
        return;
      }
      if (!p.roles.some((role) => role === "operator" || role === "admin"))
        throw new AuthError(403, "insufficient_role");
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          req.params.proposalId!,
        )
      ) {
        res.status(400).json({ code: "invalid_request" });
        return;
      }
      if (!options.rateLimiter) {
        res.status(503).json({ code: "rate_limit_unavailable" });
        return;
      }
      const limit = await boundedRateCheck(
        options.rateLimiter.check(p, { query: "assistantConversationRead" }),
        options.rateCheckTimeoutMs ?? 1000,
      );
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        res.status(429).json({ code: "rate_limited" });
        return;
      }
      const fresh = await human(req.header("Authorization"));
      if (
        fresh.tenantId !== p.tenantId ||
        fresh.subject !== p.subject ||
        fresh.issuer !== p.issuer ||
        !fresh.roles.some((role) => role === "operator" || role === "admin")
      )
        throw new AuthError(403, "invalid_claims");
      const token = await options.agent.delegation.mint(
        fresh,
        "grain-advisor",
        "advisor:decide",
      );
      const result = await options.agent.advisor.status(
        fresh,
        token,
        req.params.proposalId!,
      );
      if (result.etag) res.setHeader("ETag", result.etag);
      res.status(result.status).json(result.body);
    } catch (error) {
      if (error instanceof AuthError)
        res.status(error.status).json({ code: error.code });
      else res.status(503).json({ code: "advisor_unavailable" });
    }
  });
  app.post(
    "/v1/advisor/proposals/:proposalId/execution",
    express.json({ limit: "8kb" }),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const p = await human(req.header("Authorization"));
        if (!options.agent) {
          res.status(503).json({ code: "agent_not_configured" });
          return;
        }
        if (!p.roles.some((role) => role === "operator" || role === "admin"))
          throw new AuthError(403, "insufficient_role");
        const body = req.body;
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            req.params.proposalId!,
          ) ||
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body)
            .sort((a, b) => (a < b ? -1 : Number(a > b)))
            .join() !== "action_hash,version" ||
          typeof body.action_hash !== "string" ||
          !/^[0-9a-f]{64}$/.test(body.action_hash) ||
          !Number.isSafeInteger(body.version) ||
          body.version < 1 ||
          body.version > 2147483647 ||
          req.header("If-Match") !== `"${body.version}"`
        ) {
          res.status(400).json({ code: "invalid_request" });
          return;
        }
        if (!options.rateLimiter) {
          res.status(503).json({ code: "rate_limit_unavailable" });
          return;
        }
        const limit = await boundedRateCheck(
          options.rateLimiter.check(p, { query: "assistantConversationWrite" }),
          options.rateCheckTimeoutMs ?? 1000,
        );
        if (!limit.allowed) {
          res.setHeader("Retry-After", String(limit.retryAfterSeconds));
          res.status(429).json({ code: "rate_limited" });
          return;
        }
        const fresh = await human(req.header("Authorization"));
        if (
          fresh.tenantId !== p.tenantId ||
          fresh.subject !== p.subject ||
          fresh.issuer !== p.issuer ||
          !fresh.roles.some((role) => role === "operator" || role === "admin")
        )
          throw new AuthError(403, "invalid_claims");
        const token = await options.agent.delegation.mint(
          fresh,
          "grain-advisor",
          "advisor:decide",
        );
        const owner = await options.agent.delegation.mint(
          fresh,
          "workflow-alerts",
          "alerts:acknowledge",
        );
        const result = await options.agent.advisor.request(
          fresh,
          token,
          req.path,
          body,
          {
            "If-Match": `"${body.version}"`,
            "X-Owner-Delegated-Token": `Bearer ${owner}`,
          },
        );
        res.status(result.status).json(result.body);
      } catch (error) {
        if (error instanceof AuthError)
          res.status(error.status).json({ code: error.code });
        else res.status(503).json({ code: "advisor_unavailable" });
      }
    },
  );
}
