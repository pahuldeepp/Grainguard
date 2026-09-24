import type { Pool } from "pg";
import type { ProviderAdapter } from "./adapters.js";
import type { Broker, IncomingTask, Settlement } from "./broker.js";
import {
  beginDelivery,
  finishDelivery,
  isTerminal,
  type Outcome,
  type Plan,
  type Status,
} from "./ledger.js";
import type { Metrics } from "./metrics.js";
import { Semaphore, TimeoutError, withTimeout } from "./pool.js";
import {
  InvalidTaskError,
  parseTask,
  type Channel,
  type Task,
} from "./task.js";
import {
  ATTEMPT_HEADER,
  DEAD_EXCHANGE,
  DEAD_KEY,
  RECEIPT_KEY,
  RETRY_KEY,
} from "./topology.js";

export interface Policy {
  maxAttempts: number;
  maxReconciles: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  providerTimeoutMs: number;
}

export interface Deps {
  pool: Pool;
  broker: Broker;
  adapter: (channel: Channel) => ProviderAdapter;
  providers: Semaphore;
  policy: Policy;
  metrics: Metrics;
}

export function backoffMs(policy: Policy, attempt: number): number {
  const exp = policy.baseBackoffMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, policy.maxBackoffMs);
}

function providerCall<T>(
  deps: Deps,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return deps.providers.run(() =>
    withTimeout(deps.policy.providerTimeoutMs, fn),
  );
}

/** One provider send with the intent ID as idempotency key; timeout => unknown. */
export async function attemptSend(
  deps: Deps,
  task: Task,
  attempt: number,
): Promise<Outcome> {
  try {
    const result = await providerCall(deps, (signal) =>
      deps
        .adapter(task.channel)
        .send({ idempotencyKey: task.intent_id, task }, signal),
    );
    if (result.kind === "sent")
      return { status: "sent", kind: "send", providerRef: result.providerRef };
    if (result.kind === "rejected")
      return { status: "failed", kind: "send", error: result.reason };
    const status = attempt >= deps.policy.maxAttempts ? "dead" : "retry";
    return { status, kind: "send", error: result.reason };
  } catch (error) {
    // Timeout or transport error: the provider may have accepted the message. This is an
    // uncertain outcome to reconcile, never a silent failure.
    return { status: "unknown", kind: "send", error: describe(error) };
  }
}

/** Asks the provider whether the idempotency key was delivered. */
export async function attemptReconcile(
  deps: Deps,
  task: Task,
): Promise<Outcome> {
  try {
    const result = await providerCall(deps, (signal) =>
      deps.adapter(task.channel).reconcile(task.intent_id, signal),
    );
    if (result.kind === "sent")
      return {
        status: "sent",
        kind: "reconcile",
        providerRef: result.providerRef,
      };
    // Not delivered: safe to send again under the same idempotency key.
    return {
      status: "retry",
      kind: "reconcile",
      error: "not delivered; resend with same key",
    };
  } catch (error) {
    return { status: "unknown", kind: "reconcile", error: describe(error) };
  }
}

function describe(error: unknown): string {
  if (error instanceof TimeoutError)
    return `provider timeout: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function attemptOf(task: IncomingTask): number {
  const value = Number(task.headers[ATTEMPT_HEADER] ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Handles one RabbitMQ task: begin (locked, committed) -> provider call outside any
 * transaction -> record outcome (committed) -> broker follow-up with confirms -> ack.
 */
export async function handleTask(
  deps: Deps,
  incoming: IncomingTask,
): Promise<Settlement> {
  deps.metrics.observeLag(incoming.timestamp);
  let task: Task;
  try {
    task = parseTask(incoming.body, incoming.messageId);
  } catch (error) {
    if (!(error instanceof InvalidTaskError)) throw error;
    deps.metrics.inc("tasks_rejected");
    return "reject";
  }
  const plan = await beginDelivery(deps.pool, task);
  if (plan.action === "stale") return "ack";
  if (plan.action === "receipt") {
    await sendReceipt(deps, task, plan.outcome);
    deps.metrics.inc("duplicates");
    return "ack";
  }
  const outcome =
    plan.action === "send"
      ? await attemptSend(deps, task, plan.attempt)
      : await attemptReconcile(deps, task);
  const final = await finishDelivery(deps.pool, task, outcome);
  if (final === "stale") return "ack";
  deps.metrics.inc(`outcome_${final}`);
  await route(deps, incoming, task, final, plan);
  return "ack";
}

async function route(
  deps: Deps,
  incoming: IncomingTask,
  task: Task,
  status: Status,
  plan: Plan,
): Promise<void> {
  if (isTerminal(status)) return sendReceipt(deps, task, status);
  if (status === "dead") {
    await sendReceipt(deps, task, "dead");
    return park(deps, task);
  }
  const reconciles = plan.action === "reconcile" ? plan.reconciles + 1 : 0;
  if (status === "unknown" && reconciles >= deps.policy.maxReconciles) {
    // Still uncertain after bounded reconciliation: park for an operator, never mark failed.
    deps.metrics.inc("unknown_parked");
    return park(deps, task);
  }
  const attempt = attemptOf(incoming) + 1;
  await deps.broker.publish({
    key: RETRY_KEY,
    messageId: task.intent_id,
    body: incoming.body,
    headers: { [ATTEMPT_HEADER]: attempt },
    expirationMs: backoffMs(deps.policy, attempt),
  });
}

function park(deps: Deps, task: Task): Promise<void> {
  return deps.broker.publish({
    exchange: DEAD_EXCHANGE,
    key: DEAD_KEY,
    messageId: task.intent_id,
    body: Buffer.from(JSON.stringify(task)),
  });
}

function sendReceipt(deps: Deps, task: Task, outcome: string): Promise<void> {
  return deps.broker.publish({
    key: RECEIPT_KEY,
    messageId: `${task.intent_id}:${outcome}`,
    body: Buffer.from(
      JSON.stringify({
        tenant_id: task.tenant_id,
        intent_id: task.intent_id,
        outcome,
        delivery_generation: task.delivery_generation,
      }),
    ),
  });
}
