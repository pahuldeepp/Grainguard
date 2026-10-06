import assert from "node:assert/strict";
import { test } from "node:test";
import kafkaJs from "kafkajs";
import {
  handleConsumerCrash,
  registerSnappyCodec,
  RISK_TOPICS,
} from "./kafka.js";

const { CompressionCodecs, CompressionTypes } = kafkaJs;

test("subscribes to both risk assessment contract versions and invalidations", () => {
  assert.deepEqual(RISK_TOPICS, [
    "greenguard.risk.assessment.v1",
    "greenguard.risk.assessment.v2",
    "greenguard.risk.assessment_invalidated.v1",
  ]);
});

test("Snappy codec decodes raw and Kafka Xerial-framed batches", async () => {
  registerSnappyCodec();
  const codec = CompressionCodecs[CompressionTypes.Snappy]();
  const original = Buffer.from("greenguard-risk-assessment-batch");
  const compressed = Buffer.from(await codec.compress({ buffer: original }));
  assert.equal(
    Buffer.from(await codec.decompress(compressed)).toString(),
    original.toString(),
  );

  const frame = Buffer.alloc(20 + compressed.length);
  Buffer.from([130, 83, 78, 65, 80, 80, 89, 0]).copy(frame, 0);
  frame.writeUInt32BE(1, 8); // Xerial version
  frame.writeUInt32BE(1, 12); // compatible version
  frame.writeUInt32BE(compressed.length, 16);
  compressed.copy(frame, 20);
  assert.equal(
    Buffer.from(await codec.decompress(frame)).toString(),
    original.toString(),
  );
});

test("a non-restartable consumer crash removes readiness", () => {
  let ready = true;
  const fail = () => {
    ready = false;
  };
  handleConsumerCrash(true, fail);
  assert.equal(ready, true);
  handleConsumerCrash(false, fail);
  assert.equal(ready, false);
});

test("risk transport namespace isolates subscriptions and quarantine", async () => {
  const { riskTransportTopics, RISK_TOPICS } = await import("./kafka.js");
  assert.deepEqual(riskTransportTopics().risk, [...RISK_TOPICS]);
  assert.deepEqual(riskTransportTopics("provisioning-demo."), {
    risk: RISK_TOPICS.map((topic) => "provisioning-demo." + topic),
    quarantine: "provisioning-demo.greenguard.quarantine.v1",
  });
  for (const invalid of ["bad space.", "é.", "..", "a".repeat(249)])
    assert.throws(
      () => riskTransportTopics(invalid),
      /invalid KAFKA_TOPIC_PREFIX/,
    );
});
