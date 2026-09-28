import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { Principal } from "@greenguard/tenant-auth";
import { attachSubscriptions } from "./subscriptions.js";
import { operationHash, operations } from "./query-policy.js";
import { LiveFeed } from "./live-feed.js";

const deviceId = "11111111-1111-4111-8111-111111111111";
const principal: Principal = {
  subject: "user",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  roles: ["viewer"],
  expiresAt: new Date(Date.now() + 60_000),
};

type WsMessage = {
  type: string;
  payload: {
    0: { message: string };
    data: { deviceChanged: { readingId: string } };
  };
};

function next(ws: WebSocket): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("message_timeout")),
      3000,
    );
    ws.once("message", (bytes) => {
      clearTimeout(timeout);
      resolve(JSON.parse(bytes.toString()) as WsMessage);
    });
  });
}

test("subscription verifies bearer, scopes reads and catches up after reconnect", async () => {
  const headers: string[] = [];
  let readingId = "r1";
  let denyNextSubscription = false;
  let rateChecks = 0;
  let deviceReads = 0;
  let nextDeviceGate:
    | { promise: Promise<void>; started: () => void; release: () => void }
    | undefined;
  const read = {
    async device(auth: string) {
      headers.push(auth);
      deviceReads++;
      const gate = nextDeviceGate;
      if (gate) {
        nextDeviceGate = undefined;
        gate.started();
        await gate.promise;
      }
      return auth === "Bearer tenant-a" ? { deviceId } : null;
    },
    async latest(auth: string) {
      headers.push(auth);
      return auth === "Bearer tenant-a"
        ? { deviceId, readingId, projectedAt: "now", streamVersion: 1 }
        : null;
    },
  };
  const redis = new EventEmitter() as EventEmitter & {
    subscribe: (
      channel: string,
      listener: (message: string) => void,
    ) => Promise<void>;
  };
  let receive: (message: string) => void = () => {};
  redis.subscribe = async (_channel, listener) => {
    receive = listener;
  };
  const feed = new LiveFeed(redis);
  await feed.start();
  let activeHintListeners = 0;
  const trackedFeed = {
    isReady: () => feed.isReady(),
    onHint: (...args: Parameters<LiveFeed["onHint"]>) => {
      activeHintListeners++;
      const unsubscribe = feed.onHint(...args);
      return () => {
        activeHintListeners--;
        unsubscribe();
      };
    },
    onStatus: feed.onStatus.bind(feed),
  } as unknown as LiveFeed;
  const server = createServer();
  const stop = attachSubscriptions(server, {
    verify: async (auth) => {
      if (auth !== "Bearer tenant-a" && auth !== "Bearer tenant-b")
        throw new Error("unauthorized");
      return {
        ...principal,
        tenantId:
          auth === "Bearer tenant-a"
            ? principal.tenantId
            : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      };
    },
    read,
    feed: trackedFeed,
    intervalMs: 250,
    connectionInitTimeoutMs: 50,
    rateLimiter: {
      check: async () => {
        rateChecks++;
        return { allowed: !denyNextSubscription, retryAfterSeconds: 1 };
      },
    },
  });
  server.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const url = `ws://127.0.0.1:${address.port}/graphql`;
  const connect = async (authorization: string) => {
    const ws = new WebSocket(url, "graphql-transport-ws", {
      headers: { Authorization: authorization },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "connection_init" }));
    assert.equal((await next(ws)).type, "connection_ack");
    return ws;
  };
  const subscribe = (
    ws: WebSocket,
    hash = operationHash(operations.deviceChanged),
    id = "1",
  ) =>
    ws.send(
      JSON.stringify({
        id,
        type: "subscribe",
        payload: {
          extensions: { persistedQuery: { sha256Hash: hash } },
          variables: { deviceId },
        },
      }),
    );
  try {
    const rejected = new WebSocket(url, "graphql-transport-ws");
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        rejected.once("open", resolve);
        rejected.once("error", reject);
      }),
    );
    const wrongProtocol = new WebSocket(url, "xgraphql-transport-ws", {
      headers: { Authorization: "Bearer tenant-a" },
    });
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        wrongProtocol.once("open", resolve);
        wrongProtocol.once("error", reject);
      }),
    );
    const noInit = new WebSocket(url, "graphql-transport-ws", {
      headers: { Authorization: "Bearer tenant-a" },
    });
    await new Promise<void>((resolve, reject) => {
      noInit.once("open", resolve);
      noInit.once("error", reject);
    });
    const noInitClose = await new Promise<{ code: number }>((resolve) => {
      noInit.once("close", (code) => resolve({ code }));
    });
    assert.equal(noInitClose.code, 4408);
    const foreign = await connect("Bearer tenant-b");
    subscribe(foreign);
    assert.equal((await next(foreign)).payload[0].message, "device_not_found");
    foreign.close();
    const ws = await connect("Bearer tenant-a");
    ws.send(JSON.stringify({ type: "ping" }));
    assert.equal((await next(ws)).type, "pong");
    subscribe(ws, "0".repeat(64));
    assert.equal((await next(ws)).payload[0].message, "operation_not_allowed");
    subscribe(ws);
    assert.equal((await next(ws)).payload.data.deviceChanged.readingId, "r1");
    const before = headers.length;
    readingId = "r2";
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(headers.length, before, "healthy Redis should avoid polling");
    receive(
      JSON.stringify({
        scope: "device",
        tenant: principal.tenantId,
        device: deviceId,
      }),
    );
    assert.equal((await next(ws)).payload.data.deviceChanged.readingId, "r2");
    readingId = "r3";
    redis.emit("end");
    assert.equal((await next(ws)).payload.data.deviceChanged.readingId, "r3");
    ws.close();
    readingId = "r4";
    const reconnected = await connect("Bearer tenant-a");
    subscribe(reconnected);
    assert.equal(
      (await next(reconnected)).payload.data.deviceChanged.readingId,
      "r4",
    );
    let markStarted!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pendingRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    nextDeviceGate = {
      promise: pendingRead,
      started: markStarted,
      release: releaseRead,
    };
    subscribe(reconnected, operationHash(operations.deviceChanged), "2");
    await started;
    reconnected.send(JSON.stringify({ type: "complete", id: "2" }));
    subscribe(reconnected, operationHash(operations.deviceChanged), "2");
    assert.equal(
      (await next(reconnected)).payload.data.deviceChanged.readingId,
      "r4",
    );
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      activeHintListeners,
      2,
      "stale subscription setup must not leak a feed listener",
    );
    reconnected.send(JSON.stringify({ type: "complete", id: "1" }));
    reconnected.send(JSON.stringify({ type: "complete", id: "2" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      activeHintListeners,
      0,
      "completed subscriptions release listeners",
    );
    const devicesBeforeRejectedSubscription = deviceReads;
    denyNextSubscription = true;
    subscribe(reconnected, operationHash(operations.deviceChanged), "3");
    assert.equal((await next(reconnected)).payload[0].message, "rate_limited");
    assert.equal(deviceReads, devicesBeforeRejectedSubscription);
    assert.ok(rateChecks >= 4, "each accepted subscription setup is charged");
    const extra = await connect("Bearer tenant-a");
    const excess = new WebSocket(url, "graphql-transport-ws", {
      headers: { Authorization: "Bearer tenant-a" },
    });
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        excess.once("open", resolve);
        excess.once("error", reject);
      }),
    );
    extra.close();
    reconnected.close();
    assert.ok(
      headers.every((h) => h === "Bearer tenant-a" || h === "Bearer tenant-b"),
    );
  } finally {
    await stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("silent peers lose their connection slots and subscription polling stops", async () => {
  let polls = 0;
  const server = createServer();
  const stop = attachSubscriptions(server, {
    verify: async () => ({
      ...principal,
      expiresAt: new Date(Date.now() + 60_000),
    }),
    read: {
      device: async () => ({ deviceId }) as never,
      latest: async () => {
        polls++;
        return { deviceId, readingId: `r${polls}` } as never;
      },
    },
    intervalMs: 250,
    maxConnections: 1,
    connectionInitTimeoutMs: 25,
    heartbeatIntervalMs: 20,
  });
  server.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const url = `ws://127.0.0.1:${address.port}/graphql`;
  const connect = async (autoPong = true) => {
    const ws = new WebSocket(url, "graphql-transport-ws", {
      headers: { Authorization: "Bearer valid" },
      autoPong,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return ws;
  };
  try {
    const noInit = await connect();
    assert.equal(
      await new Promise<number>((resolve) => noInit.once("close", resolve)),
      4408,
    );
    const silent = await connect(false);
    silent.send(JSON.stringify({ type: "connection_init" }));
    assert.equal((await next(silent)).type, "connection_ack");
    silent.send(
      JSON.stringify({
        id: "1",
        type: "subscribe",
        payload: {
          extensions: {
            persistedQuery: {
              sha256Hash: operationHash(operations.deviceChanged),
            },
          },
          variables: { deviceId },
        },
      }),
    );
    assert.equal((await next(silent)).type, "next");
    assert.equal(
      await new Promise<number>((resolve) => silent.once("close", resolve)),
      1006,
    );
    const afterClose = polls;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(polls, afterClose, "dead peer polling must stop");
    const recovered = await connect();
    recovered.close();
    await new Promise<void>((resolve) =>
      recovered.once("close", () => resolve()),
    );
  } finally {
    await stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("live notification demands its projection watermark and discards late old placement hints", async () => {
  const shard = "22222222-2222-4222-8222-222222222222";
  const token = (sequence: string, epoch = "2") =>
    JSON.stringify({
      v: 1,
      tenantId: principal.tenantId,
      shardIncarnation: shard,
      placementEpoch: epoch,
      sequence,
    });
  const demands: (string | undefined)[] = [];
  const redis = new EventEmitter() as EventEmitter & {
    subscribe: (
      channel: string,
      listener: (message: string) => void,
    ) => Promise<void>;
  };
  let receive: (message: string) => void = () => {};
  redis.subscribe = async (_channel, listener) => {
    receive = listener;
  };
  const feed = new LiveFeed(redis);
  await feed.start();
  const server = createServer();
  const stop = attachSubscriptions(server, {
    verify: async () => principal,
    feed,
    read: {
      async device() {
        return { deviceId };
      },
      async latest(_auth, _device, consistency) {
        assert.equal(consistency?.tenantId, principal.tenantId);
        demands.push(consistency?.minimumConsistency);
        return {
          deviceId,
          readingId: String(demands.length),
          consistencyToken: consistency?.minimumConsistency ?? token("5"),
        };
      },
    },
  });
  server.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const ws = new WebSocket(
    `ws://127.0.0.1:${address.port}/graphql`,
    "graphql-transport-ws",
    { headers: { Authorization: "Bearer one" } },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const ack = next(ws);
    ws.send(JSON.stringify({ type: "connection_init" }));
    await ack;
    const initial = next(ws);
    ws.send(
      JSON.stringify({
        type: "subscribe",
        id: "1",
        payload: {
          extensions: {
            persistedQuery: {
              sha256Hash: operationHash(operations.deviceChanged),
            },
          },
          variables: { deviceId },
        },
      }),
    );
    const initialMessage = await initial;
    assert.equal(
      (
        initialMessage.payload.data.deviceChanged as unknown as {
          consistencyToken: string;
        }
      ).consistencyToken,
      token("5"),
    );
    const refreshed = next(ws);
    receive(
      JSON.stringify({
        scope: "device",
        tenant: principal.tenantId,
        device: deviceId,
        shard_incarnation: shard,
        placement_epoch: "2",
        projection_sequence: "9",
      }),
    );
    const refreshedMessage = await refreshed;
    assert.equal(
      (
        refreshedMessage.payload.data.deviceChanged as unknown as {
          consistencyToken: string;
        }
      ).consistencyToken,
      token("9"),
    );
    assert.deepEqual(demands, [undefined, token("9")]);
    const legacyRefresh = next(ws);
    receive(
      JSON.stringify({
        scope: "device",
        tenant: principal.tenantId,
        device: deviceId,
      }),
    );
    await legacyRefresh;
    assert.equal(
      demands[2],
      token("9"),
      "legacy hint must preserve the observed minimum",
    );
    const malformedRefresh = next(ws);
    receive(
      JSON.stringify({
        scope: "device",
        tenant: principal.tenantId,
        device: deviceId,
        shard_incarnation: shard,
        placement_epoch: "2",
        projection_sequence: 9,
      }),
    );
    await malformedRefresh;
    assert.equal(
      demands[3],
      token("9"),
      "invalid optional hint proof must preserve the observed minimum",
    );
    receive(
      JSON.stringify({
        scope: "device",
        tenant: principal.tenantId,
        device: deviceId,
        shard_incarnation: shard,
        placement_epoch: "1",
        projection_sequence: "100",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      demands.length,
      4,
      "late older epoch must not poll or downgrade the observed minimum",
    );
  } finally {
    ws.close();
    await stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function recoverySubscription(
  actual: string | undefined,
  failure?: "outage" | "fresh" | "empty",
) {
  const { ReadUpstreamError } = await import("./read-client.js");
  const initialToken = JSON.stringify({
    v: 1,
    tenantId: principal.tenantId,
    shardIncarnation: "11111111-1111-4111-8111-111111111111",
    placementEpoch: "2",
    sequence: "90",
  });
  const calls: Array<string | undefined> = [];
  let changed = false;
  let nextGate: { started: () => void; promise: Promise<void> } | undefined;
  let receive: (message: string) => void = () => {};
  const redis = new EventEmitter() as EventEmitter & {
    subscribe: (
      channel: string,
      listener: (message: string) => void,
    ) => Promise<void>;
  };
  redis.subscribe = async (_channel, listener) => {
    receive = listener;
  };
  const feed = new LiveFeed(redis);
  await feed.start();
  const server = createServer();
  const stop = attachSubscriptions(server, {
    verify: async () => principal,
    feed,
    read: {
      device: async () => ({ deviceId }),
      latest: async (_authorization, _device, consistency) => {
        calls.push(consistency?.minimumConsistency);
        if (
          changed &&
          consistency?.minimumConsistency &&
          consistency.minimumConsistency !== actual
        )
          throw new ReadUpstreamError(
            failure === "outage" ? 503 : 409,
            failure === "outage"
              ? "read_freshness_unavailable"
              : "consistency_identity_mismatch",
          );
        if (changed && failure === "fresh")
          throw new ReadUpstreamError(503, "read_freshness_unavailable");
        const snapshotToken = changed ? actual : initialToken;
        const empty = changed && failure === "empty";
        const gate = nextGate;
        nextGate = undefined;
        if (gate) {
          gate.started();
          await gate.promise;
        }
        if (snapshotToken) consistency?.onWatermark?.(snapshotToken);
        if (empty) return null;
        return {
          deviceId,
          readingId: String(calls.length),
          consistencyToken: snapshotToken,
        };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port missing");
  const ws = new WebSocket(
    `ws://127.0.0.1:${address.port}/graphql`,
    "graphql-transport-ws",
    { headers: { Authorization: "Bearer one" } },
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let message = next(ws);
  ws.send(JSON.stringify({ type: "connection_init" }));
  await message;
  message = next(ws);
  ws.send(
    JSON.stringify({
      type: "subscribe",
      id: "recovery",
      payload: {
        extensions: {
          persistedQuery: {
            sha256Hash: operationHash(operations.deviceChanged),
          },
        },
        variables: { deviceId },
      },
    }),
  );
  await message;
  return {
    calls,
    initialToken,
    ws,
    receive,
    deferNext: () => {
      let started!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextGate = { started, promise };
      receive(
        JSON.stringify({
          scope: "device",
          tenant: principal.tenantId,
          device: deviceId,
        }),
      );
      return { ready, release };
    },
    trigger: (hintToken?: string) => {
      changed = true;
      const hint =
        hintToken &&
        (JSON.parse(hintToken) as {
          shardIncarnation: string;
          placementEpoch: string;
          sequence: string;
        });
      const pending = next(ws);
      receive(
        JSON.stringify({
          scope: "device",
          tenant: principal.tenantId,
          device: deviceId,
          ...(hint
            ? {
                shard_incarnation: hint.shardIncarnation,
                placement_epoch: hint.placementEpoch,
                projection_sequence: hint.sequence,
              }
            : {}),
        }),
      );
      return pending;
    },
    close: async () => {
      ws.close();
      await stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("subscription foreground mismatch resets once for a move or same-epoch incarnation restore", async () => {
  for (const epoch of ["2", "3"]) {
    const actual = JSON.stringify({
      v: 1,
      tenantId: principal.tenantId,
      shardIncarnation: "22222222-2222-4222-8222-222222222222",
      placementEpoch: epoch,
      sequence: "1",
    });
    const h = await recoverySubscription(actual);
    try {
      const result = await h.trigger(epoch === "2" ? actual : undefined);
      assert.equal(result.type, "next");
      assert.deepEqual(h.calls, [undefined, h.initialToken, undefined]);
      assert.equal(
        (
          result.payload.data.deviceChanged as unknown as {
            consistencyToken: string;
          }
        ).consistencyToken,
        actual,
      );
    } finally {
      await h.close();
    }
  }
});

test("newer hint advances minimum directly and late older hints are discarded", async () => {
  const actual = JSON.stringify({
    v: 1,
    tenantId: principal.tenantId,
    shardIncarnation: "22222222-2222-4222-8222-222222222222",
    placementEpoch: "3",
    sequence: "1",
  });
  const h = await recoverySubscription(actual);
  try {
    const result = await h.trigger(actual);
    assert.equal(result.type, "next");
    assert.deepEqual(h.calls, [undefined, actual]);
    h.receive(
      JSON.stringify({
        scope: "device",
        tenant: principal.tenantId,
        device: deviceId,
        shard_incarnation: "11111111-1111-4111-8111-111111111111",
        placement_epoch: "2",
        projection_sequence: "999",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.calls.length, 2);
  } finally {
    await h.close();
  }
});

test("subscription reset is bounded and rejects lower/unchanged/missing identity or outage", async () => {
  for (const scenario of [
    { actual: undefined },
    {
      actual: JSON.stringify({
        v: 1,
        tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        shardIncarnation: "22222222-2222-4222-8222-222222222222",
        placementEpoch: "3",
        sequence: "1",
      }),
    },
    {
      actual: JSON.stringify({
        v: 1,
        tenantId: principal.tenantId,
        shardIncarnation: "11111111-1111-4111-8111-111111111111",
        placementEpoch: "2",
        sequence: "1",
      }),
    },
    {
      actual: JSON.stringify({
        v: 1,
        tenantId: principal.tenantId,
        shardIncarnation: "22222222-2222-4222-8222-222222222222",
        placementEpoch: "1",
        sequence: "1",
      }),
    },
    {
      actual: JSON.stringify({
        v: 1,
        tenantId: principal.tenantId,
        shardIncarnation: "22222222-2222-4222-8222-222222222222",
        placementEpoch: "3",
        sequence: "1",
      }),
      failure: "outage" as const,
    },
    {
      actual: JSON.stringify({
        v: 1,
        tenantId: principal.tenantId,
        shardIncarnation: "22222222-2222-4222-8222-222222222222",
        placementEpoch: "3",
        sequence: "1",
      }),
      failure: "fresh" as const,
    },
  ]) {
    const h = await recoverySubscription(scenario.actual, scenario.failure);
    try {
      const result = await h.trigger();
      assert.equal(result.type, "error");
      assert.equal(h.calls.length, scenario.failure === "outage" ? 2 : 3);
      assert.equal(h.calls[1], h.initialToken);
    } finally {
      await h.close();
    }
  }
});

test("subscription retains the certificate when a fresh admitted reading is empty", async () => {
  const actual = JSON.stringify({
    v: 1,
    tenantId: principal.tenantId,
    shardIncarnation: "22222222-2222-4222-8222-222222222222",
    placementEpoch: "3",
    sequence: "1",
  });
  const h = await recoverySubscription(actual, "empty");
  try {
    const result = await h.trigger();
    assert.equal(result.type, "next");
    assert.deepEqual(h.calls, [undefined, h.initialToken, undefined]);
    const change = result.payload.data.deviceChanged as unknown as {
      readingId: string | null;
      consistencyToken: string;
    };
    assert.equal(change.readingId, null);
    assert.equal(change.consistencyToken, actual);
  } finally {
    await h.close();
  }
});

test("a newer hint during an old snapshot discards that snapshot and reruns at the new minimum", async () => {
  const actual = JSON.stringify({
    v: 1,
    tenantId: principal.tenantId,
    shardIncarnation: "22222222-2222-4222-8222-222222222222",
    placementEpoch: "3",
    sequence: "1",
  });
  const h = await recoverySubscription(actual);
  try {
    const gate = h.deferNext();
    await gate.ready;
    const result = h.trigger(actual);
    gate.release();
    const change = await result;
    assert.equal(change.type, "next");
    assert.equal(
      (
        change.payload.data.deviceChanged as unknown as {
          consistencyToken: string;
        }
      ).consistencyToken,
      actual,
    );
    assert.deepEqual(h.calls, [undefined, h.initialToken, actual]);
  } finally {
    await h.close();
  }
});
