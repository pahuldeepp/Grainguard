import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { identityKey } from "@greenguard/membership-client";
import { createDb } from "../db/client.js";
import { identityIdOf } from "./ids.js";
import { lookupDelegatedMembership } from "./store.js";
import {
  ISSUER,
  createActiveTenantFixture,
  uniqueSubject,
} from "../testing/fixtures.js";

test(
  "stable delegated lookup preserves current tenant membership and denies foreign tenant",
  { skip: !process.env.CONTROL_DATABASE_URL },
  async () => {
    const db = createDb(process.env.CONTROL_DATABASE_URL!, 2);
    try {
      // Own fixture: a freshly seeded tenant stays provisioning until owner
      // bootstrap completes, so the test creates and activates its own tenant.
      const member = { issuer: ISSUER, subject: uniqueSubject("delegated") };
      const cmd = {
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      };
      const created = await createActiveTenantFixture(
        db,
        member,
        "Delegated lookup",
        cmd,
      );
      const tenantId = created.body.tenantId as string;
      const id = identityKey(member.issuer, member.subject);
      assert.equal(id, identityIdOf(member.issuer, member.subject));
      const allowed = await lookupDelegatedMembership(db, tenantId, id);
      assert.equal(allowed?.identityId, id);
      assert.equal(allowed?.state, "active");
      assert.deepEqual(allowed?.roles, ["admin"]);
      assert.equal(await lookupDelegatedMembership(db, randomUUID(), id), null);
      assert.equal(
        await lookupDelegatedMembership(db, tenantId, randomUUID()),
        null,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
