import { requireRole, type Principal } from "@greenguard/tenant-auth";

export class BillingUpstreamError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export interface BillingSnapshot {
  subscription: { status: string; planKey: string; entitlementPlanKey: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean; version?: string };
  usage: Array<{ meter: string; periodStart: string; periodEnd: string; state: string; total: string }>;
}
export interface BillingCommand { commandId: string; status: string; result?: { url?: string } | null }

/** Tenant-scoped billing facade. Stripe is only reached by billing-service. */
export class BillingClient {
  constructor(private readonly baseURL: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(baseURL);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      throw new Error("billing owner URL must use HTTPS or loopback HTTP");
  }
  private async call<T>(principal: Principal, authorization: string, path: string, init: RequestInit = {}): Promise<T> {
    requireRole(principal, "admin");
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseURL), {
        ...init,
        headers: { Authorization: authorization, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(5000),
      });
    } catch { throw new BillingUpstreamError(503, "billing_unavailable"); }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new BillingUpstreamError(response.status, body || "billing_request_failed");
    }
    return (await response.json()) as T;
  }
  async snapshot(principal: Principal, authorization: string): Promise<BillingSnapshot> {
    const [subscription, usage] = await Promise.all([
      this.call<BillingSnapshot["subscription"]>(principal, authorization, "/v1/billing/subscription"),
      this.call<BillingSnapshot["usage"]>(principal, authorization, "/v1/billing/usage"),
    ]);
    return { subscription, usage };
  }
  checkout(principal: Principal, authorization: string, plan: string, successUrl: string, cancelUrl: string, key: string) {
    return this.call<BillingCommand>(principal, authorization, "/v1/billing/checkout", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ plan, successUrl, cancelUrl }),
    });
  }
  portal(principal: Principal, authorization: string, returnUrl: string, key: string) {
    return this.call<BillingCommand>(principal, authorization, "/v1/billing/portal", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ returnUrl }),
    });
  }
  command(principal: Principal, authorization: string, id: string) {
    return this.call<BillingCommand>(principal, authorization, `/v1/billing/commands/${encodeURIComponent(id)}`);
  }
}
