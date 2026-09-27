import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Agent,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import { AuthError, type Principal } from "@greenguard/tenant-auth";

export interface GatewayOptions {
  verify: (authorization: string | undefined) => Promise<Principal>;
  bff: URL;
  read: URL;
  saga: URL;
  sagaAgent?: Agent;
  timeoutMs?: number;
  maxBodyBytes?: number;
  websocketIdleMs?: number;
}

type Route = { upstream: URL; websocket: boolean };
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const DEVICE = new RegExp(
  `^/api/v1/read/devices/${UUID}(?:/(?:latest|readings|rollups))?$`,
);
const SITE_DEVICES = new RegExp(`^/api/v1/read/sites/${UUID}/devices$`);
const SAGA_ID = new RegExp(`^/v1/provisioning/${UUID}$`);
const SAGA_REDRIVE = new RegExp(`^/v1/provisioning/${UUID}/redrive$`);
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_HEADERS = [
  "authorization",
  "accept",
  "accept-language",
  "content-type",
  "idempotency-key",
  "traceparent",
  "tracestate",
  "x-request-id",
];
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "retry-after",
  "x-request-id",
  "vary",
];
const BAD_QUERY = new Set([
  "tenant_id",
  "tenant",
  "access_token",
  "token",
  "authorization",
  "auth",
]);

function route(
  path: string,
  method: string,
  options: GatewayOptions,
  upgrade: boolean,
): Route | null {
  if (
    path === "/graphql" &&
    (upgrade ? method === "GET" : method === "GET" || method === "POST")
  )
    return { upstream: options.bff, websocket: upgrade };
  if (upgrade) return null;
  if (
    method === "GET" &&
    (path === "/api/v1/read/search" ||
      DEVICE.test(path) ||
      SITE_DEVICES.test(path))
  )
    return { upstream: options.read, websocket: false };
  if (method === "POST" && path === "/v1/provisioning")
    return { upstream: options.saga, websocket: false };
  if (method === "GET" && SAGA_ID.test(path))
    return { upstream: options.saga, websocket: false };
  if (method === "POST" && SAGA_REDRIVE.test(path))
    return { upstream: options.saga, websocket: false };
  return null;
}

function targetURL(upstream: URL, incoming: URL): URL {
  return new URL(incoming.pathname + incoming.search, upstream);
}

function headersFor(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function problem(response: ServerResponse, status: number, code: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ code }));
}

function socketProblem(socket: Duplex, status: number, code: string): void {
  if (!socket.writable) return;
  const body = JSON.stringify({ code });
  const statusText = STATUS_CODES[status] ?? "Error";
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function authFailure(error: unknown): { status: number; code: string } {
  if (error instanceof Error && error.message === "deadline")
    return { status: 504, code: "request_deadline" };
  return error instanceof AuthError
    ? { status: error.status, code: error.code }
    : { status: 503, code: "auth_unavailable" };
}

function parseTarget(raw: string | undefined): URL | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  const rawPath = raw.split("?", 1)[0];
  if (/%2f|%5c|%2e|\\|\/\//i.test(rawPath)) return null;
  try {
    const parsed = new URL(raw, "https://gateway.invalid");
    return parsed.pathname === rawPath ? parsed : null;
  } catch {
    return null;
  }
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const ms = Math.max(1, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function readBody(request: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        request.off("data", onData);
        request.pause();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    };
    request.on("data", onData);
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("aborted")));
  });
}

function rejectOversizedBody(
  request: IncomingMessage,
  response: ServerResponse,
  code: string,
): void {
  response.setHeader("connection", "close");
  response.once("finish", () => request.destroy());
  problem(response, 413, code);
}

function makeRequest(url: URL, options: Parameters<typeof httpRequest>[1]) {
  return (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options);
}

function checkReady(url: URL, agent?: Agent): Promise<boolean> {
  return new Promise((resolve) => {
    const req = makeRequest(url, { method: "GET", agent, timeout: 2_000 });
    req.once("response", (res) => {
      res.resume();
      resolve(res.statusCode === 204 || res.statusCode === 200);
    });
    req.once("timeout", () => req.destroy());
    req.once("error", () => resolve(false));
    req.end();
  });
}

async function proxyHTTP(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  options: GatewayOptions,
  deadline: number,
): Promise<void> {
  const limit = options.maxBodyBytes ?? 1_048_576;
  const length = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > limit) {
    rejectOversizedBody(request, response, "body_too_large");
    return;
  }
  let body: Buffer;
  try {
    body = await withDeadline(readBody(request, limit), deadline);
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      rejectOversizedBody(request, response, "request_body_rejected");
      return;
    }
    problem(response, 408, "request_body_rejected");
    return;
  }
  const headers = headersFor(request);
  headers["content-length"] = String(body.length);
  const upstream = makeRequest(target, {
    method: request.method,
    headers,
    agent:
      target.origin === options.saga.origin ? options.sagaAgent : undefined,
  });
  const timer = setTimeout(
    () => upstream.destroy(new Error("deadline")),
    Math.max(1, deadline - Date.now()),
  );
  upstream.once("response", (from) => {
    const outgoing: Record<string, string | number | string[]> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = from.headers[name];
      if (value !== undefined && !HOP.has(name)) outgoing[name] = value;
    }
    response.writeHead(from.statusCode ?? 502, outgoing);
    pipeline(from, response, (error) => {
      clearTimeout(timer);
      if (error) upstream.destroy(error);
    });
  });
  upstream.once("error", (error) => {
    clearTimeout(timer);
    problem(
      response,
      error.message === "deadline" ? 504 : 502,
      "upstream_unavailable",
    );
  });
  request.once("aborted", () => upstream.destroy());
  upstream.end(body);
}

function validWebSocket(request: IncomingMessage): boolean {
  const key = request.headers["sec-websocket-key"];
  return (
    request.headers.upgrade?.toLowerCase() === "websocket" &&
    request.headers.connection
      ?.toLowerCase()
      .split(",")
      .map((part) => part.trim())
      .includes("upgrade") === true &&
    request.headers["sec-websocket-version"] === "13" &&
    typeof key === "string" &&
    Buffer.from(key, "base64").length === 16
  );
}

async function proxyUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: URL,
  options: GatewayOptions,
  authorization?: string,
): Promise<void> {
  const headers = headersFor(request);
  if (authorization) headers.authorization = authorization;
  for (const name of [
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
    "origin",
  ]) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  // A browser sends its one-use ticket as a subprotocol. Only the GraphQL
  // protocol reaches the BFF; the ticket is never reflected in the handshake.
  if (authorization) headers["sec-websocket-protocol"] = "graphql-transport-ws";
  const upstream = makeRequest(target, { method: "GET", headers });
  const abortOnClientClose = () => upstream.destroy();
  socket.once("close", abortOnClientClose);
  const timer = setTimeout(
    () => upstream.destroy(new Error("deadline")),
    options.timeoutMs ?? 15_000,
  );
  upstream.once("upgrade", (from, upstreamSocket, upstreamHead) => {
    socket.off("close", abortOnClientClose);
    clearTimeout(timer);
    if (socket.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    const selected = from.headers["sec-websocket-protocol"];
    const offered = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((part) => part.trim());
    if (typeof selected === "string" && !offered.includes(selected)) {
      upstreamSocket.destroy();
      socketProblem(socket, 502, "bad_websocket_protocol");
      return;
    }
    const accept = from.headers["sec-websocket-accept"];
    if (typeof accept !== "string") {
      upstreamSocket.destroy();
      socketProblem(socket, 502, "bad_websocket_handshake");
      return;
    }
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (typeof selected === "string")
      lines.push(`Sec-WebSocket-Protocol: ${selected}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    const idle = options.websocketIdleMs ?? 300_000;
    socket.once("close", () => upstreamSocket.destroy());
    upstreamSocket.once("close", () => socket.destroy());
    if ("setTimeout" in socket && typeof socket.setTimeout === "function")
      (socket as import("node:net").Socket).setTimeout(idle, () =>
        socket.destroy(),
      );
    upstreamSocket.setTimeout(idle, () => upstreamSocket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => socket.destroy());
    socket.pipe(upstreamSocket).pipe(socket);
  });
  upstream.once("response", () => {
    socket.off("close", abortOnClientClose);
    clearTimeout(timer);
    socketProblem(socket, 502, "upstream_no_upgrade");
  });
  upstream.once("error", () => {
    socket.off("close", abortOnClientClose);
    clearTimeout(timer);
    socketProblem(socket, 502, "upstream_unavailable");
  });
  upstream.end();
}

type Ticket = {
  authorization: string;
  origin?: string;
  expires: number;
  subject: string;
  tenantId: string;
};

async function issueSubscriptionTicket(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayOptions,
  timeout: number,
  tickets: Map<string, Ticket>,
): Promise<void> {
  let principal: Principal;
  try {
    principal = await withDeadline(
      options.verify(request.headers.authorization),
      Date.now() + timeout,
    );
  } catch (error) {
    const failure = authFailure(error);
    problem(response, failure.status, failure.code);
    return;
  }
  if (principal.principalType === "service") {
    problem(response, 403, "insufficient_role");
    return;
  }
  const origin = request.headers.origin;
  if (
    origin !== undefined &&
    (typeof origin !== "string" || !/^https?:\/\/[^/]+$/.test(origin))
  ) {
    problem(response, 400, "invalid_origin");
    return;
  }
  for (const [key, value] of tickets)
    if (value.expires <= Date.now()) tickets.delete(key);
  if (tickets.size >= 10_000) {
    problem(response, 503, "tickets_unavailable");
    return;
  }
  const principalTickets = [...tickets.values()].filter(
    (entry) =>
      entry.subject === principal.subject &&
      entry.tenantId === principal.tenantId,
  ).length;
  if (principalTickets >= 5) {
    problem(response, 429, "too_many_subscription_tickets");
    return;
  }
  const ticket = randomBytes(32).toString("base64url");
  const lifetimeMs = 30_000;
  tickets.set(ticket, {
    authorization: request.headers.authorization!,
    origin,
    expires: Date.now() + lifetimeMs,
    subject: principal.subject,
    tenantId: principal.tenantId,
  });
  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ ticket, expiresIn: lifetimeMs / 1000 }));
}

export interface GatewayServer extends Server {
  closeUpgradedConnections(): void;
}

export function createGateway(options: GatewayOptions): GatewayServer {
  const timeout = options.timeoutMs ?? 15_000;
  if (
    !Number.isFinite(timeout) ||
    timeout < 100 ||
    timeout > 30_000 ||
    !Number.isInteger(options.maxBodyBytes ?? 1_048_576) ||
    (options.maxBodyBytes ?? 1_048_576) < 1 ||
    (options.maxBodyBytes ?? 1_048_576) > 10_485_760
  )
    throw new Error("invalid_gateway_limits");
  for (const upstream of [options.bff, options.read, options.saga]) {
    if (upstream.protocol !== "http:" && upstream.protocol !== "https:")
      throw new Error("invalid_upstream_protocol");
    if (
      upstream.pathname !== "/" ||
      upstream.search ||
      upstream.hash ||
      upstream.username ||
      upstream.password
    )
      throw new Error("upstream_must_be_origin");
  }
  const tickets = new Map<string, Ticket>();
  const upgradedSockets = new Set<Duplex>();
  let readiness: { value: boolean; until: number } | undefined;
  let readinessCheck: Promise<boolean> | undefined;
  const ready = () => {
    if (readiness && readiness.until > Date.now())
      return Promise.resolve(readiness.value);
    if (readinessCheck) return readinessCheck;
    const checks = [
      [options.bff, "/readyz"],
      [options.read, "/readyz"],
      [options.saga, "/healthz"],
    ] as const;
    readinessCheck = Promise.all(
      checks.map(([origin, route]) =>
        checkReady(
          new URL(route, origin),
          origin === options.saga ? options.sagaAgent : undefined,
        ),
      ),
    )
      .then((values) => {
        const value = values.every(Boolean);
        readiness = { value, until: Date.now() + 1000 };
        return value;
      })
      .finally(() => {
        readinessCheck = undefined;
      });
    return readinessCheck;
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/healthz") {
        response.writeHead(204).end();
        return;
      }
      if (request.url === "/readyz") {
        response.writeHead((await ready()) ? 204 : 503).end();
        return;
      }
      if (
        request.url === "/api/v1/subscription-ticket" &&
        request.method === "POST"
      ) {
        await issueSubscriptionTicket(
          request,
          response,
          options,
          timeout,
          tickets,
        );
        return;
      }
      const parsed = parseTarget(request.url);
      if (!parsed) {
        problem(response, 400, "invalid_url");
        return;
      }
      const incoming = parsed;
      if (
        [...incoming.searchParams.keys()].some((key) =>
          BAD_QUERY.has(key.toLowerCase()),
        )
      ) {
        problem(response, 400, "identity_in_query");
        return;
      }
      const selected = route(
        incoming.pathname,
        request.method ?? "",
        options,
        false,
      );
      if (!selected) {
        problem(response, 404, "route_not_found");
        return;
      }
      const deadline = Date.now() + timeout;
      try {
        const principal = await withDeadline(
          options.verify(request.headers.authorization),
          deadline,
        );
        if (
          principal.principalType === "service" &&
          incoming.pathname.startsWith("/v1/provisioning")
        ) {
          problem(response, 403, "insufficient_role");
          return;
        }
      } catch (error) {
        const failure = authFailure(error);
        problem(response, failure.status, failure.code);
        return;
      }
      await proxyHTTP(
        request,
        response,
        targetURL(selected.upstream, incoming),
        options,
        deadline,
      );
    })().catch(() => {
      if (response.headersSent || response.destroyed) response.destroy();
      else problem(response, 500, "internal_error");
    });
  }) as GatewayServer;
  server.closeUpgradedConnections = () => {
    for (const socket of upgradedSockets) socket.destroy();
  };
  server.on("checkContinue", (_request, response) =>
    problem(response, 417, "expectation_not_supported"),
  );
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    void (async () => {
      const parsed = parseTarget(request.url);
      if (!parsed) {
        socketProblem(socket, 400, "invalid_url");
        return;
      }
      const incoming = parsed;
      if (
        [...incoming.searchParams.keys()].some((key) =>
          BAD_QUERY.has(key.toLowerCase()),
        )
      ) {
        socketProblem(socket, 400, "identity_in_query");
        return;
      }
      const selected = route(
        incoming.pathname,
        request.method ?? "",
        options,
        true,
      );
      if (!selected || !validWebSocket(request)) {
        socketProblem(socket, 400, "invalid_websocket_route");
        return;
      }
      const protocols = (request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((part) => part.trim());
      const ticketProtocols = protocols.filter((part) =>
        part.startsWith("ticket."),
      );
      let authorization = request.headers.authorization;
      if (ticketProtocols.length) {
        if (
          ticketProtocols.length !== 1 ||
          !protocols.includes("graphql-transport-ws") ||
          authorization
        ) {
          socketProblem(socket, 400, "invalid_subscription_ticket");
          return;
        }
        const ticket = ticketProtocols[0]!.slice("ticket.".length);
        const saved = tickets.get(ticket);
        tickets.delete(ticket);
        if (
          !saved ||
          saved.expires <= Date.now() ||
          saved.origin !== request.headers.origin
        ) {
          socketProblem(socket, 401, "invalid_subscription_ticket");
          return;
        }
        authorization = saved.authorization;
      }
      try {
        const principal = await withDeadline(
          options.verify(authorization),
          Date.now() + timeout,
        );
        if (principal.principalType === "service") {
          socketProblem(socket, 403, "insufficient_role");
          return;
        }
      } catch (error) {
        const failure = authFailure(error);
        socketProblem(socket, failure.status, failure.code);
        return;
      }
      await proxyUpgrade(
        request,
        socket,
        head,
        targetURL(selected.upstream, incoming),
        options,
        ticketProtocols.length ? authorization : undefined,
      );
    })().catch(() => {
      if (!socket.destroyed) socketProblem(socket, 500, "internal_error");
    });
  });
  server.requestTimeout = timeout;
  server.headersTimeout = Math.min(timeout, 10_000);
  server.keepAliveTimeout = 5_000;
  return server;
}
