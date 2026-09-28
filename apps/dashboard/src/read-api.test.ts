import { afterEach, expect, test, vi } from "vitest";
import { operations } from "../../../services/bff/src/query-policy";
import { ReadApi, readOperations } from "./read-api";
import { operationHash } from "./graphql-client";

afterEach(() => vi.unstubAllGlobals());

test("dashboard read operations match the BFF persisted-query allowlist", () => {
  for (const [name, query] of Object.entries(readOperations))
    expect(query).toBe(operations[name as keyof typeof operations]);
});

test("bin latest and trend requests use the byte-identical BFF operations", async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({
          data: { binReadingsLatest: null, binReadingsTrend: { buckets: [] } },
        }),
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = new ReadApi(async () => "token");
  await api.binLatest("bin-a");
  await api.binTrend("bin-a", "H6");
  const bodies = fetchMock.mock.calls.map(([, init]) =>
    JSON.parse(init?.body as string),
  );
  expect(
    bodies.map((body) => body.extensions.persistedQuery.sha256Hash),
  ).toEqual(
    await Promise.all(
      [operations.binReadingsLatest, operations.binReadingsTrend].map(
        operationHash,
      ),
    ),
  );
  expect(bodies.map((body) => body.variables)).toEqual([
    { binId: "bin-a" },
    { binId: "bin-a", window: "H6", resolution: "AUTO" },
  ]);
});

test("read queries use the scoped GraphQL BFF with a fresh token and no tenant variable", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { searchDevices: [] } }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = new ReadApi(async () => "session-token");
  expect(await api.search("grain", 25)).toEqual([]);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("/graphql");
  expect(init.headers).toMatchObject({ Authorization: "Bearer session-token" });
  const body = JSON.parse(init.body as string);
  expect(body.variables).toEqual({ query: "grain", limit: 25 });
  expect(body.variables).not.toHaveProperty("tenantId");
  expect(body).not.toHaveProperty("query");
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(readOperations.deviceSearch),
  );
  expect(body.extensions.persistedQuery.sha256Hash).toBe(
    Array.from(new Uint8Array(bytes), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join(""),
  );
});

test("missing token prevents a network request", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    new ReadApi(async () => null).current("device-1"),
  ).rejects.toThrow("Sign in");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("GraphQL authorization failures surface without displaying another tenant's data", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [
              { message: "forbidden", extensions: { code: "FORBIDDEN" } },
            ],
          }),
          { status: 200 },
        ),
    ),
  );
  await expect(
    new ReadApi(async () => "token").history(
      "device-1",
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      100,
    ),
  ).rejects.toThrow("FORBIDDEN");
});
