import type { Task } from "./task.js";

export interface SendRequest {
  idempotencyKey: string;
  task: Task;
}

export type SendResult =
  | { kind: "sent"; providerRef: string }
  | { kind: "rejected"; reason: string }
  | { kind: "transient"; reason: string };

export type ReconcileResult =
  | { kind: "sent"; providerRef: string }
  | { kind: "not_found" }
  | { kind: "unknown"; reason: string };

/**
 * Provider adapter. idempotencyKey is the stable delivery intent ID. Providers without
 * native deduplication use it for correlation only: uncertain sends must reconcile and
 * stay unknown unless delivery or non-delivery is proven. Never blindly resend them.
 */
export interface ProviderAdapter {
  send(request: SendRequest, signal: AbortSignal): Promise<SendResult>;
  reconcile(
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ReconcileResult>;
}

export type Behaviour =
  "ok" | "transient" | "reject" | "timeout-after-accept" | "hang";

/**
 * Local test adapter: records deliveries in memory, sends no external message. Behaviours
 * can be queued per call to exercise transient, permanent and uncertain outcomes.
 */
export class LocalTestAdapter implements ProviderAdapter {
  readonly delivered = new Map<string, string>();
  readonly sendCalls: string[] = [];
  private readonly behaviours: Behaviour[] = [];
  private counter = 0;

  queue(...behaviours: Behaviour[]): void {
    this.behaviours.push(...behaviours);
  }

  async send(request: SendRequest, signal: AbortSignal): Promise<SendResult> {
    this.sendCalls.push(request.idempotencyKey);
    const behaviour = this.behaviours.shift() ?? "ok";
    if (behaviour === "transient")
      return { kind: "transient", reason: "provider unavailable" };
    if (behaviour === "reject")
      return { kind: "rejected", reason: "recipient rejected" };
    if (behaviour === "hang") return waitForAbort(signal);
    const ref = this.record(request.idempotencyKey);
    if (behaviour === "timeout-after-accept") return waitForAbort(signal);
    return { kind: "sent", providerRef: ref };
  }

  async reconcile(key: string): Promise<ReconcileResult> {
    const ref = this.delivered.get(key);
    return ref ? { kind: "sent", providerRef: ref } : { kind: "not_found" };
  }

  private record(key: string): string {
    const existing = this.delivered.get(key);
    if (existing) return existing;
    this.counter += 1;
    const ref = `local-${this.counter}`;
    this.delivered.set(key, ref);
    return ref;
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new Error("provider call aborted"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Real credentials/providers arrive in Stage 10; no send was accepted in this adapter. */
export class UnconfiguredAdapter implements ProviderAdapter {
  constructor(private readonly channel: string) {}

  async send(): Promise<SendResult> {
    return {
      kind: "transient",
      reason: `${this.channel} provider not configured (Stage 10)`,
    };
  }

  async reconcile(): Promise<ReconcileResult> {
    return { kind: "not_found" };
  }
}
