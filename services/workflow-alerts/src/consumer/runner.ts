import type { HandleResult } from "./handler.js";

// Thin transport boundary. A Kafka adapter implements EventSource; the live Kafka
// path is not yet verified (Stage 06e), so the loop is proven against a fake.
export interface SourceRecord {
  value: string;
  headers: Record<string, string | undefined>;
  position: string;
}

export interface EventSource {
  poll(): Promise<SourceRecord | undefined>;
  // Called only after the durable effect or a confirmed quarantine.
  commit(record: SourceRecord): Promise<void>;
  // Must resolve only once the quarantine write is acknowledged.
  quarantine(record: SourceRecord, errors: string[]): Promise<void>;
}

export interface RunOptions {
  source: EventSource;
  handle: (event: unknown) => Promise<HandleResult>;
  signal: AbortSignal;
  maxAttempts?: number;
  backoffMs?: number;
  idleMs?: number;
}

const HEADER_FIELDS = ["event_id", "event_type", "tenant_id"] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ADR-0010: required headers must agree with the envelope they describe.
function parse(record: SourceRecord): { event?: unknown; errors: string[] } {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(record.value) as Record<string, unknown>;
  } catch {
    return { errors: ["value is not JSON"] };
  }
  const errors = HEADER_FIELDS.filter(
    (field) => record.headers[field] !== String(event?.[field]),
  ).map((field) => `header ${field} does not match the envelope`);
  return { event, errors };
}

async function handleWithRetry(
  options: RunOptions,
  event: unknown,
): Promise<HandleResult> {
  const attempts = options.maxAttempts ?? 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return await options.handle(event);
    } catch (error) {
      if (attempt >= attempts || options.signal.aborted) throw error;
      await sleep((options.backoffMs ?? 100) * attempt);
    }
  }
}

// Sequential per partition: the offset advances only after the effect committed or
// the record was durably quarantined. Exhausted retries stop the loop without
// committing, so the record is redelivered instead of being skipped.
export async function processRecord(
  options: RunOptions,
  record: SourceRecord,
): Promise<HandleResult["status"] | "quarantined"> {
  const parsed = parse(record);
  if (parsed.errors.length > 0) {
    await options.source.quarantine(record, parsed.errors);
    await options.source.commit(record);
    return "quarantined";
  }
  const result = await handleWithRetry(options, parsed.event);
  if (result.status === "invalid" || result.status === "conflict")
    await options.source.quarantine(record, result.errors);
  await options.source.commit(record);
  return result.status;
}

export async function runConsumer(options: RunOptions): Promise<void> {
  while (!options.signal.aborted) {
    const record = await options.source.poll();
    if (record) await processRecord(options, record);
    else await sleep(options.idleMs ?? 250);
  }
}
