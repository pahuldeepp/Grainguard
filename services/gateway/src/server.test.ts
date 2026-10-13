import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import { createGateway, type GatewayServer } from "./server.js";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import {
  createMembershipCache,
  createMembershipVerifier,
  membershipChangedHandler,
  identityKey,
} from "@greenguard/membership-client";

test("a still-valid JWT loses gateway access after membership.changed", async () => {
  const issuer = await createTestIssuer();
  let revoked = false;
  const cache = createMembershipCache({
    fetch: async () =>
      revoked
        ? { tenantId: tenantA, roles: [], version: "2", state: "revoked" }
        : {
            tenantId: tenantA,
            roles: ["viewer"],
            version: "1",
            state: "active",
          },
  });
  const verifier = createMembershipVerifier(
    {
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { getKey: issuer.getKey },
    },
    cache,
  );
  const upstream = createServer((_req, res) => res.writeHead(200).end("ok"));
  const origin = await listen(upstream);
  const server = createGateway({
    verify: verifier.verify,
    bff: origin,
    read: origin,
    saga: origin,
    maxBodyBytes: 1024,
    timeoutMs: 1000,
  });
  const address = await listen(server);
  try {
    const bearer = `Bearer ${await issuer.sign({ sub: "alice", tenant_id: tenantB, roles: ["admin"] })}`;
    const call = () =>
      fetch(
        new URL(
          "/api/v1/read/devices/33333333-3333-4333-8333-333333333333",
          address,
        ),
        { headers: { Authorization: bearer } },
      );
    assert.equal((await call()).status, 200);
    revoked = true;
    await membershipChangedHandler(cache)({
      event_type: "membership.changed",
      tenant_id: tenantA,
      payload: {
        identity_id: identityKey(issuer.issuer, "alice"),
        membership_version: "2",
      },
    });
    const denied = await call();
    assert.equal(denied.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
test("machine may proxy read and GraphQL but cannot start provisioning or obtain a subscription ticket", async () => {
  const upstream = createServer((_req, res) => res.writeHead(200).end("ok"));
  const origin = await listen(upstream);
  const machine: Principal = {
    subject: "33333333-3333-4333-8333-333333333333",
    tenantId: tenantA,
    roles: [],
    expiresAt: new Date(Date.now() + 60_000),
    principalType: "service",
    scopes: ["read:telemetry"],
  };
  const server = createGateway({
    verify: async () => machine,
    bff: origin,
    read: origin,
    saga: origin,
  });
  const address = await listen(server);
  try {
    assert.equal(
      (
        await fetch(
          new URL(`/api/v1/read/devices/${machine.subject}`, address),
          { headers: { authorization: "Bearer machine" } },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(new URL("/graphql", address), {
          headers: { authorization: "Bearer machine" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(new URL("/v1/provisioning", address), {
          method: "POST",
          headers: { authorization: "Bearer machine" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(new URL("/api/v1/subscription-ticket", address), {
          method: "POST",
          headers: { authorization: "Bearer machine" },
        })
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const principal: Principal = {
  subject: "user",
  tenantId: tenantA,
  roles: ["viewer"],
  expiresAt: new Date(Date.now() + 60_000),
};
const upstreams: Server[] = [];
let gateway: GatewayServer;
let base: string;
const sockets = new Set<import("node:net").Socket>();

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return new URL(`http://127.0.0.1:${address.port}`);
}

before(async () => {
  const bff = createServer((req, res) => {
    if (req.url === "/readyz") {
      res.writeHead(204).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        service: "bff",
        path: req.url,
        authorization: req.headers.authorization,
        tenantHeader: req.headers["x-tenant-id"],
        traceparent: req.headers.traceparent,
      }),
    );
  });
  bff.on("upgrade", (req, socket) => {
    if (
      req.headers.authorization !== "Bearer good" ||
      req.headers["sec-websocket-protocol"] !== "graphql-transport-ws"
    ) {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1")
      .update(String(key) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n\r\n`,
    );
    setTimeout(() => socket.destroy(), 100);
  });
  const read = createServer((req, res) => {
    if (req.url === "/readyz") {
      res.writeHead(204).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        service: "read",
        path: req.url,
        authorization: req.headers.authorization,
        tenantHeader: req.headers["x-tenant-id"],
      }),
    );
  });
  const saga = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(204).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        service: "saga",
        path: req.url,
        authorization: req.headers.authorization,
      }),
    );
  });
  upstreams.push(bff, read, saga);
  const [bffURL, readURL, sagaURL] = await Promise.all(upstreams.map(listen));
  gateway = createGateway({
    bff: bffURL,
    read: readURL,
    saga: sagaURL,
    verify: async (authorization) => {
      if (!authorization) throw new AuthError(401, "missing_token");
      if (authorization !== "Bearer good")
        throw new AuthError(401, "invalid_token");
      return principal;
    },
    maxBodyBytes: 16,
    timeoutMs: 1_000,
  });
  gateway.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  base = (await listen(gateway)).origin;
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    [gateway, ...upstreams].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

function req(path: string, init: RequestInit = {}) {
  return fetch(base + path, {
    ...init,
    headers: { authorization: "Bearer good", ...init.headers },
  });
}

test("public liveness and dependency readiness", async () => {
  assert.equal((await fetch(base + "/healthz")).status, 204);
  assert.equal((await fetch(base + "/readyz")).status, 204);
});

test("application RED metrics use a private listener and bounded route labels", async () => {
  assert.equal((await fetch(base + "/metrics")).status, 404);
  const metricsServer = gateway.metricsServer;
  await new Promise<void>((resolve) =>
    metricsServer.listen(0, "127.0.0.1", resolve),
  );
  try {
    await req("/api/v1/read/search?q=one");
    await req("/api/v1/read/devices/33333333-3333-4333-8333-333333333333");
    const address = metricsServer.address();
    assert.ok(address && typeof address !== "string");
    const scrape = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    assert.equal(scrape.status, 200);
    assert.match(scrape.headers.get("content-type") ?? "", /text\/plain/);
    const body = await scrape.text();
    assert.match(
      body,
      /greenguard_gateway_http_requests_total\{method="GET",route="\/api\/v1\/read\/search",status_code="200"\} 1/,
    );
    assert.match(
      body,
      /greenguard_gateway_http_request_duration_seconds_bucket/,
    );
    const histogramBuckets = body
      .split("\n")
      .filter((line) =>
        line.startsWith(
          'greenguard_gateway_http_request_duration_seconds_bucket{method="GET",route="/api/v1/read/search"',
        ),
      )
      .map((line) => {
        const match = line.match(/le="([^"]+)"\} (\d+)$/);
        assert.ok(match, `invalid histogram bucket line: ${line}`);
        return { bound: match[1]!, value: Number(match[2]) };
      });
    const histogramCount = Number(
      body.match(
        /greenguard_gateway_http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/read\/search"\} (\d+)/,
      )?.[1],
    );
    assert.equal(histogramCount, 1);
    assert.equal(histogramBuckets.at(-1)?.bound, "+Inf");
    assert.equal(histogramBuckets.at(-1)?.value, histogramCount);
    assert.ok(
      histogramBuckets.every((bucket) => bucket.value <= histogramCount),
    );
    assert.ok(
      histogramBuckets.every(
        (bucket, index) =>
          index === 0 || bucket.value >= histogramBuckets[index - 1]!.value,
      ),
    );
    assert.doesNotMatch(body, /33333333-3333-4333-8333-333333333333/);
    assert.equal(
      (await fetch(`http://127.0.0.1:${address.port}/graphql`)).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
  }
});

test("a prematurely closed response is counted once with an aborted status", async () => {
  let upstreamReceived!: () => void;
  const received = new Promise<void>((resolve) => (upstreamReceived = resolve));
  const upstream = createServer(() => upstreamReceived());
  const origin = await listen(upstream);
  const server = createGateway({
    verify: async () => principal,
    bff: origin,
    read: origin,
    saga: origin,
    timeoutMs: 5_000,
  });
  const address = await listen(server);
  const metricsServer = server.metricsServer;
  await new Promise<void>((resolve) =>
    metricsServer.listen(0, "127.0.0.1", resolve),
  );
  try {
    const client = httpRequest(new URL("/api/v1/read/search", address), {
      headers: { authorization: "Bearer good" },
    });
    client.on("error", () => {});
    client.end();
    await received;
    client.destroy();

    const metricsAddress = metricsServer.address();
    assert.ok(metricsAddress && typeof metricsAddress !== "string");
    const metricsUrl = `http://127.0.0.1:${metricsAddress.port}/metrics`;
    const abortedMetric =
      /greenguard_gateway_http_requests_total\{method="GET",route="\/api\/v1\/read\/search",status_code="aborted"\} 1/;
    let body = "";
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      body = await (await fetch(metricsUrl)).text();
      if (abortedMetric.test(body)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(body, abortedMetric);
    assert.match(
      body,
      /greenguard_gateway_http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/read\/search"\} 1/,
    );
    assert.doesNotMatch(
      body,
      /greenguard_gateway_http_requests_total\{method="GET",route="\/api\/v1\/read\/search",status_code="200"\}/,
    );
  } finally {
    await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("requires verified bearer on protected routes", async () => {
  assert.equal((await fetch(base + "/graphql")).status, 401);
  assert.equal(
    (
      await fetch(base + "/graphql", {
        headers: { authorization: "Bearer bad" },
      })
    ).status,
    401,
  );
});

test("forwards original bearer and strips spoofed tenant header", async () => {
  const result = await req("/api/v1/read/search?q=grain", {
    headers: { "x-tenant-id": tenantB },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    service: "read",
    path: "/api/v1/read/search?q=grain",
    authorization: "Bearer good",
  });
});

test("forwards caller trace context to the GraphQL BFF", async () => {
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";
  const response = await req("/graphql", { headers: { traceparent } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).traceparent, traceparent);
});

test("routes BFF and saga via explicit method/path allowlist", async () => {
  assert.equal(
    (
      (await (
        await req("/graphql", { method: "POST", body: "{}" })
      ).json()) as { service: string }
    ).service,
    "bff",
  );
  assert.equal(
    (
      (await (
        await req("/v1/provisioning", { method: "POST", body: "{}" })
      ).json()) as { service: string }
    ).service,
    "saga",
  );
  assert.equal(
    (await req("/api/v1/read/search", { method: "POST" })).status,
    404,
  );
  assert.equal((await req("/anything-else")).status, 404);
});

test("Assistant APIs route only through the authenticated BFF allowlist", async () => {
  const paths = [
    ["GET", "/v1/assistant/suggestions"],
    ["POST", "/v1/assistant/suggestions/grain_moisture/used"],
    ["GET", "/v1/assistant/conversations"],
    ["POST", "/v1/assistant/conversations"],
    ["GET", "/v1/assistant/conversations/33333333-3333-4333-8333-333333333333"],
    [
      "POST",
      "/v1/assistant/conversations/33333333-3333-4333-8333-333333333333/messages",
    ],
    [
      "DELETE",
      "/v1/assistant/conversations/33333333-3333-4333-8333-333333333333",
    ],
  ] as const;
  for (const [method, path] of paths) {
    const response = await req(path, { method });
    assert.equal(response.status, 200, `${method} ${path}`);
    const result = (await response.json()) as { service: string; path: string };
    assert.equal(result.service, "bff");
    assert.equal(result.path, path);
  }
  assert.equal(
    (await req("/v1/assistant/suggestions", { method: "POST" })).status,
    404,
  );
  assert.equal(
    (await req("/v1/assistant/conversations/not-a-uuid", { method: "GET" }))
      .status,
    404,
  );
  assert.equal(
    (
      await req(
        "/v1/assistant/conversations/33333333-3333-4333-8333-333333333333/messages",
        { method: "DELETE" },
      )
    ).status,
    404,
  );
});

test("blocks query identity, path normalization and oversized body", async () => {
  assert.equal((await req(`/graphql?tenant_id=${tenantB}`)).status, 400);
  assert.equal((await req("/graphql?access_token=bad")).status, 400);
  assert.equal(
    (await req("/graphql", { method: "POST", body: "12345678901234567" }))
      .status,
    413,
  );
  const traversalStatus = await new Promise<number>((resolve) => {
    const raw = httpRequest(
      base,
      {
        path: "/graphql/%2e%2e/graphql",
        headers: { authorization: "Bearer good" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    raw.end();
  });
  assert.equal(traversalStatus, 400);
});

test("WebSocket requires bearer and rejects token in query string", async () => {
  async function upgrade(
    path: string,
    authorization?: string,
    protocol?: string,
    origin?: string,
  ): Promise<string> {
    return new Promise((resolve) => {
      const url = new URL(base);
      const socket = connect(Number(url.port), url.hostname);
      let result = "";
      socket.setTimeout(2_000, () => {
        socket.destroy();
        resolve(result || "timeout");
      });
      socket.on("data", (chunk) => {
        result += chunk.toString();
        socket.destroy();
        resolve(result);
      });
      socket.on("connect", () =>
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: ${url.host}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            ...(authorization ? [`Authorization: ${authorization}`] : []),
            ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
            ...(origin ? [`Origin: ${origin}`] : []),
            "",
            "",
          ].join("\r\n"),
        ),
      );
      socket.on("error", () => resolve(result));
    });
  }
  assert.match(await upgrade("/graphql"), /^HTTP\/1\.1 401/);
  assert.match(
    await upgrade("/graphql?access_token=bad", "Bearer good"),
    /^HTTP\/1\.1 400/,
  );
  assert.match(
    await upgrade("/api/v1/read/search", "Bearer good"),
    /^HTTP\/1\.1 400/,
  );
  const accepted = await upgrade(
    "/graphql",
    "Bearer good",
    "graphql-transport-ws",
  );
  assert.match(accepted, /^HTTP\/1\.1 101/);
  assert.match(accepted, /Sec-WebSocket-Protocol: graphql-transport-ws/);
  const issued = await req("/api/v1/subscription-ticket", { method: "POST" });
  assert.equal(issued.status, 200);
  const { ticket, expiresIn } = (await issued.json()) as {
    ticket: string;
    expiresIn: number;
  };
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresIn, 30);
  const browserProtocol = `graphql-transport-ws, ticket.${ticket}`;
  assert.match(
    await upgrade("/graphql", undefined, browserProtocol),
    /^HTTP\/1\.1 101/,
  );
  assert.match(
    await upgrade("/graphql", undefined, browserProtocol),
    /^HTTP\/1\.1 401/,
  );
  assert.match(
    await upgrade(
      "/graphql",
      undefined,
      "graphql-transport-ws, ticket.invalid",
    ),
    /^HTTP\/1\.1 401/,
  );
  assert.equal(
    (await fetch(base + "/api/v1/subscription-ticket", { method: "POST" }))
      .status,
    401,
  );
  const originTicketResponse = await req("/api/v1/subscription-ticket", {
    method: "POST",
    headers: { Origin: "https://dashboard.example" },
  });
  const originTicket = (
    (await originTicketResponse.json()) as { ticket: string }
  ).ticket;
  assert.match(
    await upgrade(
      "/graphql",
      undefined,
      `graphql-transport-ws, ticket.${originTicket}`,
      "https://other.example",
    ),
    /^HTTP\/1\.1 401/,
  );
  for (let n = 0; n < 5; n++)
    assert.equal(
      (await req("/api/v1/subscription-ticket", { method: "POST" })).status,
      200,
    );
  assert.equal(
    (await req("/api/v1/subscription-ticket", { method: "POST" })).status,
    429,
  );
});

test("Advisor execution retains exact optimistic precondition through the authenticated edge", async () => {
  const upstream = createServer((request, response) => {
    assert.equal(request.headers["if-match"], '"2"');
    assert.equal(request.headers.authorization, "Bearer valid");
    response
      .writeHead(200, { etag: '"2"', "cache-control": "no-store" })
      .end("{}");
  });
  const origin = await listen(upstream);
  const edge = createGateway({
    verify: async (auth) => {
      assert.equal(auth, "Bearer valid");
      return principal;
    },
    bff: origin,
    read: origin,
    saga: origin,
  });
  const base = await listen(edge);
  try {
    const response = await fetch(
      new URL(
        "/v1/advisor/proposals/33333333-3333-4333-8333-333333333333/execution",
        base,
      ),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "If-Match": '"2"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 2, action_hash: "a".repeat(64) }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), '"2"');
  } finally {
    edge.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise<void>((r) => edge.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("PDF and Agent routes are closed method and UUID BFF paths", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  for (const [method, path] of [
    ["GET", "/v1/assistant/documents"],
    ["GET", `/v1/assistant/documents/${id}/versions/1`],
    ["GET", `/v1/assistant/documents/${id}/versions/2/source`],
    ["GET", `/v1/assistant/documents/${id}/versions/2/source-info`],
    ["DELETE", `/v1/assistant/documents/${id}`],
    ["POST", "/v1/assistant/summary-jobs"],
    ["GET", `/v1/assistant/summary-jobs/${id}`],
    ["DELETE", `/v1/assistant/summary-jobs/${id}`],
    ["POST", "/v1/assistant/agent"],
    ["GET", "/v1/advisor/proposals"],
    ["GET", `/v1/advisor/proposals/${id}`],
    ["POST", `/v1/advisor/proposals/${id}/decision`],
    ["POST", `/v1/advisor/proposals/${id}/execution`],
  ])
    assert.equal(
      (await req(path!, { method })).status,
      200,
      `${method} ${path}`,
    );
  for (const path of [
    `/v1/advisor/proposals/not-uuid/execution`,
    `/v1/assistant/documents/${id}/versions/2147483648/source`,
    `/v1/assistant/summary-jobs/not-uuid`,
    `/v1/assistant/agent/extra`,
  ])
    assert.equal((await req(path)).status, 404);
});

test("only exact PDF uploads receive the 25MiB body allowance", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const upload = `/v1/assistant/documents/${id}`;
  assert.equal(
    (
      await req(upload, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: "%PDF-" + "x".repeat(64),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await req(upload, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal(
    (await req("/v1/assistant/agent", { method: "POST", body: "x".repeat(64) }))
      .status,
    413,
  );
  const oversizedStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      base + upload,
      {
        method: "POST",
        headers: {
          authorization: "Bearer good",
          "content-type": "application/pdf",
          "content-length": String(25 * 1024 * 1024 + 1),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(oversizedStatus, 413);
});

test("only a valid selected-PDF summary gets a longer upstream budget after ordinary admission", async () => {
  const upstream = createServer((_request, response) => {
    setTimeout(() => response.end("ok"), 200);
  });
  const origin = await listen(upstream);
  const edge = createGateway({
    verify: async () => principal,
    bff: origin,
    read: origin,
    saga: origin,
    timeoutMs: 100,
    summaryTimeoutMs: 500,
  });
  const base = await listen(edge);
  const id = "33333333-3333-4333-8333-333333333333";
  const path = `/v1/assistant/conversations/${id}/messages`;
  const body = {
    question: "Summarize PDF",
    mode: "document_summary",
    document_id: id,
    document_version: 1,
  };
  const call = (target: string, payload: object) =>
    fetch(new URL(target, base), {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  try {
    assert.equal((await call(path, body)).status, 200);
    assert.equal((await call(path, { ...body, mode: "question" })).status, 504);
    assert.equal(
      (await call(path, { ...body, document_id: "bad" })).status,
      504,
    );
    assert.equal((await call("/graphql", body)).status, 504);
  } finally {
    edge.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise<void>((r) => edge.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("upload capacity is bounded until responses complete and releases afterward", async () => {
  const pending: import("node:http").ServerResponse[] = [];
  let twoArrived!: () => void;
  const two = new Promise<void>((r) => {
    twoArrived = r;
  });
  let allArrived!: () => void;
  const arrived = new Promise<void>((r) => {
    allArrived = r;
  });
  const upstream = createServer((_request, response) => {
    pending.push(response);
    if (pending.length === 2) twoArrived();
    if (pending.length === 4) allArrived();
  });
  const origin = await listen(upstream);
  const edge = createGateway({
    verify: async (authorization) => {
      if (!authorization?.startsWith("Bearer good:"))
        throw new AuthError(401, "invalid_token");
      return {
        ...principal,
        tenantId: authorization!.endsWith(":A") ? tenantA : tenantB,
      };
    },
    bff: origin,
    read: origin,
    saga: origin,
  });
  const base = await listen(edge);
  const path = "/v1/assistant/documents/33333333-3333-4333-8333-333333333333";
  const upload = (tenant = "A") =>
    fetch(new URL(path, base), {
      method: "POST",
      headers: {
        Authorization: `Bearer good:${tenant}`,
        "Content-Type": "application/pdf",
      },
      body: "%PDF-small",
    });
  try {
    const denied = await fetch(new URL(path, base), {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: "%PDF-small",
    });
    assert.equal(denied.status, 401);
    assert.equal(pending.length, 0);
    const first = [upload("A"), upload("A")];
    await two;
    assert.equal((await upload("A")).status, 503);
    assert.equal(pending.length, 2);
    first.push(upload("B"), upload("B"));
    await arrived;
    assert.equal((await upload()).status, 503);
    assert.equal(pending.length, 4);
    for (const response of pending) response.end("ok");
    assert.deepEqual(
      await Promise.all(first.map(async (response) => (await response).status)),
      [200, 200, 200, 200],
    );
    upstream.removeAllListeners("request");
    upstream.on("request", (_request, response) => response.end("ok"));
    assert.equal((await upload()).status, 200);
  } finally {
    for (const response of pending) response.end();
    edge.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise<void>((r) => edge.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
