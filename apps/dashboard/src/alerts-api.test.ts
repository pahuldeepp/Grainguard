import { afterEach, expect, test, vi } from "vitest";
import { operations } from "../../../services/bff/src/query-policy";
import { AlertsApi } from "./alerts-api";
import { operationHash } from "./graphql-client";

afterEach(() => vi.unstubAllGlobals());

test("owner alert history uses the exact persisted BFF document and no tenant selector", async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({
          data: {
            alertHistory: {
              alertId: "a",
              items: [],
              nextCursor: null,
              complete: true,
              source: { status: "empty", reasonCode: null },
            },
            alertNotifications: {
              items: [],
              nextCursor: null,
              complete: true,
              sources: {
                intents: { status: "ok", reasonCode: null },
                warning: { status: "ok", reasonCode: null },
                critical: {
                  status: "not_configured",
                  reasonCode: "channel_unconfigured",
                },
                transitions: { status: "ok", reasonCode: null },
              },
            },
          },
        }),
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = new AlertsApi(async () => "token");
  await api.history("alert-a");
  await api.notifications("alert-a");
  const bodies = fetchMock.mock.calls.map((call) =>
    JSON.parse(call[1]?.body as string),
  );
  expect(
    bodies.map((body) => body.extensions.persistedQuery.sha256Hash),
  ).toEqual(
    await Promise.all(
      [operations.alertHistory, operations.alertNotifications].map(
        operationHash,
      ),
    ),
  );
  expect(bodies.map((body) => body.variables)).toEqual([
    { id: "alert-a", limit: 50 },
    { id: "alert-a", limit: 50 },
  ]);
  expect(bodies[0].variables).not.toHaveProperty("tenantId");
  expect(bodies[1]).not.toHaveProperty("query");
});
