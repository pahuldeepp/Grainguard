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
  const read = {
    async device(auth: string) {
      headers.push(auth);
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
    feed,
    intervalMs: 250,
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
  ) =>
    ws.send(
      JSON.stringify({
        id: "1",
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
