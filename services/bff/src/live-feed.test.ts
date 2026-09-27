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
