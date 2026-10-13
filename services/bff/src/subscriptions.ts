import {
  parseWatermark,
  serializeWatermark,
} from "@greenguard/membership-client";
import { randomInt } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Principal } from "@greenguard/tenant-auth";
import { WebSocketServer, WebSocket } from "ws";
import { ReadClient, ReadUpstreamError } from "./read-client.js";
import { operations, resolvePersistedOperation } from "./query-policy.js";
import type { LiveFeed } from "./live-feed.js";
import { boundedRateCheck, type RateLimiter } from "./rate-limit.js";

type Verify = (authorization: string | undefined) => Promise<Principal>;
type Message = {
  type?: string;
  id?: string;
  payload?: Record<string, unknown>;
};

function parseMessage(data: WebSocket.RawData): Message | null {
  if (!Buffer.isBuffer(data)) return null;
  try {
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Message)
      : null;
  } catch {
    return null;
  }
}

function subscriptionDeviceId(payload: Record<string, unknown>): string | null {
  try {
    const operation = resolvePersistedOperation(payload);
    if (operation.query !== operations.deviceChanged) return null;
    const variables = operation.variables as
      Record<string, unknown> | undefined;
    return typeof variables?.deviceId === "string" ? variables.deviceId : null;
  } catch {
    return null;
  }
}

type SubscribeSelection =
  | { kind: "valid"; id: string; deviceId: string }
  | { kind: "error"; id: string; code: string }
  | { kind: "invalid" };

function handleHeartbeat(
  message: Message,
  send: (value: unknown) => void,
): boolean {
  if (message.type === "ping") {
    send({ type: "pong", payload: message.payload });
    return true;
  }
  return message.type === "pong";
}

function selectSubscription(
  message: Message,
  subscriptions: Map<string, () => void>,
): SubscribeSelection {
  if (
    message.type !== "subscribe" ||
    typeof message.id !== "string" ||
    !message.payload
  )
    return { kind: "invalid" };
  const id = message.id;
  if (!id || id.length > 64 || subscriptions.has(id) || subscriptions.size >= 5)
    return { kind: "error", id, code: "subscription_limit" };
  const deviceId = subscriptionDeviceId(message.payload);
  if (!deviceId) return { kind: "error", id, code: "operation_not_allowed" };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      deviceId,
    )
  )
    return { kind: "error", id, code: "invalid_device_id" };
  return { kind: "valid", id, deviceId };
}

function isSubscriptionUpgrade(request: IncomingMessage): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  const offered = (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((part) => part.trim());
  return (
    url.pathname === "/graphql" &&
    !url.search &&
    offered.includes("graphql-transport-ws")
  );
}

// The subscription is an invalidation hint. Every connect reads the durable
// projection before polling, so a missed WebSocket message cannot lose data.
export function attachSubscriptions(
  server: Server,
  options: {
    verify: Verify;
    read: Pick<ReadClient, "device" | "latest">;
    feed?: LiveFeed;
    intervalMs?: number;
    maxConnections?: number;
    maxConcurrentPolls?: number;
    rateLimiter?: RateLimiter;
    connectionInitTimeoutMs?: number;
    heartbeatIntervalMs?: number;
  },
): () => Promise<void> {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    handleProtocols: (offered) =>
      offered.has("graphql-transport-ws") ? "graphql-transport-ws" : false,
  });
  const intervalMs = Math.max(250, options.intervalMs ?? 2000);
  const maxConnections = Math.max(1, options.maxConnections ?? 100);
  const maxConcurrentPolls = Math.max(1, options.maxConcurrentPolls ?? 25);
  const callers = new Map<string, number>();
  let connectionCount = 0;
  let inFlightPolls = 0;
  const reject = (socket: Duplex, status: string) => {
    if (socket.destroyed || !socket.writable) return;
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const release = (caller: string) => {
    const remaining = (callers.get(caller) ?? 1) - 1;
    if (remaining <= 0) callers.delete(caller);
    else callers.set(caller, remaining);
  };
  server.on("upgrade", async (request, socket, head) => {
    const ignoreSocketError = () => {};
    socket.on("error", ignoreSocketError);
    socket.once("close", () => socket.off("error", ignoreSocketError));
    if (!isSubscriptionUpgrade(request)) {
      reject(socket, "400 Bad Request");
      return;
    }
    const authorization = request.headers.authorization;
    let principal: Principal;
    try {
      principal = await options.verify(authorization);
    } catch {
      reject(socket, "401 Unauthorized");
      return;
    }
    if (Date.now() >= principal.expiresAt.getTime()) {
      reject(socket, "401 Unauthorized");
      return;
    }
    if (socket.destroyed || !socket.writable) {
      socket.off("error", ignoreSocketError);
      return;
    }
    if (connectionCount >= maxConnections) {
      reject(socket, "503 Service Unavailable");
      return;
    }
    const caller = `${principal.tenantId}:${principal.subject}`;
    if ((callers.get(caller) ?? 0) >= 2) {
      reject(socket, "429 Too Many Requests");
      return;
    }
    callers.set(caller, (callers.get(caller) ?? 0) + 1);
    connectionCount++;
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      connectionCount--;
      release(caller);
    };
    socket.once("close", releaseOnce);
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        socket.off("error", ignoreSocketError);
        wss.emit("connection", ws, request, {
          authorization: authorization!,
          principal,
        });
      });
    } catch {
      socket.off("error", ignoreSocketError);
      releaseOnce();
      socket.destroy();
    }
  });
  wss.on(
    "connection",
    (
      ws: WebSocket,
      _request: IncomingMessage,
      identity: { authorization: string; principal: Principal },
    ) => {
      let initialized = false;
      const subscriptions = new Map<string, () => void>();
      const expiry = setTimeout(
        () => ws.close(4401, "token_expired"),
        Math.max(1, identity.principal.expiresAt.getTime() - Date.now()),
      );
      const initTimeout = setTimeout(
        () => {
          ws.close(4408, "connection_init_timeout");
          // A peer that ignores the close handshake must not retain a caller slot.
          initCloseForce = setTimeout(() => ws.terminate(), 1_000);
        },
        Math.max(1, options.connectionInitTimeoutMs ?? 10_000),
      );
      let initCloseForce: ReturnType<typeof setTimeout> | undefined;
      let awaitingPong = false;
      const heartbeat = setInterval(
        () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (awaitingPong) {
            ws.terminate();
            return;
          }
          awaitingPong = true;
          ws.ping();
        },
        Math.max(10, options.heartbeatIntervalMs ?? 30_000),
      );
      ws.on("pong", () => {
        awaitingPong = false;
      });
      const send = (value: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
      };
      const fail = (id: string, code: string) =>
        send({ type: "error", id, payload: [{ message: code }] });
      ws.on("error", (error) => console.error("BFF WebSocket error", error));
      ws.on("message", async (buffer) => {
        const message = parseMessage(buffer);
        if (!message) {
          ws.close(4400, "invalid_message");
          return;
        }
        if (message.type === "connection_init") {
          if (initialized) {
            ws.close(4429, "too_many_initializations");
            return;
          }
          initialized = true;
          clearTimeout(initTimeout);
          send({ type: "connection_ack" });
          return;
        }
        if (!initialized) {
          ws.close(4401, "unauthorized");
          return;
        }
        if (handleHeartbeat(message, send)) return;
        if (message.type === "complete" && typeof message.id === "string") {
          subscriptions.get(message.id)?.();
          subscriptions.delete(message.id);
          return;
        }
        const selection = selectSubscription(message, subscriptions);
        if (selection.kind === "invalid") {
          ws.close(4400, "invalid_message");
          return;
        }
        if (selection.kind === "error") {
          fail(selection.id, selection.code);
          return;
        }
        const { id, deviceId } = selection;
        let cleanup = () => {};
        const reservation = () => cleanup();
        const isCurrent = () => subscriptions.get(id) === reservation;
        subscriptions.set(id, reservation);
        if (options.rateLimiter) {
          try {
            const decision = await boundedRateCheck(
              options.rateLimiter.check(identity.principal, {
                query: operations.deviceChanged,
              }),
              1000,
            );
            if (!isCurrent()) return;
            if (!decision.allowed) {
              subscriptions.delete(id);
              fail(id, "rate_limited");
              return;
            }
          } catch {
            if (isCurrent()) {
              subscriptions.delete(id);
              fail(id, "rate_limit_unavailable");
            }
            return;
          }
        }
        try {
          const device = await options.read.device(
            identity.authorization,
            deviceId,
            { tenantId: identity.principal.tenantId },
          );
          if (!isCurrent()) return;
          if (!device) {
            subscriptions.delete(id);
            fail(id, "device_not_found");
            return;
          }
        } catch {
          if (isCurrent()) {
            subscriptions.delete(id);
            fail(id, "read_unavailable");
          }
          return;
        }
        let minimumConsistency: string | undefined;
        const observe = (token: unknown, hint = false) => {
          if (token == null) return;
          if (typeof token !== "string")
            throw new ReadUpstreamError(502, "invalid_consistency_response");
          const incoming = parseWatermark(token, identity.principal.tenantId);
          if (minimumConsistency) {
            const current = parseWatermark(
              minimumConsistency,
              identity.principal.tenantId,
            );
            if (
              hint &&
              BigInt(incoming.placementEpoch) < BigInt(current.placementEpoch)
            )
              return false;
            if (
              hint &&
              BigInt(incoming.placementEpoch) > BigInt(current.placementEpoch)
            ) {
              minimumConsistency = serializeWatermark(incoming);
              return;
            }
            if (
              current.shardIncarnation !== incoming.shardIncarnation ||
              current.placementEpoch !== incoming.placementEpoch
            )
              throw new ReadUpstreamError(409, "consistency_identity_mismatch");
            if (BigInt(current.sequence) > BigInt(incoming.sequence)) return;
          }
          minimumConsistency = serializeWatermark(incoming);
        };
        const failRead = (error: unknown) => {
          if (isCurrent()) {
            subscriptions.get(id)?.();
            subscriptions.delete(id);
            fail(
              id,
              error instanceof ReadUpstreamError
                ? error.code
                : "read_unavailable",
            );
          }
        };
        let fingerprint: string | undefined;
        let busy = false;
        let activeRead: AbortController | undefined;
        let initialPollComplete = false;
        let rerun = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const retryWhenCapacityOpens = () => {
          if (retryTimer || !isCurrent()) return;
          retryTimer = setTimeout(
            () => {
              retryTimer = undefined;
              rerun = false;
              void poll();
            },
            25 + randomInt(76),
          );
        };
        const poll = async () => {
          if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
          if (busy) {
            rerun = true;
            return;
          }
          if (inFlightPolls >= maxConcurrentPolls) {
            rerun = true;
            retryWhenCapacityOpens();
            return;
          }
          busy = true;
          inFlightPolls++;
          const controller = new AbortController();
          activeRead = controller;
          const deadline = Date.now() + 8000;
          try {
            let reading: Record<string, unknown> | null;
            let responseWatermark: string | undefined;
            const onWatermark = (token: string) => {
              responseWatermark = token;
            };
            const requestedMinimum = minimumConsistency;
            try {
              reading = (await options.read.latest(
                identity.authorization,
                deviceId,
                {
                  tenantId: identity.principal.tenantId,
                  minimumConsistency: requestedMinimum,
                  onWatermark,
                  deadline,
                  signal: controller.signal,
                },
              )) as Record<string, unknown> | null;
            } catch (error) {
              if (
                !requestedMinimum ||
                !(error instanceof ReadUpstreamError) ||
                error.status !== 409 ||
                error.code !== "consistency_identity_mismatch"
              )
                throw error;
              // Exactly one authenticated admitted snapshot discovers current identity.
              responseWatermark = undefined;
              reading = (await options.read.latest(
                identity.authorization,
                deviceId,
                {
                  tenantId: identity.principal.tenantId,
                  onWatermark,
                  deadline,
                  signal: controller.signal,
                },
              )) as Record<string, unknown> | null;
              const actualToken =
                responseWatermark ?? reading?.consistencyToken;
              if (typeof actualToken !== "string")
                throw new ReadUpstreamError(
                  502,
                  "invalid_consistency_response",
                );
              const previous = parseWatermark(
                requestedMinimum,
                identity.principal.tenantId,
              );
              const actual = parseWatermark(
                actualToken,
                identity.principal.tenantId,
              );
              if (
                BigInt(actual.placementEpoch) <
                  BigInt(previous.placementEpoch) ||
                (actual.shardIncarnation === previous.shardIncarnation &&
                  actual.placementEpoch === previous.placementEpoch)
              )
                throw new ReadUpstreamError(
                  409,
                  "consistency_identity_mismatch",
                );
              const current =
                minimumConsistency &&
                parseWatermark(minimumConsistency, identity.principal.tenantId);
              if (
                current &&
                (BigInt(current.placementEpoch) >
                  BigInt(actual.placementEpoch) ||
                  ((current.shardIncarnation !== previous.shardIncarnation ||
                    current.placementEpoch !== previous.placementEpoch) &&
                    (current.shardIncarnation !== actual.shardIncarnation ||
                      current.placementEpoch !== actual.placementEpoch)))
              )
                throw new ReadUpstreamError(
                  409,
                  "consistency_identity_mismatch",
                );
              if (
                current &&
                current.shardIncarnation === actual.shardIncarnation &&
                current.placementEpoch === actual.placementEpoch &&
                BigInt(current.sequence) > BigInt(actual.sequence)
              )
                throw new ReadUpstreamError(
                  502,
                  "consistency_minimum_unsatisfied",
                );
              minimumConsistency = serializeWatermark(actual);
            }
            const actualToken = responseWatermark ?? reading?.consistencyToken;
            if (minimumConsistency && typeof actualToken === "string") {
              const wanted = parseWatermark(
                minimumConsistency,
                identity.principal.tenantId,
              );
              const actual = parseWatermark(
                actualToken,
                identity.principal.tenantId,
              );
              // A hint can advance while an older admitted snapshot is in flight.
              // Do not publish that stale result; rerun under the newer demand.
              if (
                BigInt(wanted.placementEpoch) > BigInt(actual.placementEpoch) ||
                (wanted.shardIncarnation === actual.shardIncarnation &&
                  wanted.placementEpoch === actual.placementEpoch &&
                  BigInt(wanted.sequence) > BigInt(actual.sequence))
              ) {
                rerun = true;
                return;
              }
            }
            observe(actualToken);
            const next = JSON.stringify([reading ?? null, actualToken ?? null]);
            if (isCurrent() && next !== fingerprint) {
              fingerprint = next;
              send({
                type: "next",
                id,
                payload: {
                  data: {
                    deviceChanged: {
                      deviceId,
                      readingId: reading?.readingId ?? null,
                      projectedAt: reading?.projectedAt ?? null,
                      streamVersion: reading?.streamVersion ?? null,
                      consistencyToken: actualToken ?? null,
                    },
                  },
                },
              });
            }
          } catch (error) {
            failRead(error);
          } finally {
            if (activeRead === controller) activeRead = undefined;
            busy = false;
            inFlightPolls--;
            if (rerun) {
              rerun = false;
              void poll();
            }
          }
        };
        let timer: ReturnType<typeof setInterval> | undefined;
        const status = (ready: boolean) => {
          if (timer) clearInterval(timer);
          timer = ready
            ? undefined
            : setInterval(
                poll,
                intervalMs + randomInt(Math.max(1, Math.ceil(intervalMs / 4))),
              );
          if (ready && initialPollComplete) void poll();
        };
        const offHint = options.feed?.onHint(
          identity.principal.tenantId,
          deviceId,
          (hint) => {
            try {
              if (
                hint.scope !== "epoch" &&
                observe(hint.consistencyToken, true) === false
              )
                return;
              void poll();
            } catch (error) {
              if (
                error instanceof ReadUpstreamError &&
                error.code === "consistency_identity_mismatch"
              )
                void poll();
              else failRead(error);
            }
          },
        );
        const offStatus = options.feed?.onStatus(status);
        cleanup = () => {
          activeRead?.abort();
          if (timer) clearInterval(timer);
          if (retryTimer) clearTimeout(retryTimer);
          offHint?.();
          offStatus?.();
        };
        status(options.feed?.isReady() ?? false);
        await poll();
        initialPollComplete = true;
      });
      ws.on("close", () => {
        clearTimeout(expiry);
        clearTimeout(initTimeout);
        if (initCloseForce) clearTimeout(initCloseForce);
        clearInterval(heartbeat);
        for (const cleanup of subscriptions.values()) cleanup();
        subscriptions.clear();
      });
    },
  );
  return async () => {
    for (const client of wss.clients) client.close(1001, "shutdown");
    const force = setTimeout(() => {
      for (const client of wss.clients) client.terminate();
    }, 1000);
    try {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    } finally {
      clearTimeout(force);
    }
  };
}
