import type { AccessTokenProvider } from "./provisioning";

export interface AdvisorAction {
  action: string;
  target: string;
  params: Record<string, unknown>;
  preconditions: Record<string, unknown>;
}
export interface AdvisorProposal {
  proposal_id: string;
  action_hash: string;
  status: "pending" | "approved" | "rejected" | "expired";
  version: number;
  expires_at: string;
  action: AdvisorAction;
  execution_status?:
    | "pending"
    | "running"
    | "retryable"
    | "succeeded"
    | "failed"
    | "not_applicable";
  execution_attempts?: number;
  execution_receipt?: Record<string, unknown> | null;
}
export const advisorExecutionAttemptLimit = 8;
const proposalId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actionHash = /^[a-f0-9]{64}$/;
const executionStates = new Set([
  "pending",
  "running",
  "retryable",
  "succeeded",
  "failed",
  "not_applicable",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validIdentity(p: AdvisorProposal) {
  return (
    proposalId.test(p.proposal_id) &&
    actionHash.test(p.action_hash) &&
    Number.isSafeInteger(p.version) &&
    p.version > 0
  );
}
function parseProposal(value: unknown): AdvisorProposal {
  if (
    !object(value) ||
    !validIdentity(value as unknown as AdvisorProposal) ||
    !["pending", "approved", "rejected", "expired"].includes(
      String(value.status),
    ) ||
    typeof value.expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    !object(value.action) ||
    typeof value.action.action !== "string" ||
    typeof value.action.target !== "string" ||
    !object(value.action.params) ||
    !object(value.action.preconditions) ||
    (value.execution_status !== undefined &&
      !executionStates.has(String(value.execution_status))) ||
    (value.execution_attempts !== undefined &&
      (!Number.isSafeInteger(value.execution_attempts) ||
        Number(value.execution_attempts) < 0)) ||
    (value.execution_receipt !== undefined &&
      value.execution_receipt !== null &&
      !object(value.execution_receipt))
  ) {
    throw new Error("Advisor returned an invalid proposal.");
  }
  return value as unknown as AdvisorProposal;
}
export class AdvisorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: number,
  ) {
    super(
      status === 401
        ? "Your session expired. Sign in again to review this action."
        : status === 403
          ? "You no longer have permission to review this action."
          : status === 404
            ? "This proposal is no longer available in your account."
            : status === 409
              ? "This proposal changed. Refresh its status before continuing."
              : status === 410
                ? "This proposal has expired."
                : status === 429
                  ? "Action requests are temporarily rate limited."
                  : "Advisor is temporarily unavailable. Refresh the action status before retrying.",
    );
  }
}
export class AdvisorApi {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}
  private async request(path: string, init: RequestInit = {}) {
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    const token = await this.getAccessToken();
    signal.throwIfAborted();
    if (!token) throw new Error("Sign in to review Advisor actions.");
    const response = await fetch(path, {
      ...init,
      cache: "no-store",
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const delay = Number(response.headers.get("Retry-After"));
      throw new AdvisorRequestError(
        response.status,
        Number.isFinite(delay) && delay > 0
          ? Math.min(3600, Math.ceil(delay))
          : 1,
      );
    }
    return payload;
  }
  async list(limit = 50, signal?: AbortSignal): Promise<AdvisorProposal[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid approval limit.");
    const payload = await this.request(`/v1/advisor/proposals?limit=${limit}`, {
      signal,
    });
    if (!object(payload) || !Array.isArray(payload.items))
      throw new Error("Advisor returned an invalid proposal list.");
    return payload.items.map(parseProposal);
  }
  async get(id: string, signal?: AbortSignal): Promise<AdvisorProposal> {
    if (!proposalId.test(id)) throw new Error("Invalid proposal identity.");
    const value = parseProposal(
      await this.request(`/v1/advisor/proposals/${encodeURIComponent(id)}`, {
        signal,
      }),
    );
    if (value.proposal_id !== id)
      throw new Error("Advisor returned a different proposal.");
    return value;
  }
  async decide(
    proposal: AdvisorProposal,
    decision: "approved" | "rejected",
    signal?: AbortSignal,
  ) {
    if (
      !validIdentity(proposal) ||
      proposal.status !== "pending" ||
      !Number.isFinite(Date.parse(proposal.expires_at)) ||
      Date.parse(proposal.expires_at) <= Date.now()
    )
      throw new Error("Only a current unexpired proposal can be decided.");
    const payload = await this.request(
      `/v1/advisor/proposals/${encodeURIComponent(proposal.proposal_id)}/decision`,
      {
        method: "POST",
        signal,
        headers: {
          "Idempotency-Key": crypto.randomUUID(),
          "If-Match": `"${proposal.version}"`,
        },
        body: JSON.stringify({
          decision,
          action_hash: proposal.action_hash,
          version: proposal.version,
        }),
      },
    );
    if (
      !object(payload) ||
      payload.proposal_id !== proposal.proposal_id ||
      payload.action_hash !== proposal.action_hash ||
      payload.version !== proposal.version + 1 ||
      payload.status !== decision
    )
      throw new Error("Advisor returned an invalid decision receipt.");
    return payload;
  }
  async execute(proposal: AdvisorProposal, signal?: AbortSignal) {
    if (
      !validIdentity(proposal) ||
      proposal.status !== "approved" ||
      proposal.version < 2 ||
      !Number.isSafeInteger(proposal.execution_attempts) ||
      Number(proposal.execution_attempts) < 0 ||
      Number(proposal.execution_attempts) >= advisorExecutionAttemptLimit ||
      !["pending", "retryable", "running"].includes(
        proposal.execution_status ?? "",
      )
    )
      throw new Error(
        "This approved action cannot be retried in its current state.",
      );
    // Approved recovery keeps the existing owner's expiry semantics. The owner
    // reuses its durable execution key and freshly checks authorization.
    const payload = await this.request(
      `/v1/advisor/proposals/${encodeURIComponent(proposal.proposal_id)}/execution`,
      {
        method: "POST",
        signal,
        headers: { "If-Match": `"${proposal.version}"` },
        body: JSON.stringify({
          action_hash: proposal.action_hash,
          version: proposal.version,
        }),
      },
    );
    if (
      !object(payload) ||
      !executionStates.has(String(payload.execution_status))
    )
      throw new Error("Advisor returned an invalid execution receipt.");
    return payload;
  }
}
