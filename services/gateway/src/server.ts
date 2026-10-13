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
  /** Selected-PDF summary only; auth and body admission keep timeoutMs. */
  summaryTimeoutMs?: number;
  websocketIdleMs?: number;
}

const PDF_UPLOAD_BODY_TIMEOUT_MS = 120_000;

type Route = { upstream: URL; websocket: boolean };
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const DEVICE = new RegExp(
  `^/api/v1/read/devices/${UUID}(?:/(?:latest|readings|rollups))?$`,
);
const SITE_DEVICES = new RegExp(`^/api/v1/read/sites/${UUID}/devices$`);
const SAGA_ID = new RegExp(`^/v1/provisioning/${UUID}$`);
const SAGA_REDRIVE = new RegExp(`^/v1/provisioning/${UUID}/redrive$`);
const RAG_OPS =
  /^\/v1\/rag\/ops\/(?:overview|retrieval|documents|evaluations|cache|traces)$/;
const ASSISTANT_DOCUMENT = new RegExp(`^/v1/assistant/documents/${UUID}$`, "i");
const ASSISTANT_DOCUMENT_STATUS = new RegExp(
  `^/v1/assistant/documents/${UUID}/versions/1$`,
  "i",
);
const ASSISTANT_DOCUMENT_SOURCE = new RegExp(
  `^/v1/assistant/documents/${UUID}/versions/([1-9][0-9]{0,9})/(?:source|source-info)$`,
  "i",
);
const ASSISTANT_SUMMARY_JOB = new RegExp(
  `^/v1/assistant/summary-jobs/${UUID}$`,
  "i",
);
const ASSISTANT_CONVERSATIONS = /^\/v1\/assistant\/conversations$/;
const ASSISTANT_CONVERSATION =
  /^\/v1\/assistant\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSISTANT_CONVERSATION_MESSAGES =
  /^\/v1\/assistant\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/messages$/i;
const ASSISTANT_SUGGESTION_USED =
  /^\/v1\/assistant\/suggestions\/[A-Za-z0-9_-]{1,64}\/used$/;
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
  "if-match",
  "traceparent",
  "tracestate",
  "x-request-id",
];
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "x-content-type-options",
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
    (method === "GET" && path === "/v1/advisor/proposals") ||
    (method === "GET" &&
      new RegExp(`^/v1/advisor/proposals/${UUID}$`, "i").test(path)) ||
    (method === "POST" &&
      new RegExp(
        `^/v1/advisor/proposals/${UUID}/(?:decision|execution)$`,
        "i",
      ).test(path))
  )
    return { upstream: options.bff, websocket: false };
  const sourceVersion = ASSISTANT_DOCUMENT_SOURCE.exec(path)?.[1];
  if (
    (method === "GET" &&
      (path === "/v1/assistant/documents" ||
        ASSISTANT_DOCUMENT_STATUS.test(path) ||
        (sourceVersion !== undefined &&
          Number(sourceVersion) <= 2147483647))) ||
    ((method === "POST" || method === "DELETE") &&
      ASSISTANT_DOCUMENT.test(path)) ||
    (method === "POST" &&
      (path === "/v1/assistant/agent" ||
        path === "/v1/assistant/summary-jobs")) ||
    ((method === "GET" || method === "DELETE") &&
      ASSISTANT_SUMMARY_JOB.test(path))
  )
    return { upstream: options.bff, websocket: false };
  if (method === "POST" && path === "/v1/knowledge/query")
    return { upstream: options.bff, websocket: false };
  if (method === "GET" && RAG_OPS.test(path))
    return { upstream: options.bff, websocket: false };
  if (
    (method === "GET" &&
      (ASSISTANT_CONVERSATIONS.test(path) ||
        ASSISTANT_CONVERSATION.test(path))) ||
    (method === "POST" &&
      (ASSISTANT_CONVERSATIONS.test(path) ||
        ASSISTANT_CONVERSATION_MESSAGES.test(path))) ||
    (method === "DELETE" && ASSISTANT_CONVERSATION.test(path))
  )
    return { upstream: options.bff, websocket: false };
  if (
    (method === "GET" && path === "/v1/assistant/suggestions") ||
    (method === "POST" && ASSISTANT_SUGGESTION_USED.test(path))
  )
    return { upstream: options.bff, websocket: false };
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

function readBody(
  request: IncomingMessage,
  max: number,
  deadline: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: Error) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) fail(new Error("body_too_large"));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error("aborted"));
    const timer = setTimeout(
      () => fail(new Error("deadline")),
      Math.max(1, deadline - Date.now()),
    );
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
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
  const upload =
    request.method === "POST" && ASSISTANT_DOCUMENT.test(target.pathname);
  if (
    upload &&
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
      "application/pdf"
  ) {
    problem(response, 415, "pdf_required");
    return;
  }
  const limit = upload ? 25 * 1024 * 1024 : (options.maxBodyBytes ?? 1_048_576);
  const length = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > limit) {
    rejectOversizedBody(request, response, "body_too_large");
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(request, limit, deadline);
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      rejectOversizedBody(request, response, "request_body_rejected");
      return;
    }
    response.setHeader("Connection", "close");
    problem(response, 408, "request_body_rejected");
    return;
  }
  // Upload body reception gets its own bounded budget; once received, the
  // ordinary upstream budget applies so a stalled BFF cannot retain a slot.
  if (upload) deadline = Date.now() + (options.timeoutMs ?? 15_000);
  // Only a fully admitted selected-PDF summary receives the longer upstream
  // deadline. Authentication and body reading already used the ordinary limit.
  if (
    request.method === "POST" &&
    ASSISTANT_CONVERSATION_MESSAGES.test(target.pathname) &&
    request.headers["content-type"]?.split(";")[0]?.trim() ===
      "application/json"
  ) {
    try {
      const value: unknown = JSON.parse(body.toString("utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const p = value as Record<string, unknown>;
        if (
          Object.keys(p).every((k) =>
            ["question", "mode", "document_id", "document_version"].includes(k),
          ) &&
          p.mode === "document_summary" &&
          typeof p.question === "string" &&
          p.question.trim().length >= 4 &&
          p.question.length <= 2000 &&
          typeof p.document_id === "string" &&
          new RegExp(`^${UUID}$`, "i").test(p.document_id) &&
          Number.isSafeInteger(p.document_version) &&
          Number(p.document_version) >= 1 &&
          Number(p.document_version) <= 2147483647
        )
          deadline = Date.now() + (options.summaryTimeoutMs ?? 310_000);
      }
    } catch {
      /* Invalid payload keeps the ordinary deadline and BFF validation. */
    }
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
  metricsServer: Server;
}

const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;
type GatewayRoute =
  | "/v1/knowledge/query"
  | "/v1/rag/ops/:section"
  | "/v1/assistant/agent"
  | "/v1/assistant/conversations"
  | "/v1/assistant/conversations/:id"
  | "/v1/assistant/conversations/:id/messages"
  | "/v1/assistant/documents"
  | "/v1/assistant/documents/:id"
  | "/v1/assistant/documents/:id/versions/:version/:source"
  | "/v1/assistant/documents/:id/versions/1"
  | "/v1/assistant/summary-jobs"
  | "/v1/assistant/summary-jobs/:id"
  | "/v1/assistant/suggestions"
  | "/v1/assistant/suggestions/:id/used"
  | "/v1/advisor/proposals"
  | "/v1/advisor/proposals/:id"
  | "/v1/advisor/proposals/:id/decision"
  | "/v1/advisor/proposals/:id/execution"
  | "/graphql"
  | "/api/v1/read/search"
  | "/api/v1/read/devices/:deviceId"
  | "/api/v1/read/sites/:siteId/devices"
  | "/v1/provisioning"
  | "/v1/provisioning/:id"
  | "/v1/provisioning/:id/redrive"
  | "/api/v1/subscription-ticket"
  | "/healthz"
  | "/readyz"
  | "unmatched";

class GatewayMetrics {
  private requests = new Map<string, number>();
  private durations = new Map<
    string,
    { count: number; sum: number; buckets: number[] }
  >();

  observe(
    method: string,
    route: GatewayRoute,
    status: number | "aborted",
    seconds: number,
  ): void {
    const requestKey = `${method}\u0000${route}\u0000${status}`;
    this.requests.set(requestKey, (this.requests.get(requestKey) ?? 0) + 1);
    const durationKey = `${method}\u0000${route}`;
    const duration = this.durations.get(durationKey) ?? {
      count: 0,
      sum: 0,
      buckets: DURATION_BUCKETS.map(() => 0),
    };
    duration.count += 1;
    duration.sum += seconds;
    const bucketIndex = DURATION_BUCKETS.findIndex((bound) => seconds <= bound);
    if (bucketIndex >= 0) duration.buckets[bucketIndex]! += 1;
    this.durations.set(durationKey, duration);
  }

  render(): string {
    const lines = [
      "# HELP greenguard_gateway_http_requests_total Total HTTP requests handled by the gateway.",
      "# TYPE greenguard_gateway_http_requests_total counter",
    ];
    for (const [key, value] of this.requests) {
      const [method, route, status] = key.split("\u0000");
      lines.push(
        `greenguard_gateway_http_requests_total{method="${method}",route="${route}",status_code="${status}"} ${value}`,
      );
    }
    lines.push(
      "# HELP greenguard_gateway_http_request_duration_seconds HTTP request duration in seconds.",
      "# TYPE greenguard_gateway_http_request_duration_seconds histogram",
    );
    for (const [key, value] of this.durations) {
      const [method, route] = key.split("\u0000");
      let cumulative = 0;
      DURATION_BUCKETS.forEach((bound, index) => {
        cumulative += value.buckets[index]!;
        lines.push(
          `greenguard_gateway_http_request_duration_seconds_bucket{method="${method}",route="${route}",le="${bound}"} ${cumulative}`,
        );
      });
      lines.push(
        `greenguard_gateway_http_request_duration_seconds_bucket{method="${method}",route="${route}",le="+Inf"} ${value.count}`,
      );
      lines.push(
        `greenguard_gateway_http_request_duration_seconds_sum{method="${method}",route="${route}"} ${value.sum}`,
      );
      lines.push(
        `greenguard_gateway_http_request_duration_seconds_count{method="${method}",route="${route}"} ${value.count}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}

function metricRoute(raw: string | undefined, method: string): GatewayRoute {
  const path = parseTarget(raw ?? "")?.pathname;
  if (!path) return "unmatched";
  if (path === "/v1/knowledge/query") return "/v1/knowledge/query";
  if (RAG_OPS.test(path)) return "/v1/rag/ops/:section";
  if (path === "/v1/assistant/agent") return "/v1/assistant/agent";
  if (ASSISTANT_CONVERSATIONS.test(path)) return "/v1/assistant/conversations";
  if (ASSISTANT_CONVERSATION.test(path))
    return "/v1/assistant/conversations/:id";
  if (ASSISTANT_CONVERSATION_MESSAGES.test(path))
    return "/v1/assistant/conversations/:id/messages";
  if (path === "/v1/assistant/documents") return "/v1/assistant/documents";
  if (ASSISTANT_DOCUMENT.test(path)) return "/v1/assistant/documents/:id";
  if (ASSISTANT_DOCUMENT_STATUS.test(path))
    return "/v1/assistant/documents/:id/versions/1";
  if (ASSISTANT_DOCUMENT_SOURCE.test(path))
    return "/v1/assistant/documents/:id/versions/:version/:source";
  if (path === "/v1/assistant/summary-jobs")
    return "/v1/assistant/summary-jobs";
  if (ASSISTANT_SUMMARY_JOB.test(path)) return "/v1/assistant/summary-jobs/:id";
  if (path === "/v1/assistant/suggestions") return "/v1/assistant/suggestions";
  if (ASSISTANT_SUGGESTION_USED.test(path))
    return "/v1/assistant/suggestions/:id/used";
  if (path === "/v1/advisor/proposals") return "/v1/advisor/proposals";
  if (new RegExp(`^/v1/advisor/proposals/${UUID}$`, "i").test(path))
    return "/v1/advisor/proposals/:id";
  if (new RegExp(`^/v1/advisor/proposals/${UUID}/decision$`, "i").test(path))
    return "/v1/advisor/proposals/:id/decision";
  if (new RegExp(`^/v1/advisor/proposals/${UUID}/execution$`, "i").test(path))
    return "/v1/advisor/proposals/:id/execution";
  if (path === "/healthz") return "/healthz";
  if (path === "/readyz") return "/readyz";
  if (path === "/graphql") return "/graphql";
  if (path === "/api/v1/subscription-ticket")
    return "/api/v1/subscription-ticket";
  if (path === "/api/v1/read/search") return "/api/v1/read/search";
  if (DEVICE.test(path)) return "/api/v1/read/devices/:deviceId";
  if (SITE_DEVICES.test(path)) return "/api/v1/read/sites/:siteId/devices";
  if (method === "POST" && path === "/v1/provisioning")
    return "/v1/provisioning";
  if (SAGA_REDRIVE.test(path)) return "/v1/provisioning/:id/redrive";
  if (SAGA_ID.test(path)) return "/v1/provisioning/:id";
  return "unmatched";
}

function metricMethod(method: string | undefined): string {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(
    method ?? "",
  )
    ? method!
    : "OTHER";
}

export function createGateway(options: GatewayOptions): GatewayServer {
  const timeout = options.timeoutMs ?? 15_000;
  if (
    !Number.isFinite(timeout) ||
    timeout < 100 ||
    timeout > 30_000 ||
    !Number.isInteger(options.summaryTimeoutMs ?? 310_000) ||
    (options.summaryTimeoutMs ?? 310_000) < timeout ||
    (options.summaryTimeoutMs ?? 310_000) > 310_000 ||
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
  const metrics = new GatewayMetrics();
  let activeUploads = 0;
  const tenantUploads = new Map<string, number>();
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
    const started = process.hrtime.bigint();
    const method = metricMethod(request.method);
    const routeLabel = metricRoute(request.url, method);
    let recorded = false;
    const record = (status: number | "aborted") => {
      if (recorded) return;
      recorded = true;
      metrics.observe(
        method,
        routeLabel,
        status,
        Number(process.hrtime.bigint() - started) / 1_000_000_000,
      );
    };
    response.once("finish", () => {
      record(response.statusCode);
    });
    response.once("close", () => {
      // A response that closes before finish never reaches the finish handler.
      // Count it once under a bounded sentinel instead of inventing an HTTP code.
      if (!response.writableFinished) record("aborted");
    });
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
      let principal: Principal;
      try {
        principal = await withDeadline(
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
      const upload =
        request.method === "POST" && ASSISTANT_DOCUMENT.test(incoming.pathname);
      if (
        upload &&
        (activeUploads >= 4 ||
          (tenantUploads.get(principal.tenantId) ?? 0) >= 2)
      ) {
        response.setHeader("Retry-After", "1");
        response.setHeader("Connection", "close");
        problem(response, 503, "upload_capacity_unavailable");
        return;
      }
      if (upload) {
        activeUploads++;
        tenantUploads.set(
          principal.tenantId,
          (tenantUploads.get(principal.tenantId) ?? 0) + 1,
        );
        // Release only after response finish/close, not when proxyHTTP returns
        // after dispatch. This bounds buffered bodies throughout upload execution.
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            activeUploads--;
            const remaining = (tenantUploads.get(principal.tenantId) ?? 1) - 1;
            if (remaining > 0) tenantUploads.set(principal.tenantId, remaining);
            else tenantUploads.delete(principal.tenantId);
          }
        };
        response.once("finish", release);
        response.once("close", release);
      }
      await proxyHTTP(
        request,
        response,
        targetURL(selected.upstream, incoming),
        options,
        upload ? Date.now() + PDF_UPLOAD_BODY_TIMEOUT_MS : deadline,
      );
    })().catch(() => {
      if (response.headersSent || response.destroyed) response.destroy();
      else problem(response, 500, "internal_error");
    });
  }) as GatewayServer;
  server.metricsServer = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/metrics") {
      response.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }
    response
      .writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(metrics.render());
  });
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
  // Node's body ceiling must permit the exact PDF upload route. Ordinary
  // requests still use their own shorter auth/body/upstream deadlines above.
  server.requestTimeout = PDF_UPLOAD_BODY_TIMEOUT_MS;
  server.headersTimeout = Math.min(timeout, 10_000);
  server.keepAliveTimeout = 5_000;
  return server;
}
