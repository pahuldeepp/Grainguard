// Transport and event-time fixture rules shared by the live integration harness.
import { parseEnv } from "node:util";

export function checkedResult(result, operation) {
  if (result.status !== 0) {
    throw new Error(
      `${operation} failed: ${String(result.stderr ?? result.error ?? "").slice(-1000)}`,
    );
  }
  return result;
}

export function integrationEnvironment(contents) {
  const env = new Map(Object.entries(parseEnv(contents)));
  for (const [key, value] of env) {
    if (!key.endsWith("_URL") || !URL.canParse(value)) continue;
    const url = new URL(value);
    const port = { 55432: "55741", 56432: "56741", 55672: "55772" }[url.port];
    if (url.hostname === "127.0.0.1" && port) {
      url.port = port;
      env.set(key, url.toString());
    }
  }
  return env;
}

export function kafkaMessage(event, wireValue) {
  return {
    key: `${event.tenant_id}:${event.aggregate_id}`,
    value: wireValue ?? JSON.stringify(event),
    headers: Object.fromEntries(
      [
        "event_id",
        "event_type",
        "tenant_id",
        "correlation_id",
        "traceparent",
      ].map((key) => [key, event[key]]),
    ),
  };
}

export function eventTimeOrder(readings) {
  return [...readings].sort(
    (a, b) =>
      Date.parse(a.payload.observed_at) - Date.parse(b.payload.observed_at),
  );
}

export function anomalyDuplicateCount(metrics) {
  const match = metrics.match(
    /risk_anomaly_decisions_total\{outcome="duplicate"\} (\d+)/,
  );
  return Number(match?.[1] ?? 0);
}

export function eventTimeBatches(readings) {
  const batches = [];
  for (const reading of eventTimeOrder(readings)) {
    const last = batches.at(-1);
    if (
      last &&
      Date.parse(last[0].payload.observed_at) ===
        Date.parse(reading.payload.observed_at)
    )
      last.push(reading);
    else batches.push([reading]);
  }
  return batches;
}

export function dlqForInput(records, inputTopic) {
  return records.filter((record) => record.body?.source_topic === inputTopic);
}

export function dockerGoArch(architecture) {
  const mapped = {
    aarch64: "arm64",
    arm64: "arm64",
    x86_64: "amd64",
    amd64: "amd64",
  }[architecture];
  if (!mapped)
    throw new Error(`unsupported Docker server architecture: ${architecture}`);
  return mapped;
}
