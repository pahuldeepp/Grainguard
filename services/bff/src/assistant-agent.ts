import { tracedFetch, tracedDelegation } from "./tracing.js";
import { createPublicKey, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import { createDelegatedSignerFromPem } from "@greenguard/tenant-auth/delegated";
import { identityKey } from "@greenguard/membership-client";
import { AdvisorClient, type DownstreamDelegation } from "./advisor.js";
import { allowedInternalUrl } from "./internal-url.js";

export interface AgentPlan {
  tool:
    | "query_structured_knowledge"
    | "search_knowledge"
    | "get_alert"
    | "get_risk"
    | "query_device_facts"
    | "propose_acknowledge_alert"
    | "abstain";
  args: Record<string, unknown>;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateAgentPlan(value: unknown): AgentPlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid agent plan");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v)
      .sort((a, b) => (a < b ? -1 : Number(a > b)))
      .join() !== "args,tool" ||
    !v.args ||
    typeof v.args !== "object" ||
    Array.isArray(v.args)
  )
    throw new Error("invalid agent plan");
  const a = v.args as Record<string, unknown>;
  const keys = Object.keys(a)
    .sort((a, b) => (a < b ? -1 : Number(a > b)))
    .join();
  let valid = false;
  switch (v.tool) {
    case "search_knowledge":
      valid =
        keys === "k,query" &&
        typeof a.query === "string" &&
        a.query.trim().length >= 4 &&
        a.query.length <= 2000 &&
        Number.isSafeInteger(a.k) &&
        Number(a.k) >= 1 &&
        Number(a.k) <= 8;
      break;
    case "query_structured_knowledge":
      valid =
        keys === "question" &&
        typeof a.question === "string" &&
        a.question.trim().length >= 4 &&
        a.question.length <= 2000;
      break;
    case "query_device_facts": {
      const operation = a.operation;
      const from = typeof a.from === "string" ? Date.parse(a.from) : NaN;
      const to = typeof a.to === "string" ? Date.parse(a.to) : NaN;
      const range =
        Number.isFinite(from) &&
        Number.isFinite(to) &&
        to > from &&
        to - from <= 31 * 86400000 &&
        typeof a.from === "string" &&
        typeof a.to === "string" &&
        /^\d{4}-\d{2}-\d{2}T/.test(a.from) &&
        /^\d{4}-\d{2}-\d{2}T/.test(a.to);
      valid =
        typeof a.device_id === "string" &&
        uuid.test(a.device_id) &&
        (((operation === "telemetry_latest" || operation === "device_alerts") &&
          keys === "device_id,operation") ||
          (operation === "risk_history" &&
            keys === "device_id,from,operation,to" &&
            range) ||
          (operation === "telemetry_rollups" &&
            keys === "bucket,device_id,from,operation,to" &&
            range &&
            (a.bucket === "hour" || a.bucket === "day")));
      break;
    }
    case "get_alert":
      valid =
        keys === "alert_id" &&
        typeof a.alert_id === "string" &&
        uuid.test(a.alert_id);
      break;
    case "get_risk":
      valid =
        keys === "device_id" &&
        typeof a.device_id === "string" &&
        uuid.test(a.device_id);
      break;
    case "propose_acknowledge_alert":
      valid =
        keys === "alert_id,etag,note" &&
        typeof a.alert_id === "string" &&
        uuid.test(a.alert_id) &&
        typeof a.note === "string" &&
        a.note.length > 0 &&
        a.note.length <= 500 &&
        typeof a.etag === "string" &&
        /^"[0-9]+"$/.test(a.etag) &&
        a.etag.length <= 128;
      break;
    case "abstain":
      valid = keys === "";
      break;
  }
  if (!valid) throw new Error("invalid agent plan");
  return v as unknown as AgentPlan;
}
function origin(raw: string) {
  const u = new URL(raw);
  if (
    !allowedInternalUrl(raw) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw new Error("unsafe agent dependency URL");
  return u.origin;
}
async function boundedBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 128000) throw new Error("oversized body");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export class AgentRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("agent rate limited");
  }
}

export class AssistantAgent {
  readonly gateway: string;
  readonly mcp: string;
  constructor(
    gateway: string,
    mcp: string,
    private token: string,
    private model: string,
    readonly delegation: DownstreamDelegation,
    readonly advisor: AdvisorClient,
    readonly jwks: object,
    private fetcher: typeof fetch = fetch,
    private tenantTokens?: Readonly<Record<string, string>>,
    private ownerDelegation?: DownstreamDelegation,
  ) {
    this.fetcher = tracedFetch(this.fetcher);
    this.delegation = tracedDelegation(this.delegation);
    this.gateway = origin(gateway);
    this.mcp = origin(mcp);
    if ((!token && !tenantTokens) || !model)
      throw new Error("agent model configuration required");
  }
  private tokenFor(principal: Principal): string {
    if (!this.tenantTokens) return this.token;
    const token = this.tenantTokens[principal.tenantId];
    if (!token) throw new AuthError(403, "invalid_claims");
    return token;
  }
  async plan(
    principal: Principal,
    question: string,
    observations: string[] = [],
    signal?: AbortSignal,
  ): Promise<AgentPlan> {
    if (principal.principalType === "service" || !principal.issuer)
      throw new AuthError(403, "invalid_claims");
    const r = await this.fetcher(`${this.gateway}/v1/agent/plan`, {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${this.tokenFor(principal)}`,
        "Content-Type": "application/json",
        "X-AI-Principal-ID": identityKey(principal.issuer, principal.subject),
      },
      body: JSON.stringify({
        tenant_id: principal.tenantId,
        model: this.model,
        question,
        observations,
      }),
    });
    if (!r.ok) {
      await r.body?.cancel();
      if (r.status === 429) {
        const delay = Number(r.headers.get("Retry-After"));
        throw new AgentRateLimitError(
          Number.isFinite(delay) && delay > 0
            ? Math.min(3600, Math.ceil(delay))
            : 30,
        );
      }
      throw new Error(`agent planner unavailable (${r.status})`);
    }
    const plan = validateAgentPlan(JSON.parse(await boundedBody(r)));
    // A model cannot invent a device target absent from the verified request.
    if (
      (plan.tool === "get_risk" || plan.tool === "query_device_facts") &&
      !question.includes(String(plan.args.device_id))
    ) {
      throw new Error("explicit device target required");
    }
    // A model cannot invent the mutation target or the current version.
    if (
      plan.tool === "propose_acknowledge_alert" &&
      (!/\b(?:acknowledge|ack|mark as acknowledged)\b/i.test(question) ||
        !question.includes(String(plan.args.alert_id)) ||
        !question.includes(String(plan.args.etag)))
    ) {
      throw new Error("explicit action target and version required");
    }
    return plan;
  }
  async respond(
    principal: Principal,
    question: string,
    observations: string[],
    signal?: AbortSignal,
  ) {
    if (!principal.issuer || observations.length < 1 || observations.length > 3)
      throw new Error("invalid agent context");
    const response = await this.fetcher(`${this.gateway}/v1/agent/respond`, {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${this.tokenFor(principal)}`,
        "Content-Type": "application/json",
        "X-AI-Principal-ID": identityKey(principal.issuer, principal.subject),
      },
      body: JSON.stringify({
        tenant_id: principal.tenantId,
        model: this.model,
        question,
        observations,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        const delay = Number(response.headers.get("Retry-After"));
        throw new AgentRateLimitError(
          Number.isFinite(delay) && delay > 0
            ? Math.min(3600, Math.ceil(delay))
            : 30,
        );
      }
      throw new Error(`agent answer unavailable (${response.status})`);
    }
    const value = JSON.parse(await boundedBody(response)) as {
      answer?: unknown;
      observation_ids?: unknown;
    };
    if (typeof value.answer !== "string" || value.answer.length > 12000)
      throw new Error("invalid agent answer");
    const ids = value.observation_ids;
    if (
      !Array.isArray(ids) ||
      ids.some(
        (id) =>
          typeof id !== "string" ||
          !/^[1-3]$/.test(id) ||
          Number(id) > observations.length,
      ) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("invalid agent evidence references");
    return {
      tool: "answer",
      content: [{ type: "text", text: value.answer }],
      observation_ids: ids,
    };
  }
  async call(
    principal: Principal,
    plan: AgentPlan,
    runId: string,
    signal?: AbortSignal,
    selectedDocument?: { document_id: string; document_version: number },
  ) {
    validateAgentPlan(plan);
    if (plan.tool === "abstain")
      return {
        tool: "abstain",
        content: [
          {
            type: "text",
            text: "Please provide the document question or exact alert ID and version before proposing an action.",
          },
        ],
      };
    const propose = plan.tool === "propose_acknowledge_alert";
    if (
      propose &&
      !principal.roles.some((r) => r === "operator" || r === "admin")
    )
      throw new AuthError(403, "insufficient_role");
    const token = await this.delegation.mint(
      principal,
      "greenguard-mcp",
      propose ? "tools:propose" : "tools:read",
    );
    const args = propose
      ? { ...plan.args, run_id: runId }
      : (plan.tool === "search_knowledge" ||
            plan.tool === "query_structured_knowledge") &&
          selectedDocument
        ? { ...plan.args, selected_document: selectedDocument }
        : plan.args;
    const ownerDelegation = this.ownerDelegation ?? this.delegation;
    const ownerTokens: Record<string, string> = {};
    if (
      plan.tool === "search_knowledge" ||
      plan.tool === "query_structured_knowledge"
    )
      ownerTokens.knowledge = await ownerDelegation.mint(
        principal,
        "knowledge-service",
        "knowledge:read",
      );
    else if (
      plan.tool === "get_alert" ||
      (plan.tool === "query_device_facts" &&
        plan.args.operation === "device_alerts")
    )
      ownerTokens.alerts_read = await ownerDelegation.mint(
        principal,
        "workflow-alerts",
        "alerts:read",
      );
    else if (plan.tool === "propose_acknowledge_alert")
      ownerTokens.advisor_propose = await ownerDelegation.mint(
        principal,
        "grain-advisor",
        "advisor:propose",
      );
    else if (plan.tool === "get_risk" || plan.tool === "query_device_facts")
      ownerTokens.read = await ownerDelegation.mint(
        principal,
        "read-api",
        "telemetry:read",
      );
    if (!Object.keys(ownerTokens).length)
      throw new Error("agent owner delegation unavailable");
    const r = await this.fetcher(`${this.mcp}/mcp`, {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-03-26",
        "X-GG-Owner-Delegations": JSON.stringify(ownerTokens),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: runId,
        method: "tools/call",
        params: { name: plan.tool, arguments: args },
      }),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error("agent tool unavailable");
    }
    const raw = await boundedBody(r);
    let envelope: {
      result?: { content?: unknown; isError?: boolean };
      error?: unknown;
    };
    if (r.headers.get("content-type")?.includes("text/event-stream")) {
      // Each blank line dispatches one SSE event; JSON-RPC notifications and
      // other request IDs must not be merged into this call's response.
      const frames = raw.replace(/\r\n|\r/g, "\n").split("\n\n");
      const matches: (typeof envelope)[] = [];
      for (const frame of frames.slice(0, -1)) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        if (
          message &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          (message as { id?: unknown }).id === runId
        ) {
          matches.push(message as typeof envelope);
        }
      }
      if (matches.length !== 1) throw new Error("agent tool unavailable");
      envelope = matches[0]!;
    } else {
      envelope = JSON.parse(raw) as typeof envelope;
    }
    if (envelope.result?.isError && Array.isArray(envelope.result.content)) {
      const part = envelope.result.content[0] as { text?: unknown } | undefined;
      if (typeof part?.text === "string") {
        const detail = (() => {
          try {
            return JSON.parse(part.text) as {
              code?: unknown;
              retry_after_seconds?: unknown;
            };
          } catch {
            return {};
          }
        })();
        if (
          detail.code === "rate_limited" &&
          Number.isSafeInteger(detail.retry_after_seconds) &&
          Number(detail.retry_after_seconds) >= 1 &&
          Number(detail.retry_after_seconds) <= 120
        )
          throw new AgentRateLimitError(Number(detail.retry_after_seconds));
      }
    }
    if (
      envelope.error ||
      !envelope.result ||
      envelope.result.isError ||
      !Array.isArray(envelope.result.content)
    )
      throw new Error("agent tool unavailable");
    return { tool: plan.tool, ...envelope.result };
  }
}
export async function configuredAssistantAgent(): Promise<
  AssistantAgent | undefined
> {
  if (process.env.BFF_AGENT_ENABLED !== "true") return undefined;
  const path = process.env.BFF_DELEGATED_KEY_FILE;
  const issuer = process.env.BFF_DELEGATED_ISSUER;
  const kid = process.env.BFF_DELEGATED_KID;
  if (!path || !issuer || !kid)
    throw new Error("protected agent delegation required");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let pem: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 32768)
      throw new Error("protected delegation required");
    pem = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const delegation = await createDelegatedSignerFromPem({
    issuer,
    kid,
    privatePem: pem,
    identityId: (p) => {
      if (!p.issuer) throw new AuthError(403, "invalid_claims");
      return identityKey(p.issuer, p.subject);
    },
  });
  const ownerDelegation = await createDelegatedSignerFromPem({
    issuer,
    kid,
    privatePem: pem,
    actor: "greenguard-mcp",
    identityId: (p) => {
      if (!p.issuer) throw new AuthError(403, "invalid_claims");
      return identityKey(p.issuer, p.subject);
    },
  });
  const jwks = {
    keys: [
      {
        ...createPublicKey(pem).export({ format: "jwk" }),
        kid,
        alg: "RS256",
        use: "sig",
      },
    ],
  };
  let tenantTokens: Record<string, string> | undefined;
  if (process.env.BFF_MODEL_GATEWAY_TOKENS_FILE) {
    const fd = openSync(
      process.env.BFF_MODEL_GATEWAY_TOKENS_FILE,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 131072)
        throw new Error("protected gateway token map required");
      const value = JSON.parse(readFileSync(fd, "utf8")) as unknown;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([tenant, token]) =>
            !uuid.test(tenant) ||
            typeof token !== "string" ||
            token.length < 32 ||
            token.length > 16384 ||
            /\s/.test(token),
        )
      )
        throw new Error("invalid gateway token map");
      tenantTokens = value as Record<string, string>;
    } finally {
      closeSync(fd);
    }
  }
  return new AssistantAgent(
    process.env.BFF_MODEL_GATEWAY_URL!,
    process.env.BFF_MCP_API_URL!,
    process.env.BFF_MODEL_GATEWAY_TOKEN ?? "",
    process.env.BFF_AGENT_MODEL ?? "answer-v1",
    delegation,
    new AdvisorClient(process.env.BFF_ADVISOR_API_URL!),
    jwks,
    fetch,
    tenantTokens,
    ownerDelegation,
  );
}
export { randomUUID };
