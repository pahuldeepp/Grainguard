import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ProjectionWatermark,
  ReadAdmissionLease,
} from "@greenguard/membership-client";
import { FreshnessUnavailable } from "./replicas.js";

export interface ReadContext {
  tenantId: string;
  minimum?: ProjectionWatermark;
  watermark?: ProjectionWatermark;
  lease?: ReadAdmissionLease;
  deadline: number;
  signal?: AbortSignal;
}
export const readContext = new AsyncLocalStorage<ReadContext>();
/** One response certifies the oldest snapshot it used, including cache hits. */
export function recordSnapshotWatermark(
  context: ReadContext,
  watermark: ProjectionWatermark,
) {
  const previous = context.watermark;
  if (
    watermark.tenantId !== context.tenantId ||
    (previous &&
      (previous.tenantId !== watermark.tenantId ||
        previous.shardIncarnation !== watermark.shardIncarnation ||
        previous.placementEpoch !== watermark.placementEpoch))
  )
    throw new FreshnessUnavailable();
  if (!previous || BigInt(watermark.sequence) < BigInt(previous.sequence))
    context.watermark = watermark;
}
export class ConsistencyStoreUnsupported extends Error {
  constructor() {
    super("consistency_store_unsupported");
  }
}
/** Store proofs are independent: a PostgreSQL sequence cannot certify Cassandra
 * or OpenSearch. Such callers must request that store's own completion proof.
 */
export function requireEventualStore() {
  if (readContext.getStore()?.minimum) throw new ConsistencyStoreUnsupported();
}

/** Disconnect and expiry close admission for further work and cache effects. */
export function assertReadActive(context = readContext.getStore()): void {
  if (context && (context.signal?.aborted || context.deadline <= Date.now()))
    throw new FreshnessUnavailable();
}

/** Bound awaits even when a test or client implementation ignores AbortSignal.
 * An acquired lease delivered after cancellation is explicitly released.
 */
export function readWithinBudget<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
  onLate?: (value: T) => void,
): Promise<T> {
  if (!signal) return work();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new FreshnessUnavailable());
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new FreshnessUnavailable();
        return work();
      })
      .then((value) => {
        if (signal.aborted) {
          try {
            onLate?.(value);
          } catch {
            /* The bounded lease still expires if cleanup fails. */
          }
          abort();
        } else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
