import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import type { Db, Tx } from "../db/client.js";
import { identityIdOf } from "./ids.js";
import {
  AmbiguousMembershipError,
  MembershipLookupLimitError,
} from "./errors.js";
import { lookupMembership } from "./store.js";

const issuer = "https://membership-lookup-regression.test";

test("lookup discovers identity candidates then checks tenant scope in one repeatable snapshot", async () => {
  const tenant = randomUUID();
  const identity = identityIdOf(issuer, "snapshot");
  let queries = 0;
  const scopes: unknown[][] = [];
  const tx = {
    $executeRaw: async (_parts: TemplateStringsArray, ...values: unknown[]) => {
      scopes.push(values);
      return 1;
    },
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      queries++;
      if (queries === 1) {
        assert(!parts.join("").includes("organizations"));
        assert.deepEqual(values, [identity, 101]);
        return [{ tenant_id: tenant }];
      }
      assert(parts.join("").includes("JOIN organizations"));
      assert.deepEqual(values, [tenant, identity]);
      return [
        { tenant_id: tenant, role: "operator", state: "active", version: 7n },
      ];
    },
  } as unknown as Tx;
  const db = {
    $transaction: async (
      run: (tx: Tx) => Promise<unknown>,
      options: unknown,
    ) => {
      assert.deepEqual(options, { isolationLevel: "RepeatableRead" });
      return run(tx);
    },
  } as unknown as Db;
  assert.deepEqual(await lookupMembership(db, issuer, "snapshot"), {
    tenantId: tenant,
    roles: ["operator"],
    version: "7",
    state: "active",
  });
  assert.deepEqual(scopes, [["", identity], [tenant]]);
});

test("lookup rejects candidate overflow before any tenant check", async () => {
  let queried = false;
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => {
      assert.equal(
        queried,
        false,
        "overflow must never check an incomplete tenant subset",
      );
      queried = true;
      return Array.from({ length: 101 }, () => ({ tenant_id: randomUUID() }));
    },
  } as unknown as Tx;
  const db = {
    $transaction: async (run: (tx: Tx) => Promise<unknown>) => run(tx),
  } as unknown as Db;
  await assert.rejects(
    lookupMembership(db, issuer, "over-limit"),
    MembershipLookupLimitError,
  );
});

test(
  "real forced RLS membership lookup handles inactive candidates, ambiguity and revocation with rollback",
  {
    skip: !process.env.CONTROL_DATABASE_URL || !process.env.POSTGRES_ADMIN_URL,
  },
  async () => {
    const admin = new URL(process.env.POSTGRES_ADMIN_URL!);
    admin.pathname = new URL(process.env.CONTROL_DATABASE_URL!).pathname;
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    const subject = randomUUID(),
      identity = identityIdOf(issuer, subject);
    const tenants = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const query = async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.reduce(
        (text, part, index) => text + (index ? `$${index}` : "") + part,
        "",
      );
      return client.query(sql, values);
    };
    const tx = {
      $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
        (await query(parts, ...values)).rowCount,
      $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const result = await query(parts, ...values);
        return result.rows.map((row) => ({
          ...row,
          ...(row.version !== undefined
            ? { version: BigInt(row.version) }
            : {}),
        }));
      },
    } as unknown as Tx;
    const db = {
      $transaction: async (
        run: (tx: Tx) => Promise<unknown>,
        options: unknown,
      ) => {
        assert.deepEqual(options, { isolationLevel: "RepeatableRead" });
        return run(tx);
      },
    } as unknown as Db;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query(
        "INSERT INTO identities(identity_id,issuer,subject) VALUES($1,$2,$3)",
        [identity, issuer, subject],
      );
      for (let index = 0; index < tenants.length; index++) {
        await client.query(
          "INSERT INTO organizations(tenant_id,name,state,created_by) VALUES($1,'rollback-membership-lookup',$2,$3)",
          [
            tenants[index],
            index < 2 ? "provisioning" : index === 2 ? "active" : "suspended",
            identity,
          ],
        );
        await client.query(
          "INSERT INTO memberships(tenant_id,identity_id,role,state,version,granted_by,updated_at) VALUES($1,$2,'viewer','active',1,$2,now()+$3*interval '1 hour')",
          [tenants[index], identity, 10 - index],
        );
      }
      await client.query("SET LOCAL ROLE control_app");
      await client.query(
        "SELECT set_config('app.tenant_id','',true),set_config('app.identity_id',$1,true)",
        [identity],
      );
      assert.equal(
        (await client.query("SELECT tenant_id FROM organizations")).rows.length,
        0,
        "organization RLS must remain tenant only",
      );
      const result = await lookupMembership(db, issuer, subject);
      assert.deepEqual(result, {
        tenantId: tenants[2],
        roles: ["viewer"],
        version: "1",
        state: "active",
      });
      assert.equal(
        await lookupMembership(db, issuer, randomUUID()),
        null,
        "other verified identity cannot read candidate memberships",
      );
      const change = async (sql: string, values: unknown[]) => {
        await client.query("RESET ROLE");
        await client.query(sql, values);
        await client.query("SET LOCAL ROLE control_app");
      };
      await change(
        "UPDATE organizations SET state='active' WHERE tenant_id=$1",
        [tenants[3]],
      );
      await assert.rejects(
        lookupMembership(db, issuer, subject),
        AmbiguousMembershipError,
      );
      await change(
        "UPDATE organizations SET state='suspended' WHERE tenant_id=$1",
        [tenants[3]],
      );
      await change(
        "UPDATE memberships SET state='revoked',version=2,revoked_at=now(),revoked_by=$2 WHERE tenant_id=$1 AND identity_id=$2",
        [tenants[2], identity],
      );
      assert.deepEqual(await lookupMembership(db, issuer, subject), {
        tenantId: tenants[2],
        roles: [],
        version: "2",
        state: "revoked",
      });
      await change(
        "UPDATE organizations SET state='suspended' WHERE tenant_id=$1",
        [tenants[2]],
      );
      assert.equal(
        await lookupMembership(db, issuer, subject),
        null,
        "inactive organization cannot authenticate revoked or active membership",
      );
    } finally {
      try {
        await client.query("ROLLBACK");
        assert.equal(
          (
            await client.query(
              "SELECT identity_id FROM identities WHERE identity_id=$1",
              [identity],
            )
          ).rows.length,
          0,
          "rollback removes fixture identity and all tenant rows",
        );
      } finally {
        await client.end();
      }
    }
  },
);
