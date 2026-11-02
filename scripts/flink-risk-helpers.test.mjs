import assert from "node:assert/strict";
import test from "node:test";
import {
  anomalyDuplicateCount,
  eventTimeOrder,
  eventTimeBatches,
  kafkaMessage,
  dlqForInput,
  dockerGoArch,
  integrationEnvironment,
  checkedResult,
} from "./flink-risk-helpers.mjs";

test("failed Compose commands abort before a foreign endpoint can look healthy", () => {
  assert.throws(
    () =>
      checkedResult(
        { status: 1, stderr: "port allocated" },
        "owned Compose up",
      ),
    /port allocated/,
  );
  assert.throws(
    () =>
      checkedResult(
        { status: null, error: "spawn failed" },
        "owned Compose up",
      ),
    /spawn failed/,
  );
  const ok = { status: 0 };
  assert.equal(checkedResult(ok, "owned Compose up"), ok);
});

test("CI endpoint remapping preserves dotenv values and leaves external or empty URLs intact", () => {
  const env = integrationEnvironment(
    `\n# private fixture\nBADLINE\nPOSTGRES_ADMIN_URL="postgresql://user:secret@127.0.0.1:55432/db"\nRABBITMQ_URL=amqp://user:secret@127.0.0.1:55672/\nEMPTY_URL=\nEXTERNAL_URL=https://example.test:55432/path\nTOKEN="a=b#literal"\n`,
  );
  assert.equal(new URL(env.get("POSTGRES_ADMIN_URL")).port, "55741");
  assert.equal(new URL(env.get("RABBITMQ_URL")).port, "55772");
  assert.equal(env.get("EMPTY_URL"), "");
  assert.equal(env.get("EXTERNAL_URL"), "https://example.test:55432/path");
  assert.equal(env.get("TOKEN"), "a=b#literal");
  assert.equal(env.has("BADLINE"), false);
  assert.equal(env.has(""), false);
});

test("manual Kafka fixtures carry the production consumer's required headers", () => {
  const event = {
    event_id: "e",
    event_type: "risk.assessed",
    tenant_id: "t",
    aggregate_id: "d",
    correlation_id: "c",
    traceparent: "trace",
    payload: { score: 50 },
  };
  const record = kafkaMessage(event);
  assert.equal(record.key, "t:d");
  for (const field of ["event_id", "event_type", "tenant_id"])
    assert.equal(record.headers[field], JSON.parse(record.value)[field]);
});

test("historical DLQ records cannot satisfy a fresh run's missing rejection cases", () => {
  const records = ["bad_json", "key_mismatch", "bad_field", "late"].map(
    (reason) => ({
      body: { source_topic: "old-run", reason },
    }),
  );
  records.push({ body: { source_topic: "new-run", reason: "bad_json" } });
  assert.deepEqual(
    dlqForInput(records, "new-run").map((r) => r.body.reason),
    ["bad_json"],
  );
});

test("Go benchmark binaries target the Docker server and reject unknown architectures", () => {
  for (const arch of ["arm64", "aarch64"])
    assert.equal(dockerGoArch(arch), "arm64");
  for (const arch of ["amd64", "x86_64"])
    assert.equal(dockerGoArch(arch), "amd64");
  assert.throws(() => dockerGoArch("unknown"), /unsupported Docker/);
});

test("anomaly replay preserves decimal JSON instead of changing the payload digest", () => {
  const wire =
    '{"event_id":"e","tenant_id":"t","aggregate_id":"d","payload":{"value":28.0}}';
  const event = JSON.parse(wire);
  assert.notEqual(
    JSON.stringify(event),
    wire,
    "a JS round trip loses decimal representation",
  );
  assert.equal(kafkaMessage(event, wire).value, wire);
});

test("all tenants' baselines precede triggers and watermark progress", () => {
  const events = ["a", "b"].flatMap((tenant) =>
    [0, 20, 25].map((second) => ({
      tenant,
      second,
      payload: { observed_at: new Date(second * 1000).toISOString() },
    })),
  );
  const ordered = eventTimeOrder(events);
  assert.deepEqual(
    eventTimeBatches(events).map((batch) => batch.map((x) => x.tenant)),
    [
      ["a", "b"],
      ["a", "b"],
      ["a", "b"],
    ],
  );
  assert.deepEqual(
    ordered.map((x) => [x.tenant, x.second]),
    [
      ["a", 0],
      ["b", 0],
      ["a", 20],
      ["b", 20],
      ["a", 25],
      ["b", 25],
    ],
  );
  assert.equal(
    events[1].tenant,
    "a",
    "ordering does not mutate the fixture source",
  );
});

test("duplicate evidence counters support zero and counts above nine", () => {
  assert.equal(anomalyDuplicateCount(""), 0);
  assert.equal(
    anomalyDuplicateCount(
      'risk_anomaly_decisions_total{outcome="duplicate"} 4\n',
    ),
    4,
  );
  assert.equal(
    anomalyDuplicateCount(
      'risk_anomaly_decisions_total{outcome="duplicate"} 120\n',
    ),
    120,
  );
});
