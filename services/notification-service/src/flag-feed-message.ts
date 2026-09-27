const QUARANTINE_TOPIC = "greenguard.quarantine.v1";
const MAX_RAW_BYTES = 65_536;
const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

export function isFlagTenantId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export type FlagMessageSource = {
  topic: string;
  partition: number;
  message: { offset: string };
};

export type FlagFeedMessage = {
  topic: string;
  partition: number;
  message: {
    offset: string;
    value: Buffer | null;
    headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>;
  };
};

export function flagHeaderTenant(
  message: FlagFeedMessage["message"],
): string | undefined {
  const raw = message.headers?.tenant_id;
  return typeof raw === "string" || Buffer.isBuffer(raw)
    ? raw.toString("utf8")
    : undefined;
}

export type CheckedFlagMessage = {
  event?: unknown;
  reason?: string;
  tenant: string;
};

export function classifyFlagMessage(
  raw: string,
  headerTenant?: string,
): CheckedFlagMessage {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { reason: "bad_envelope", tenant: "unknown" };
  }
  const id = typeof event?.tenant_id === "string" ? event.tenant_id : "";
  const tenant = isFlagTenantId(id) ? id : "unknown";
  if (headerTenant !== undefined && headerTenant !== id)
    return { reason: "key_mismatch", tenant };
  return { event, tenant };
}

export async function quarantineFlagMessage(
  producer: {
    send(input: {
      topic: string;
      messages: Array<{
        key: string;
        headers: { reason_code: string; tenant_id: string };
        value: string;
      }>;
    }): Promise<unknown>;
  },
  source: FlagMessageSource,
  raw: string,
  reason: string,
  tenant: string,
): Promise<void> {
  const bytes = Buffer.from(raw, "utf8");
  await producer.send({
    topic: QUARANTINE_TOPIC,
    messages: [
      {
        key: `${source.topic}:${source.partition}:${source.message.offset}`,
        headers: { reason_code: reason, tenant_id: tenant },
        value: JSON.stringify({
          reason,
          source_topic: source.topic,
          source_partition: source.partition,
          source_offset: source.message.offset,
          raw_base64: bytes.subarray(0, MAX_RAW_BYTES).toString("base64"),
          truncated: bytes.length > MAX_RAW_BYTES,
        }),
      },
    ],
  });
}
