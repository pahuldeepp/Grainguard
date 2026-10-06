import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import { TenantGuard, type Verifier } from "./auth.js";
import { alertsDelegation } from "./delegation.js";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: "user" })).toString("base64url")}.x`;
function context(method: string, url: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: token }, method, url }),
      getResponse: () => ({ setHeader: () => {} }),
    }),
  } as unknown as ExecutionContext;
}
function guard(scope: string) {
  return new TenantGuard({
    verify: async () => ({
      issuer: "https://delegation.test",
      subject: "22222222-2222-4222-8222-222222222222",
      tenantId: "11111111-1111-4111-8111-111111111111",
      roles: ["operator"],
      expiresAt: new Date(Date.now() + 60000),
      scopes: [scope],
    }),
  } as Verifier);
}
test("read delegation cannot acknowledge or modify rules", async () => {
  const read = guard("alerts:read");
  assert.equal(
    await read.canActivate(
      context("GET", "/v1/alerts/33333333-3333-4333-8333-333333333333"),
    ),
    true,
  );
  await assert.rejects(
    read.canActivate(
      context(
        "POST",
        "/v1/alerts/33333333-3333-4333-8333-333333333333/acknowledge",
      ),
    ),
    /insufficient_role/,
  );
  await assert.rejects(
    read.canActivate(context("GET", "/v1/alert-rules")),
    /insufficient_role/,
  );
});
test("acknowledge delegation is limited to owning acknowledgement route", async () => {
  const write = guard("alerts:acknowledge");
  assert.equal(
    await write.canActivate(
      context(
        "POST",
        "/v1/alerts/33333333-3333-4333-8333-333333333333/acknowledge",
      ),
    ),
    true,
  );
  await assert.rejects(
    write.canActivate(context("GET", "/v1/alerts")),
    /insufficient_role/,
  );
});
test("partial delegation configuration fails closed", () => {
  assert.equal(alertsDelegation({}), undefined);
  assert.throws(
    () => alertsDelegation({ DELEGATED_ISSUER: "https://delegation.test" }),
    /requires/,
  );
});
