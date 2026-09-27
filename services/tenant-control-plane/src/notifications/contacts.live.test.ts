import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createControlPlaneApp } from "../app.js";
import { identityIdOf } from "../domain/ids.js";
import { LOOKUP_TOKEN, startApi } from "../testing/api.js";
import {
  adminQuery,
  asRuntime,
  outboxEvents,
  runtimeDb,
} from "../testing/fixtures.js";

let api: Awaited<ReturnType<typeof startApi>>;
before(async () => {
  api = await startApi();
});
after(async () => api?.close());

async function org(label: string) {
  const person = await api.person(label);
  const result = await api.call("POST", "/v1/organizations", {
    token: person.token,
    body: { name: label },
    headers: { "idempotency-key": randomUUID() },
  });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return { tenantId: result.json.tenantId as string, ...person };
}
const path = (tenantId: string) =>
  `/v1/organizations/${tenantId}/notification-contacts`;
const internal = (tenantId: string) =>
  `/v1/internal/notification-contacts/${tenantId}`;
const contacts = {
  email: "private-alert-recipient@example.test",
  sms: "+12045550123",
};
const headers = (version: string) => ({ "if-match": `"${version}"` });

test("contact API requires admin identity for writes and lookup token for internal reads", async () => {
  const a = await org("contacts-auth");
  const b = await org("contacts-other");
  for (const token of [undefined, "invalid", LOOKUP_TOKEN])
    assert.equal(
      (
        await api.call("PUT", path(a.tenantId), {
          token,
          body: contacts,
          headers: headers("0"),
        })
      ).status,
      401,
    );
  const spoof = await api.person("contacts-spoof", {
    tenant_id: a.tenantId,
    roles: ["admin"],
  });
  for (const token of [b.token, spoof.token])
    assert.equal(
      (
        await api.call("PUT", path(a.tenantId), {
          token,
          body: contacts,
          headers: { ...headers("0"), "x-tenant-id": a.tenantId },
        })
      ).status,
      404,
    );
  for (const role of ["viewer", "operator"]) {
    const member = await api.person(`contacts-${role}`);
    const invite = await api.call(
      "POST",
      `/v1/organizations/${a.tenantId}/invitations`,
      {
        token: a.token,
        body: { email: `${member.subject}@example.test`, role },
        headers: { "idempotency-key": randomUUID() },
      },
    );
    assert.equal(invite.status, 201);
    assert.equal(
      (
        await api.call("POST", "/v1/invitations/accept", {
          token: member.token,
          body: { token: invite.json.token },
          headers: { "idempotency-key": randomUUID() },
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await api.call("PUT", path(a.tenantId), {
          token: member.token,
          body: contacts,
          headers: headers("0"),
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (await api.call("GET", internal(a.tenantId), { token: LOOKUP_TOKEN }))
      .status,
    404,
  );
  const created = await api.call("PUT", path(a.tenantId), {
    token: a.token,
    body: contacts,
    headers: { ...headers("0"), "x-tenant-id": b.tenantId },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.deepEqual(created.json, { ...contacts, version: "1" });
  assert.equal(created.headers.get("etag"), '"1"');
  for (const token of [undefined, "wrong", a.token])
    assert.equal(
      (await api.call("GET", internal(a.tenantId), { token })).status,
      401,
    );
  const read = await api.call("GET", internal(a.tenantId), {
    token: LOOKUP_TOKEN,
  });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, created.json);
  assert.equal(
    (await api.call("GET", internal(b.tenantId), { token: LOOKUP_TOKEN }))
      .status,
    404,
  );
  assert.equal(
    (await api.call("GET", internal(randomUUID()), { token: LOOKUP_TOKEN }))
      .status,
    404,
  );
  const [stored] = await adminQuery<{ updated_by: string }>(
    "SELECT updated_by FROM notification_contacts WHERE tenant_id = $1",
    [a.tenantId],
  );
  assert.equal(stored?.updated_by, identityIdOf(api.issuer.issuer, a.subject));
});

test("contact versions prevent stale updates and concurrent creation or replacement", async () => {
  const a = await org("contacts-version");
  const write = (version: string, body: unknown = contacts) =>
    api.call("PUT", path(a.tenantId), {
      token: a.token,
      body,
      headers: headers(version),
    });
  const raced = await Promise.all([write("0"), write("0")]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 412]);
  assert.equal(raced.find((r) => r.status === 412)?.headers.get("etag"), '"1"');
  const updates = await Promise.all([
    write("1", { email: "next@example.test" }),
    write("1", { sms: "+12045550124" }),
  ]);
  assert.deepEqual(updates.map((r) => r.status).sort(), [200, 412]);
  const winner = updates.find((r) => r.status === 200)!;
  assert.equal(winner.json.version, "2");
  assert.equal(winner.headers.get("etag"), '"2"');
  assert.deepEqual(
    (await api.call("GET", internal(a.tenantId), { token: LOOKUP_TOKEN })).json,
    winner.json,
  );
  assert.equal((await write("0")).status, 412);
});

test("contact validation returns safe errors and updates create no recipient-bearing events", async () => {
  const a = await org("contacts-validation");
  const before = await outboxEvents(a.tenantId);
  for (const version of [
    undefined,
    "0",
    'W/"0"',
    '"01"',
    '"9999999999999999999"',
  ]) {
    const result = await api.call("PUT", path(a.tenantId), {
      token: a.token,
      body: contacts,
      headers: version ? { "if-match": version } : {},
    });
    assert.equal(result.status, 400, JSON.stringify(result.json));
    assert.ok(!JSON.stringify(result.json).includes(contacts.email));
  }
  for (const body of [
    {},
    { email: contacts.email, tenantId: a.tenantId },
    { email: contacts.email + "\r\nBcc: attacker@example.test" },
    { sms: "2045550123" },
  ]) {
    const result = await api.call("PUT", path(a.tenantId), {
      token: a.token,
      body,
      headers: headers("0"),
    });
    assert.equal(result.status, 400);
    assert.ok(!JSON.stringify(result.json).includes(contacts.email));
  }
  for (const badTenant of [
    "bad-tenant",
    "00000000-0000-4000-8000-000000000001",
  ]) {
    assert.equal(
      (
        await api.call("PUT", path(badTenant), {
          token: a.token,
          body: contacts,
          headers: headers("0"),
        })
      ).status,
      400,
    );
    assert.equal(
      (await api.call("GET", internal(badTenant), { token: LOOKUP_TOKEN }))
        .status,
      400,
    );
  }
  assert.equal(
    (
      await api.call("PUT", path(a.tenantId), {
        token: a.token,
        body: contacts,
        headers: headers("0"),
      })
    ).status,
    200,
  );
  assert.deepEqual(await outboxEvents(a.tenantId), before);
});

test("notification contact forced RLS denies cross-tenant reads, writes and unscoped reads", async () => {
  const a = await org("contacts-rls-a");
  const b = await org("contacts-rls-b");
  assert.equal(
    (
      await api.call("PUT", path(a.tenantId), {
        token: a.token,
        body: contacts,
        headers: headers("0"),
      })
    ).status,
    200,
  );
  for (const scope of [{}, { "app.tenant_id": b.tenantId }] as Record<
    string,
    string
  >[]) {
    assert.equal(
      (
        await asRuntime(
          scope,
          "SELECT email_to FROM notification_contacts WHERE tenant_id=$1",
          [a.tenantId],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await asRuntime(
          scope,
          "UPDATE notification_contacts SET email_to='attacker@example.test' WHERE tenant_id=$1",
          [a.tenantId],
        )
      ).rowCount,
      0,
    );
  }
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": b.tenantId },
      "INSERT INTO notification_contacts (tenant_id,email_to,updated_by) VALUES ($1,'attacker@example.test',$2)",
      [a.tenantId, identityIdOf(api.issuer.issuer, b.subject)],
    ),
    /row-level security/,
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": a.tenantId },
      "UPDATE notification_contacts SET tenant_id=$1",
      [b.tenantId],
    ),
    /permission denied/,
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": a.tenantId },
      "DELETE FROM notification_contacts",
    ),
    /permission denied/,
  );
  const [security] = await adminQuery<{ forced: boolean; enabled: boolean }>(
    "SELECT relforcerowsecurity AS forced, relrowsecurity AS enabled FROM pg_class WHERE oid='notification_contacts'::regclass",
  );
  assert.deepEqual(security, { forced: true, enabled: true });
  assert.deepEqual(
    (await api.call("GET", internal(a.tenantId), { token: LOOKUP_TOKEN })).json,
    { ...contacts, version: "1" },
  );
});

test("deactivated organizations hide contacts and cannot update them", async () => {
  const a = await org("contacts-inactive");
  assert.equal(
    (
      await api.call("PUT", path(a.tenantId), {
        token: a.token,
        body: contacts,
        headers: headers("0"),
      })
    ).status,
    200,
  );
  await adminQuery(
    "UPDATE organizations SET state='suspended' WHERE tenant_id=$1",
    [a.tenantId],
  );
  assert.equal(
    (await api.call("GET", internal(a.tenantId), { token: LOOKUP_TOKEN }))
      .status,
    404,
  );
  assert.equal(
    (
      await api.call("PUT", path(a.tenantId), {
        token: a.token,
        body: contacts,
        headers: headers("1"),
      })
    ).status,
    404,
  );
});

test("internal contact lookup is mounted without end-user authentication configuration", async () => {
  const app = await createControlPlaneApp({
    db: runtimeDb(),
    lookupToken: LOOKUP_TOKEN,
  });
  await app.listen(0, "127.0.0.1");
  try {
    const base = await app.getUrl();
    assert.equal(
      (await fetch(new URL(internal(randomUUID()), base))).status,
      401,
    );
    assert.equal(
      (
        await fetch(new URL(internal(randomUUID()), base), {
          headers: { authorization: `Bearer ${LOOKUP_TOKEN}` },
        })
      ).status,
      404,
    );
    assert.equal(
      (await fetch(new URL(path(randomUUID()), base), { method: "PUT" }))
        .status,
      404,
    );
  } finally {
    await app.close();
  }
});

test("revoked admins cannot replace contacts and database constraints reject malformed destinations", async () => {
  const a = await org("contacts-revoked");
  assert.equal(
    (
      await api.call("PUT", path(a.tenantId), {
        token: a.token,
        body: contacts,
        headers: headers("0"),
      })
    ).status,
    200,
  );
  for (const email of [
    "invalid",
    "ops\x01@example.test",
    "one@example.test,two@example.test",
  ]) {
    await assert.rejects(
      asRuntime(
        { "app.tenant_id": a.tenantId },
        "UPDATE notification_contacts SET email_to=$1 WHERE tenant_id=$2",
        [email, a.tenantId],
      ),
      /check constraint/,
    );
  }
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": a.tenantId },
      "UPDATE notification_contacts SET sms_to='12045550123' WHERE tenant_id=$1",
      [a.tenantId],
    ),
    /check constraint/,
  );
  const cleared = await api.call("PUT", path(a.tenantId), {
    token: a.token,
    body: { email: null, sms: null },
    headers: headers("1"),
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.deepEqual(cleared.json, { email: null, sms: null, version: "2" });
  assert.equal(
    (
      await adminQuery(
        "SELECT 1 FROM notification_contacts WHERE tenant_id=$1",
        [a.tenantId],
      )
    ).length,
    1,
  );
  await adminQuery(
    "UPDATE memberships SET state='revoked',revoked_at=now(),revoked_by=identity_id,version=version+1 WHERE tenant_id=$1 AND identity_id=$2",
    [a.tenantId, identityIdOf(api.issuer.issuer, a.subject)],
  );
  assert.equal(
    (
      await api.call("PUT", path(a.tenantId), {
        token: a.token,
        body: { email: "changed@example.test" },
        headers: headers("1"),
      })
    ).status,
    404,
  );
  assert.deepEqual(
    (await api.call("GET", internal(a.tenantId), { token: LOOKUP_TOKEN })).json,
    { email: null, sms: null, version: "2" },
  );
});
