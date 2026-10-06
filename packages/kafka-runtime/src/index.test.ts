import assert from "node:assert/strict";
import test from "node:test";
import type { Consumer, EachMessagePayload, Producer } from "kafkajs";
import { processWithDlq } from "./index.js";

function harness() {
  const calls: string[] = [];
  const consumer = {
    commitOffsets: async () => {
      calls.push("commit");
    },
  } as unknown as Consumer;
  const producer = {
    send: async (input: {
      topic: string;
      messages: Array<{ key: string; value: string }>;
    }) => {
      calls.push(`dlq:${input.topic}:${input.messages[0]?.key}`);
      return [];
    },
  } as unknown as Producer;
  const message = {
    topic: "source.v1",
    partition: 2,
    message: {
      offset: "4",
      key: Buffer.from("key"),
      value: Buffer.from("bad"),
    },
  } as EachMessagePayload;
  return { calls, consumer, producer, message };
}

test("invalid messages are durably dead-lettered before their offset is committed", async () => {
  const h = harness();
  class Invalid extends Error {}
  await processWithDlq({
    ...h,
    dlqTopic: "source.dlq.v1",
    isInvalid: (error): error is Invalid => error instanceof Invalid,
    process: async () => {
      throw new Invalid("bad contract");
    },
  });
  assert.deepEqual(h.calls, ["dlq:source.dlq.v1:source.v1:2:4", "commit"]);
});

test("transient processing failures neither dead-letter nor commit", async () => {
  const h = harness();
  await assert.rejects(
    processWithDlq({
      ...h,
      dlqTopic: "source.dlq.v1",
      isInvalid: (error): error is Error =>
        error instanceof Error && error.name === "Invalid",
      process: async () => {
        throw new Error("database unavailable");
      },
    }),
    /database unavailable/,
  );
  assert.deepEqual(h.calls, []);
});
