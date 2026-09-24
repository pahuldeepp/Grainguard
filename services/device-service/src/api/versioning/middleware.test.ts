import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createApiVersionMiddleware,
  type ApiVersionRequest,
  type VersionRegistry,
} from "./index.js";

const registry: VersionRegistry = {
  defaultVersion: "2",
  versions: [
    {
      version: "1",
      deprecatedAt: new Date("2026-01-01T00:00:00Z"),
      sunsetAt: new Date("2026-06-01T00:00:00Z"),
      successor: "2",
      documentationUrl: "https://docs.example.com/v1",
    },
    { version: "2" },
    { version: "3", deprecatedAt: new Date("2026-02-01T00:00:00Z") },
    { version: "4", sunsetAt: new Date("2026-08-01T00:00:00Z") },
    { version: "5", sunsetAt: new Date("2026-01-01T00:00:00Z") },
  ],
};

async function call(
  clock: string,
  headers: Record<string, string> = {},
  preset: Record<string, string> = {},
) {
  const middleware = createApiVersionMiddleware(
    registry,
    () => new Date(clock),
  );
  const server: Server = createServer((req, res) => {
    for (const [k, v] of Object.entries(preset)) res.setHeader(k, v);
    middleware(req, res, () => {
      const seen = (req as ApiVersionRequest).apiVersion;
      res.end(
        JSON.stringify({
          next: true,
          version: seen?.version,
          state: seen?.state,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers });
    return {
      response,
      body: JSON.parse(await response.text()) as Record<string, unknown>,
    };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("defaults when header absent", async () => {
  const { response, body } = await call("2026-03-01T00:00:00Z");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("API-Version"), "2");
  assert.equal(response.headers.get("Vary"), "API-Version");
  assert.equal(response.headers.get("Deprecation"), null);
  assert.equal(response.headers.get("Sunset"), null);
  assert.deepEqual(body, { next: true, version: "2", state: "current" });
});

test("explicit supported version with padding", async () => {
  const { response, body } = await call("2026-03-01T00:00:00Z", {
    "API-Version": " 2 ",
  });
  assert.equal(response.headers.get("API-Version"), "2");
  assert.equal(body.version, "2");
});

test("deprecated version sets all headers and appends Vary and Link", async () => {
  const { response, body } = await call(
    "2026-03-01T00:00:00Z",
    { "API-Version": "1" },
    { Vary: "Accept-Encoding", Link: '<https://x.example/a>; rel="next"' },
  );
  assert.equal(response.status, 200);
  assert.equal(body.state, "deprecated");
  assert.equal(response.headers.get("API-Version"), "1");
  assert.equal(response.headers.get("Vary"), "Accept-Encoding, API-Version");
  assert.equal(
    response.headers.get("Deprecation"),
    `@${Date.parse("2026-01-01T00:00:00Z") / 1000}`,
  );
  assert.equal(response.headers.get("Sunset"), "Mon, 01 Jun 2026 00:00:00 GMT");
  assert.equal(
    response.headers.get("Link"),
    '<https://x.example/a>; rel="next", <urn:api-version:2>; rel="successor-version", <https://docs.example.com/v1>; rel="deprecation"',
  );
});

test("deprecated without sunset omits Sunset, Link", async () => {
  const { response } = await call("2026-03-01T00:00:00Z", {
    "API-Version": "3",
  });
  assert.equal(
    response.headers.get("Deprecation"),
    `@${Date.parse("2026-02-01T00:00:00Z") / 1000}`,
  );
  assert.equal(response.headers.get("Sunset"), null);
  assert.equal(response.headers.get("Link"), null);
});

test("sunset without deprecatedAt is implicitly deprecated", async () => {
  const { response, body } = await call("2026-03-01T00:00:00Z", {
    "API-Version": "4",
  });
  assert.equal(body.state, "deprecated");
  assert.equal(response.headers.get("Deprecation"), null);
  assert.equal(response.headers.get("Sunset"), "Sat, 01 Aug 2026 00:00:00 GMT");
});

test("boundary: now equals deprecatedAt is deprecated, before is current", async () => {
  const at = await call("2026-02-01T00:00:00Z", { "API-Version": "3" });
  assert.equal(at.body.state, "deprecated");
  const before = await call("2026-01-31T23:59:59Z", { "API-Version": "3" });
  assert.equal(before.body.state, "current");
  assert.equal(before.response.headers.get("Deprecation"), null);
});

test("boundary: now equals sunsetAt is 410 and one second earlier is 200", async () => {
  const gone = await call("2026-06-01T00:00:00Z", { "API-Version": "1" });
  assert.equal(gone.response.status, 410);
  assert.equal(
    gone.response.headers.get("content-type"),
    "application/problem+json",
  );
  assert.equal(
    gone.response.headers.get("Sunset"),
    "Mon, 01 Jun 2026 00:00:00 GMT",
  );
  assert.equal(gone.response.headers.get("Vary"), "API-Version");
  assert.deepEqual(gone.body, {
    type: "about:blank",
    title: "API version sunset",
    code: "api_version_sunset",
    detail: "API version 1 is no longer available.",
    version: "1",
    sunset: "2026-06-01T00:00:00.000Z",
    successor: "2",
    status: 410,
  });
  const alive = await call("2026-05-31T23:59:59Z", { "API-Version": "1" });
  assert.equal(alive.response.status, 200);
});

test("sunset without successor omits successor field", async () => {
  const { response, body } = await call("2026-03-01T00:00:00Z", {
    "API-Version": "5",
  });
  assert.equal(response.status, 410);
  assert.equal("successor" in body, false);
});

test("unsupported versions return 400 with the non-sunset list", async () => {
  const bad = ["", "  ", "9", "x".repeat(33), "1 2", "v/1", "é"];
  for (const value of bad) {
    const encoded = value === "é" ? "é" : value;
    const { response, body } = await call("2026-06-15T00:00:00Z", {
      "API-Version": encoded,
    });
    assert.equal(response.status, 400, `value ${JSON.stringify(value)}`);
    assert.equal(
      response.headers.get("content-type"),
      "application/problem+json",
    );
    assert.equal(response.headers.get("Vary"), "API-Version");
    assert.equal(response.headers.get("API-Version"), null);
    assert.equal(body.title, "Unsupported API version");
    assert.equal(body.status, 400);
    assert.equal(body.type, "about:blank");
    assert.deepEqual(body.supported, ["2", "3", "4"]);
  }
});

test("long invalid value is truncated to 64 chars in the body", async () => {
  const { body } = await call("2026-03-01T00:00:00Z", {
    "API-Version": "y".repeat(200),
  });
  assert.equal(body.requested, "y".repeat(64));
});

test("header injection value is unsupported and never reflected in headers", async () => {
  const middleware = createApiVersionMiddleware(
    registry,
    () => new Date("2026-03-01T00:00:00Z"),
  );
  const headers = new Map<string, unknown>();
  let ended = "";
  const res = {
    statusCode: 200,
    getHeader: (k: string) => headers.get(k),
    setHeader: (k: string, v: unknown) => headers.set(k, v),
    end: (s: string) => {
      ended = s;
    },
  } as unknown as ServerResponse;
  const req = {
    headers: { "api-version": "1\r\nSet-Cookie: pwn=1" },
  } as unknown as ApiVersionRequest;
  middleware(req, res, () => assert.fail("must not call next"));
  assert.equal(res.statusCode, 400);
  assert.equal(headers.has("API-Version"), false);
  for (const value of headers.values())
    assert.doesNotMatch(String(value), /pwn|Set-Cookie/);
  assert.equal(
    (JSON.parse(ended) as { requested: string }).requested,
    "1\r\nSet-Cookie: pwn=1",
  );
});

test("array header values are joined and rejected; default clock works", async () => {
  const middleware = createApiVersionMiddleware(registry);
  const headers = new Map<string, unknown>();
  const res = {
    statusCode: 200,
    getHeader: (k: string) => headers.get(k),
    setHeader: (k: string, v: unknown) => headers.set(k, v),
    end: () => undefined,
  } as unknown as ServerResponse;
  const req = {
    headers: { "api-version": ["2", "3"] },
  } as unknown as ApiVersionRequest;
  let called = false;
  middleware(req, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 400);

  const ok = { headers: {} } as unknown as ApiVersionRequest;
  middleware(ok, { ...res, statusCode: 200 } as ServerResponse, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(ok.apiVersion?.version, "2");
});
