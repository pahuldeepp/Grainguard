import assert from "node:assert/strict";
import { test } from "node:test";
import kafkaJs from "kafkajs";
import { handleConsumerCrash, registerSnappyCodec } from "./kafka.js";

const { CompressionCodecs, CompressionTypes } = kafkaJs;

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
