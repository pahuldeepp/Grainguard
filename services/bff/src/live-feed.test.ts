import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { LiveFeed, liveChannel, parseLiveHint } from "./live-feed.js";

test("live feed validates scope and reports Redis health", async () => {
  const redis = new EventEmitter() as EventEmitter & {
    subscribe: (
      channel: string,
      listener: (message: string) => void,
    ) => Promise<void>;
  };
  let receive: (message: string) => void = () => {};
  redis.subscribe = async (channel, listener) => {
    assert.equal(channel, liveChannel);
    receive = listener;
  };
  const feed = new LiveFeed(redis);
  const seen: unknown[] = [];
  const off = feed.onHint("tenant-A", "sensor-A", () => seen.push("matched"));
  await feed.start();
  assert.equal(feed.isReady(), true);
  receive('{"scope":"device","tenant":"tenant-A","device":"sensor-A"}');
  receive('{"scope":"device","tenant":"tenant-B","device":"sensor-A"}');
  receive('{"scope":"device","tenant":"tenant-A","device":"sensor-B"}');
  receive('{"scope":"device","tenant":"bad:tenant","device":"sensor-A"}');
  assert.deepEqual(seen, ["matched"]);
  receive('{"scope":"tenant","tenant":"tenant-A"}');
  receive('{"scope":"epoch"}');
  assert.deepEqual(seen, ["matched", "matched", "matched"]);
  redis.emit("end");
  assert.equal(feed.isReady(), false);
  off();
  receive('{"scope":"epoch"}');
  assert.equal(seen.length, 3);
  redis.emit("ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(feed.isReady(), true);
  assert.deepEqual(parseLiveHint('{"scope":"epoch"}'), { scope: "epoch" });
});

test("cluster connection events restore live feed subscriptions after reconnect", async () => {
  const redis = new EventEmitter() as EventEmitter & {
    subscribe: (
      channel: string,
      listener: (message: string) => void,
    ) => Promise<void>;
  };
  let subscriptions = 0;
  redis.subscribe = async () => {
    subscriptions++;
  };
  const feed = new LiveFeed(redis, true);
  await feed.start();
  assert.equal(feed.isReady(), true);
  redis.emit("disconnect");
  assert.equal(feed.isReady(), false);
  redis.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(feed.isReady(), true);
  assert.equal(subscriptions, 2);
});

test("live hints carry bounded projection identity and sequence without converting stream versions", () => {
  const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const shard = "11111111-1111-4111-8111-111111111111";
  const payload = {
    scope: "device",
    tenant,
    device: "sensor-A",
    shard_incarnation: shard,
    placement_epoch: "2",
    projection_sequence: "9007199254740993",
  };
  const hint = parseLiveHint(JSON.stringify(payload));
  assert.deepEqual(hint, {
    scope: "device",
    tenant,
    device: "sensor-A",
    consistencyToken: JSON.stringify({
      v: 1,
      tenantId: tenant,
      shardIncarnation: shard,
      placementEpoch: "2",
      sequence: "9007199254740993",
    }),
  });
  const invalidation = { scope: "device", tenant, device: "sensor-A" };
  for (const invalid of [
    { ...payload, projection_sequence: 9 },
    { ...payload, projection_sequence: "9223372036854775808" },
    { ...payload, shard_incarnation: undefined },
    { ...payload, placement_epoch: "0" },
  ])
    assert.deepEqual(parseLiveHint(JSON.stringify(invalid)), invalidation);
});
