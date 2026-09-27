import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import {
  NotificationClient,
  NotificationUpstreamError,
} from "./notifications.js";

const principal: Principal = {
  subject: "alice",
  tenantId: "22222222-2222-4222-8222-222222222222",
  roles: ["operator"],
  expiresAt: new Date(Date.now() + 60_000),
};
const alertId = "11111111-1111-4111-8111-111111111111";
const intentId = "33333333-3333-4333-8333-333333333333";

test("notification history composes owner APIs, binds alert and intent generation, and keeps critical explicitly unconfigured", async () => {
  const calls: Array<{
    url: URL;
    method: string;
    authorization: string;
    body?: string;
  }> = [];
  const client = new NotificationClient(
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    async (input, init) => {
      const url = new URL(input.toString());
      calls.push({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: init?.body as string | undefined,
      });
      return url.hostname === "127.0.0.1" && url.port === "3001"
        ? Response.json({
            items: [
              {
                intentId,
                transitionVersion: "8",
                transition: "alert.opened",
                severity: "warning",
                channel: "email",
                deliveryGeneration: 2,
                state: "dispatched",
                dispatchAttempts: 1,
              },
            ],
            nextCursor: "signed.jobs.cursor",
          })
        : Response.json({
            items: [
              {
                intentId,
                deliveryGeneration: 2,
                state: "accepted",
                providerAttempts: 1,
                events: [
                  {
                    kind: "send",
                    outcome: "accepted",
                    recordedAt: "2026-09-26T00:00:00Z",
                  },
                ],
              },
            ],
          });
    },
  );
  const result = await client.history(principal, "Bearer caller", alertId, 20);
  assert.equal(result.items[0]?.state, "accepted");
  assert.equal(result.items[0]?.intentId, intentId);
  assert.equal(result.sources.critical.status, "not_configured");
  assert.equal(result.complete, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url.searchParams.get("alertId"), alertId);
  assert.equal(calls[0]?.authorization, "Bearer caller");
  assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
    pairs: [{ intentId, deliveryGeneration: 2 }],
  });
});

test("notification history retains owner intents with explicit partial delivery coverage", async () => {
  const client = new NotificationClient(
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    async (input) => {
      if (new URL(input.toString()).port === "3001")
        return Response.json({
          items: [
            {
              intentId,
              deliveryGeneration: 0,
              transitionVersion: "1",
              transition: "alert.opened",
              channel: "email",
              state: "dispatched",
            },
          ],
          nextCursor: null,
        });
      return Response.json(
        { error: "owner_read_unavailable" },
        { status: 503 },
      );
    },
  );
  const result = await client.history(principal, "Bearer caller", alertId, 20);
  assert.equal(result.items[0]?.state, "dispatched");
  assert.equal(result.sources.warning.status, "partial");
  assert.equal(result.complete, false);
  assert.equal(result.nextCursor, null);
});

test("notification history maps owner network failures to a controlled unavailable result", async () => {
  const client = new NotificationClient(
    "http://127.0.0.1:3001",
    undefined,
    async () => {
      throw new Error("socket timeout");
    },
  );
  const result = await client.history(principal, "Bearer caller", alertId, 20);
  assert.deepEqual(result.items, []);
  assert.equal(result.nextCursor, null);
  assert.equal(result.sources.intents.status, "unavailable");
  assert.equal(result.sources.intents.reasonCode, "owner_unavailable");
});

test("notification history drops malformed intents and reports partial coverage", async () => {
  const client = new NotificationClient(
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    async (input) =>
      new URL(input.toString()).port === "3001"
        ? Response.json({
            items: [
              {
                intentId,
                deliveryGeneration: 1,
                transitionVersion: "1",
                transition: "alert.opened",
                channel: "email",
                state: "queued",
              },
              { intentId: 42, deliveryGeneration: "bad", state: "invalid" },
              {
                intentId: "44444444-4444-4444-8444-444444444444",
                deliveryGeneration: 2,
                state: "queued",
              },
            ],
            nextCursor: null,
          })
        : Response.json({ items: [] }),
  );
  const result = await client.history(principal, "Bearer caller", alertId, 20);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.intentId, intentId);
  assert.equal(result.sources.warning.status, "partial");
});

test("notification history rejects viewer access and malformed owner pages", async () => {
  const client = new NotificationClient("http://127.0.0.1:3001");
  await assert.rejects(
    client.history(
      { ...principal, roles: ["viewer"] },
      "Bearer caller",
      alertId,
      20,
    ),
    /insufficient_role/,
  );
  await assert.rejects(
    client.history(principal, "Bearer caller", "bad", 20),
    (error: unknown) =>
      error instanceof NotificationUpstreamError &&
      error.code === "invalid_notification_page",
  );
});
