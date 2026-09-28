import { withTenant } from "./tenant.js";
import type { Pool } from "pg";
import type { ProviderAdapter } from "./adapters.js";
import type { Broker, IncomingTask, Settlement } from "./broker.js";
import {
  beginDelivery,
  expireOptionalHold,
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
  FIRST_HELD_HEADER,
  OPTIONAL_HOLD_ATTEMPT_HEADER,
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
  /** Evaluated from a verified tenant ID; false holds optional work in the retry queue. */
  optionalSendEnabled?: (tenantId: string) => Promise<boolean>;
}

export function backoffMs(policy: Policy, attempt: number): number {
  const exp = policy.baseBackoffMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, policy.maxBackoffMs);
}

function providerCall<T>(
  deps: Deps,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withTimeout(deps.policy.providerTimeoutMs, fn);
}

/** One provider send with the intent ID as idempotency key; timeout => unknown. */
export function attemptSend(
  deps: Deps,
  task: Task,
  attempt: number,
): Promise<Outcome> {
  return deps.providers.run(() => sendUnderPermit(deps, task, attempt));
}

/** Private call site: caller owns capacity through owner admission and finish. */
async function sendUnderPermit(
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
export function attemptReconcile(deps: Deps, task: Task): Promise<Outcome> {
  return deps.providers.run(() => reconcileUnderPermit(deps, task));
}

async function reconcileUnderPermit(deps: Deps, task: Task): Promise<Outcome> {
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
    if (result.kind === "unknown")
      return { status: "unknown", kind: "reconcile", error: result.reason };
    // Provider confirmed not delivered: safe to retry with the same key.
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
 * Handles one RabbitMQ task: begin (locked, committed) -> provider call under a separate owner admission
 * -> record outcome (committed) -> broker follow-up with confirms -> ack.
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
  // Severity ownership is unconditional, including stale/forged RabbitMQ tasks.
  // Reject before flag lookup, ledger claims or provider calls; critical is AWS-only.
  if (task.severity !== "warning") {
    deps.metrics.inc("tasks_rejected");
    return "reject";
  }
  if (deps.optionalSendEnabled) {
    let enabled = false;
    try {
      enabled = await deps.optionalSendEnabled(task.tenant_id);
    } catch {
      /* fail closed */
    }
    if (!enabled) {
      const now = Date.now();
      const priorHeld = Number(incoming.headers[FIRST_HELD_HEADER]);
      const firstHeld =
        Number.isFinite(priorHeld) && priorHeld >= 0 && priorHeld <= now
          ? priorHeld
          : now;
      const priorAttempts = Number(
        incoming.headers[OPTIONAL_HOLD_ATTEMPT_HEADER] ?? 0,
      );
      const attempt =
        (Number.isSafeInteger(priorAttempts) && priorAttempts >= 0
          ? priorAttempts
          : 0) + 1;
      const headers = {
        ...incoming.headers,
        [FIRST_HELD_HEADER]: firstHeld,
        [OPTIONAL_HOLD_ATTEMPT_HEADER]: attempt,
      };
      deps.metrics.observeHeld(firstHeld, now);
      deps.metrics.inc("optional_held");
      if (attempt >= deps.policy.maxAttempts) {
        if (await expireHold(deps, task, headers))
          deps.metrics.inc("optional_held_parked");
      } else {
        await deps.broker.publish({
          key: RETRY_KEY,
          messageId: task.intent_id,
          body: incoming.body,
          headers,
          expirationMs: deps.policy.maxBackoffMs,
        });
      }
      return "ack";
    }
  }
  const plan = await beginDelivery(deps.pool, task);
  if (plan.action === "stale") return "ack";
  if (plan.action === "receipt") {
    await sendReceipt(deps, task, plan.outcome);
    if (plan.park) await park(deps, task, incoming.headers);
    deps.metrics.inc("duplicates");
    return "ack";
  }
  // The intent remains committed before the call. This separate admission holds
  // the owner fence through the external effect and ledger completion, so a move
  // must wait for an admitted provider call to finish. Redelivery keeps intent_id.
  // Queued provider work waits without a pinned database connection. Keep the
  // acquired permit and owner fence through the effect and ledger completion.
  const final = await deps.providers.run(() =>
    withTenant(
      deps.pool,
      task.tenant_id,
      async (client) => {
        const outcome =
          plan.action === "send"
            ? await sendUnderPermit(deps, task, plan.attempt)
            : await reconcileUnderPermit(deps, task);
        return finishDelivery(deps.pool, task, outcome, client);
      },
      { freshPlacement: true },
    ),
  );
  if (final === "stale") return "ack";
  deps.metrics.inc(`outcome_${final}`);
  await route(deps, incoming, task, final, plan);
  return "ack";
}

/** Persist known-not-sent hold exhaustion before broker follow-ups. Terminal
 * last_error lets redelivery recover a lost park confirm even after flags enable. */
async function expireHold(
  deps: Deps,
  task: Task,
  headers: Record<string, unknown>,
): Promise<boolean> {
  const result = await expireOptionalHold(deps.pool, task);
  if (result.action === "stale") return false;
  if (result.action === "receipt") {
    await sendReceipt(deps, task, result.outcome);
    if (result.park) await park(deps, task, headers);
    return result.park;
  }
  if (result.action === "uncertain") {
    // A prior provider call may have succeeded. Never convert uncertainty to
    // failed because an optional-send flag is disabled; operators reconcile it.
    await park(deps, task, headers);
    return true;
  }
  await sendReceipt(deps, task, "failed");
  await park(deps, task, headers);
  return true;
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
    return park(deps, task, incoming.headers);
  }
  const reconciles = plan.action === "reconcile" ? plan.reconciles + 1 : 0;
  if (status === "unknown" && reconciles >= deps.policy.maxReconciles) {
    // Still uncertain after bounded reconciliation: park for an operator, never mark failed.
    deps.metrics.inc("unknown_parked");
    return park(deps, task, incoming.headers);
  }
  const attempt = attemptOf(incoming) + 1;
  await deps.broker.publish({
    key: RETRY_KEY,
    messageId: task.intent_id,
    body: incoming.body,
    headers: { ...incoming.headers, [ATTEMPT_HEADER]: attempt },
    expirationMs: backoffMs(deps.policy, attempt),
  });
}

function park(
  deps: Deps,
  task: Task,
  headers?: Record<string, unknown>,
): Promise<void> {
  return deps.broker.publish({
    exchange: DEAD_EXCHANGE,
    key: DEAD_KEY,
    headers,
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
