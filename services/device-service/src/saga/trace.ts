// Saga trace context (ADR-0004, Saga section): the orchestrator stores one W3C
// traceparent per saga and puts it on every command; this participant echoes it
// on its CDC events and results. It is never derived from saga or command IDs.
const TRACEPARENT =
  /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-([0-9a-f]{2})$/;

/** Returns the command's valid version-00 traceparent with only the sampled bit, or null. */
export function sagaTrace(value: unknown): string | null {
  const match = TRACEPARENT.exec(typeof value === "string" ? value : "");
  if (!match) return null;
  const sampled = Number.parseInt(match[3] as string, 16) & 1;
  return `00-${match[1]}-${match[2]}-${sampled ? "01" : "00"}`;
}

/** Kafka headers for a serialized result: the echoed trace, or none at all. */
export function resultHeaders(
  value: string,
): Record<string, string> | undefined {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const traceparent = sagaTrace(result.traceparent);
  if (!traceparent) return undefined;
  return {
    traceparent,
    correlation_id: String(result.saga_id),
    tenant_id: String(result.tenant_id),
  };
}
