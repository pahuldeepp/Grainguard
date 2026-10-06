import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { identityKey } from "@greenguard/membership-client";
import { createDb } from "../db/client.js";
import { lookupDelegatedMembership } from "./store.js";

test(
  "stable delegated lookup preserves current tenant membership and denies foreign tenant",
  { skip: !process.env.CONTROL_DATABASE_URL },
  async () => {
    const db = createDb(process.env.CONTROL_DATABASE_URL!, 2);
    try {
      const member = JSON.parse(
        readFileSync(
          new URL("../../../../infra/oidc/memberships.json", import.meta.url),
          "utf8",
        ),
      )[0] as { issuer: string; subject: string; tenantId: string };
      const id = identityKey(member.issuer, member.subject);
      const allowed = await lookupDelegatedMembership(db, member.tenantId, id);
      assert.equal(allowed?.identityId, id);
      assert.equal(allowed?.state, "active");
      assert.deepEqual(allowed?.roles, ["admin"]);
      assert.equal(await lookupDelegatedMembership(db, randomUUID(), id), null);
      assert.equal(
        await lookupDelegatedMembership(db, member.tenantId, randomUUID()),
        null,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
