import { GraphqlError } from "./graphql.js";
import type { SecureStore } from "./secure-store.js";
import { IdentityChangedError, ReloginRequiredError } from "./session.js";
import type { Identity } from "./session.js";

export interface AckSender {
  acknowledge(
    alertId: string,
    version: string,
    idempotencyKey: string,
    expected: Identity,
  ): Promise<unknown>;
}

export interface AckQueueDeps {
  storage: SecureStore;
  now: () => number;
  newId: () => string;
  random: () => number;
  isOnline?: () => boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export interface QueuedAck {
  idempotencyKey: string;
  alertId: string;
  version: string;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  rejectedReason?: string;
}

export type DrainStatus =
  | "empty"
  | "complete"
  | "backoff"
  | "paused-relogin"
  | "identity-changed"
  | "offline";

export interface DrainResult {
  status: DrainStatus;
  sent: string[];
  alreadyAcknowledged: string[];
  rejected: string[];
  nextAttemptAt?: number;
}

type Outcome =
  | { kind: "sent" | "already" | "transient" | "relogin" | "identity" }
  | { kind: "rejected"; reason: string };

const KEY_PREFIX = "greenguard.mobile.ack-queue.v1";
const CONFLICT_STATUSES = new Set([409, 412]);
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

function classify(error: unknown): Outcome {
  if (error instanceof ReloginRequiredError) return { kind: "relogin" };
  if (error instanceof IdentityChangedError) return { kind: "identity" };
  if (!(error instanceof GraphqlError)) return { kind: "transient" };
  if (CONFLICT_STATUSES.has(error.status)) return { kind: "already" };
  if (error.status === 401) return { kind: "relogin" };
  const retryable =
    error.status === 0 || error.status === 429 || error.status >= 500;
  return retryable
    ? { kind: "transient" }
    : { kind: "rejected", reason: `http_${error.status}` };
}

// Storage is tenant- and user-scoped: a queued acknowledgement is only ever
// replayed by the identity that authored it. The idempotency key is created
// once at enqueue time and reused verbatim on every retry and restart.
export class AckQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly draining = new Map<string, Promise<DrainResult>>();

  constructor(
    private readonly sender: AckSender,
    private readonly deps: AckQueueDeps,
  ) {}

  async enqueue(
    identity: Identity,
    alertId: string,
    version: string,
  ): Promise<QueuedAck> {
    const scope = scopeKey(identity);
    return this.locked(async () => {
      const entries = await this.load(scope);
      const existing = entries.find(
        (entry) => entry.alertId === alertId && !entry.rejectedReason,
      );
      if (existing) return existing;
      const entry: QueuedAck = {
        idempotencyKey: this.deps.newId(),
        alertId,
        version,
        enqueuedAt: this.deps.now(),
        attempts: 0,
        nextAttemptAt: 0,
      };
      await this.save(scope, [...entries, entry]);
      return entry;
    });
  }

  pending(identity: Identity): Promise<QueuedAck[]> {
    return this.locked(() => this.load(scopeKey(identity)));
  }

  dismiss(identity: Identity, idempotencyKey: string): Promise<void> {
    return this.update(scopeKey(identity), idempotencyKey, () => null);
  }

  async submit(
    identity: Identity,
    alertId: string,
    version: string,
  ): Promise<DrainResult> {
    await this.enqueue(identity, alertId, version);
    return this.drain(identity);
  }

  drain(identity: Identity): Promise<DrainResult> {
    if (this.deps.isOnline && !this.deps.isOnline())
      return Promise.resolve(result("offline"));
    const scope = scopeKey(identity);
    const running = this.draining.get(scope);
    if (running) return running;
    const pass = this.run(identity, scope).finally(() =>
      this.draining.delete(scope),
    );
    this.draining.set(scope, pass);
    return pass;
  }

  private async run(identity: Identity, scope: string): Promise<DrainResult> {
    const summary = result("empty");
    for (;;) {
      const head = await this.locked(async () =>
        (await this.load(scope)).find((entry) => !entry.rejectedReason),
      );
      if (!head) return summary;
      if (head.nextAttemptAt > this.deps.now())
        return {
          ...summary,
          status: "backoff",
          nextAttemptAt: head.nextAttemptAt,
        };
      const outcome = await this.send(identity, head);
      const stop = await this.apply(scope, head, outcome, summary);
      if (stop) return stop;
      summary.status = "complete";
    }
  }

  private async send(identity: Identity, entry: QueuedAck): Promise<Outcome> {
    try {
      await this.sender.acknowledge(
        entry.alertId,
        entry.version,
        entry.idempotencyKey,
        identity,
      );
      return { kind: "sent" };
    } catch (error) {
      return classify(error);
    }
  }

  // Returns a final result when the pass must stop, otherwise null.
  private async apply(
    scope: string,
    entry: QueuedAck,
    outcome: Outcome,
    summary: DrainResult,
  ): Promise<DrainResult | null> {
    const key = entry.idempotencyKey;
    switch (outcome.kind) {
      case "sent":
      case "already":
        // Dequeue only after the send; a crash before this write replays the
        // same key, which the server treats as the same command.
        await this.update(scope, key, () => null);
        (outcome.kind === "sent"
          ? summary.sent
          : summary.alreadyAcknowledged
        ).push(key);
        return null;
      case "rejected":
        await this.reject(scope, key, outcome.reason, summary);
        return null;
      case "relogin":
        return { ...summary, status: "paused-relogin" };
      case "identity":
        return { ...summary, status: "identity-changed" };
      default:
        return this.retryLater(scope, entry, summary);
    }
  }

  private async retryLater(
    scope: string,
    entry: QueuedAck,
    summary: DrainResult,
  ): Promise<DrainResult | null> {
    const attempts = entry.attempts + 1;
    if (attempts >= (this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      await this.reject(
        scope,
        entry.idempotencyKey,
        "retries_exhausted",
        summary,
      );
      return null;
    }
    const nextAttemptAt = this.deps.now() + this.delayFor(attempts);
    await this.update(scope, entry.idempotencyKey, (current) => ({
      ...current,
      attempts,
      nextAttemptAt,
    }));
    return { ...summary, status: "backoff", nextAttemptAt };
  }

  private async reject(
    scope: string,
    key: string,
    reason: string,
    summary: DrainResult,
  ): Promise<void> {
    await this.update(scope, key, (current) => ({
      ...current,
      rejectedReason: reason,
    }));
    summary.rejected.push(key);
  }

  private delayFor(attempts: number): number {
    const base = this.deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const cap = this.deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    return (
      Math.min(base * 2 ** (attempts - 1), cap) + this.deps.random() * base
    );
  }

  private update(
    scope: string,
    key: string,
    change: (entry: QueuedAck) => QueuedAck | null,
  ): Promise<void> {
    return this.locked(async () => {
      const entries = await this.load(scope);
      const next = entries.flatMap((entry) => {
        if (entry.idempotencyKey !== key) return [entry];
        const changed = change(entry);
        return changed ? [changed] : [];
      });
      await this.save(scope, next);
    });
  }

  // Serializes storage read-modify-write cycles; network calls stay outside.
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async load(scope: string): Promise<QueuedAck[]> {
    const raw = await this.deps.storage.getItem(scope);
    return raw ? (JSON.parse(raw) as QueuedAck[]) : [];
  }

  private async save(scope: string, entries: QueuedAck[]): Promise<void> {
    if (entries.length === 0) await this.deps.storage.removeItem(scope);
    else await this.deps.storage.setItem(scope, JSON.stringify(entries));
  }
}

function scopeKey(identity: Identity): string {
  return `${KEY_PREFIX}.${encodeURIComponent(identity.tenantId)}.${encodeURIComponent(identity.subject)}`;
}

function result(status: DrainStatus): DrainResult {
  return { status, sent: [], alreadyAcknowledged: [], rejected: [] };
}
