import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_SUGGESTIONS,
  redisAssistantSuggestionStore,
  type AssistantSuggestionRedis,
} from "./assistant-suggestions.js";

class FakeRedis implements AssistantSuggestionRedis {
  calls: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
  reply: unknown = [];
  error: Error | undefined;

  async eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    this.calls.push({ script, ...options });
    if (this.error) throw this.error;
    return this.reply;
  }
}

test("lists only safe catalog entries ranked by tenant popularity", async () => {
  const redis = new FakeRedis();
  redis.reply = [
    "mold_risk",
    "12",
    "unknown_from_redis",
    "999",
    "storage_checks",
    "4",
  ];
  const store = redisAssistantSuggestionStore(redis);

  const suggestions = await store.list("tenant-123", 3);

  assert.deepEqual(suggestions, [
    ASSISTANT_SUGGESTIONS.find((item) => item.id === "mold_risk"),
    ASSISTANT_SUGGESTIONS.find((item) => item.id === "storage_checks"),
    ASSISTANT_SUGGESTIONS.find((item) => item.id === "grain_moisture"),
  ]);
  assert.equal(redis.calls[0]?.arguments[0], "list");
  assert.equal(redis.calls[0]?.arguments[1], "3");
  assert.match(
    redis.calls[0]?.keys[0] ?? "",
    /^assistant:suggestions:\{[a-f0-9]{64}\}:popular:v1$/,
  );
  assert.equal(redis.calls[0]?.keys[0]?.includes("tenant-123"), false);
});

test("uses catalog order for ties and clamps the requested limit", async () => {
  const redis = new FakeRedis();
  redis.reply = [];
  const result = await redisAssistantSuggestionStore(redis).list("tenant", 999);

  assert.deepEqual(result, [...ASSISTANT_SUGGESTIONS]);
  assert.equal(
    redis.calls[0]?.arguments[1],
    String(ASSISTANT_SUGGESTIONS.length),
  );
});

test("records only known suggestion IDs with atomic expiry and bounded retention", async () => {
  const redis = new FakeRedis();
  await redisAssistantSuggestionStore(redis).recordUsage(
    "tenant",
    "storage_checks",
  );

  const call = redis.calls[0];
  assert.ok(call);
  assert.deepEqual(call.arguments.slice(0, 2), ["record", "storage_checks"]);
  assert.equal(call.arguments[2], "100");
  assert.equal(call.arguments[3], String(90 * 24 * 60 * 60));
  assert.match(call.script, /ZINCRBY/);
  assert.match(call.script, /ZREMRANGEBYRANK/);
  assert.match(call.script, /EXPIRE/);
});

test("rejects unknown IDs and propagates Redis outages", async () => {
  const redis = new FakeRedis();
  const store = redisAssistantSuggestionStore(redis);

  await assert.rejects(
    store.recordUsage("tenant", "model_generated_text"),
    /unknown_assistant_suggestion/,
  );
  assert.equal(redis.calls.length, 0);

  redis.error = new Error("redis_unavailable");
  await assert.rejects(store.list("tenant"), /redis_unavailable/);
  await assert.rejects(
    store.recordUsage("tenant", "storage_checks"),
    /redis_unavailable/,
  );
});
