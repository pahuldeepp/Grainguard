import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AlertPrincipal } from "./auth.js";
import { HistoryCursor, historyPage, ruleIds } from "./history.js";
import { IdentityDisplay } from "./identity.js";
import { createAlertsApp } from "../app.js";
import type { Db } from "../db/client.js";
const tenantId = "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d";
const alertId = "5f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d";
const key = "owner-test-secret-at-least-32-bytes";
const principal = {
  tenantId,
  issuer: "https://a.test",
  subject: "raw-secret-subject",
} as AlertPrincipal;

test("issuer-aware keyed identity, legacy/system handling and audit purpose separation", () => {
  const identity = new IdentityDisplay(key);
  const self = identity.actor(
    principal,
    "user",
    principal.subject,
    principal.issuer,
  );
  assert.equal(self.isYou, true);
  const otherIssuer = identity.actor(
    principal,
    "user",
    principal.subject,
    "https://b.test",
  );
  assert.equal(otherIssuer.isYou, false);
  assert.notEqual(self.handle, otherIssuer.handle);
  assert.notEqual(
    self.handle,
    identity.actor(
      { ...principal, tenantId: alertId },
      "user",
      principal.subject,
      principal.issuer,
    ).handle,
  );
  assert.deepEqual(identity.actor(principal, "user", principal.subject), {
    kind: "user",
    isYou: false,
    handle: null,
  });
  assert.deepEqual(
    identity.actor(principal, "system", "workflow-alerts", principal.issuer),
    { kind: "system", isYou: false, handle: null },
  );
  const audit = identity.audit(tenantId, principal.issuer, principal.subject);
  assert.equal(audit.length, 64);
  assert.notEqual(audit.slice(0, 12), self.handle);
  assert.notEqual(
    audit,
    createHash("sha256").update(principal.subject).digest("hex"),
  );
  assert.ok(!JSON.stringify([self, otherIssuer]).includes(principal.subject));
  assert.throws(() => new IdentityDisplay(""));
});

test("history cursor authenticates all bindings and rejects malformed inputs", () => {
  const codec = new HistoryCursor(key);
  const position = {
    version: "2",
    occurredAt: "2026-09-26T12:00:00.123456Z",
    transitionId: alertId,
  };
  const cursor = codec.encode(tenantId, alertId, "lifecycle", position);
  assert.deepEqual(
    codec.decode(cursor, tenantId, alertId, "lifecycle"),
    position,
  );
  for (const value of [
    "",
    "bad",
    "x".repeat(2049),
    cursor.replace(/^./, cursor[0] === "A" ? "B" : "A"),
  ])
    assert.throws(() => codec.decode(value, tenantId, alertId, "lifecycle"));
  assert.throws(() => codec.decode(cursor, alertId, alertId, "lifecycle"));
  assert.throws(() => codec.decode(cursor, tenantId, tenantId, "lifecycle"));
  assert.throws(() => codec.decode(cursor, tenantId, alertId, "all"));
  for (const positionBad of [
    { ...position, version: "9223372036854775808" },
    { ...position, occurredAt: "bad" },
    { ...position, transitionId: "bad" },
  ])
    assert.throws(() =>
      codec.decode(
        codec.encode(tenantId, alertId, "all", positionBad),
        tenantId,
        alertId,
        "all",
      ),
    );
  assert.throws(() => new HistoryCursor(""));
});

test("rule and history requests are bounded", () => {
  assert.deepEqual(ruleIds(`${tenantId},${tenantId}`), [tenantId]);
  for (const value of [
    undefined,
    "",
    "bad",
    Array(51).fill(tenantId).join(","),
  ])
    assert.throws(() => ruleIds(value));
  assert.deepEqual(historyPage(), { limit: 50, include: "lifecycle" });
  for (const limit of ["0", "101", "1.0", "1e1", "-1", ""])
    assert.throws(() => historyPage(limit));
  assert.throws(() => historyPage("1", "diagnostics"));
});

test("authenticated owner fails startup without both display and cursor keys", async () => {
  const options = { db: {} as Db, verifier: { verify: async () => principal } };
  await assert.rejects(createAlertsApp(options), /ALERTS_ACTOR_HMAC_KEY/);
  await assert.rejects(
    createAlertsApp({ ...options, actorHmacKey: key }),
    /ALERTS_HISTORY_CURSOR_KEY/,
  );
});

// SQL must never start for rejected cursors, and a missing episode must stop the read.
test("invalid cursor rejects before transaction; foreign episode stops before page and coverage", async () => {
  const { AlertsController } = await import("./alerts.controller.js");
  let queries = 0,
    transactions = 0;
  const db = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      return work({
        $executeRaw: async () => 0,
        $queryRaw: async () => {
          queries++;
          return [];
        },
      });
    },
  } as unknown as Db;
  const controller = new AlertsController(
    db,
    new IdentityDisplay(key),
    new HistoryCursor(key),
  );
  const req = {
    principal: { ...principal, roles: ["viewer"] },
    headers: {},
  } as import("./auth.js").AlertRequest;
  await assert.rejects(controller.transitions(req, alertId, "1", "bad"));
  assert.equal(transactions, 0);
  await assert.rejects(controller.transitions(req, alertId));
  assert.equal(transactions, 1);
  assert.equal(queries, 1);
});

test("verified but unparseable bearer claims become 401 instead of 500", async () => {
  const { TenantGuard } = await import("./auth.js");
  const { AuthError } = await import("@greenguard/tenant-auth");
  const guard = new TenantGuard({ verify: async () => principal });
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: "Bearer opaque" } }),
    }),
  } as unknown as import("@nestjs/common").ExecutionContext;
  await assert.rejects(
    guard.canActivate(context),
    (error) => error instanceof AuthError && error.status === 401,
  );
});
