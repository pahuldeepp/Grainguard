import { afterEach, expect, test, vi } from "vitest";
import { operations } from "../../../services/bff/src/query-policy";
import { ReadApi, readOperations } from "./read-api";

afterEach(() => vi.unstubAllGlobals());

test("dashboard read operations match the BFF persisted-query allowlist", () => {
  for (const [name, query] of Object.entries(readOperations))
    expect(query).toBe(operations[name as keyof typeof operations]);
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
