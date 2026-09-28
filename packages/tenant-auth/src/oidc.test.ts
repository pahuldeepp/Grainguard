import { refreshableMemberships } from "./oidc.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthError,
  createTokenVerifier,
  createTokenVerifierFromEnv,
  membershipMapper,
  parseMemberships,
} from "./index.js";
import { TEST_TENANT_ID, createTestIssuer } from "./testing/issuer.js";

const issuer = await createTestIssuer();
const OTHER_TENANT = "9b2c7d1e-3f4a-4b5c-8d6e-7f8091a2b3c4";
const membershipJson = JSON.stringify([
  {
    issuer: issuer.issuer,
    subject: "idp-user",
    tenantId: OTHER_TENANT,
    roles: ["operator"],
  },
]);
const mapped = createTokenVerifier({
  issuer: issuer.issuer,
  audience: issuer.audience,
  keys: { getKey: issuer.getKey },
  mapIdentity: membershipMapper(parseMemberships(membershipJson)),
});
const bearer = (token: string) => `Bearer ${token}`;

test("membership supplies tenant and roles; IdP-asserted claims are ignored", async () => {
  const token = await issuer.sign({
    sub: "idp-user",
    tenant_id: TEST_TENANT_ID,
    roles: ["admin"],
  });
  const principal = await mapped.verify(bearer(token));
  assert.equal(principal.tenantId, OTHER_TENANT);
  assert.deepEqual(principal.roles, ["operator"]);
  assert.equal(principal.subject, "idp-user");
});

test("an authenticated identity without membership is invalid_claims", async () => {
  const token = await issuer.sign({ sub: "stranger" });
  await assert.rejects(
    mapped.verify(bearer(token)),
    (error: unknown) =>
      error instanceof AuthError &&
      error.status === 401 &&
      error.code === "invalid_claims",
  );
});

test("membership is scoped to the issuer", () => {
  const map = membershipMapper(parseMemberships(membershipJson));
  assert.equal(map({ iss: "https://other.test", sub: "idp-user" }), undefined);
});

test("malformed membership files fail at startup", () => {
  assert.throws(() => parseMemberships("{}"), /must be an array/);
  assert.throws(
    () => parseMemberships(JSON.stringify([{ issuer: "x" }])),
    /needs issuer/,
  );
});

test("env verifier requires issuer, audience and JWKS URL", () => {
  assert.throws(
    () =>
      createTokenVerifierFromEnv(
        () => undefined,
        () => "",
      ),
    /AUTH_ISSUER is required/,
  );
});

test("Cognito env mode requires allowed clients and a trusted membership mapper", () => {
  const env: Record<string, string> = {
    AUTH_ISSUER: issuer.issuer,
    AUTH_JWKS_URL: "http://127.0.0.1:1/keys",
    AUTH_TOKEN_MODE: "cognito-access",
  };
  assert.throws(
    () =>
      createTokenVerifierFromEnv(
        (key) => env[key],
        () => membershipJson,
      ),
    /AUTH_COGNITO_CLIENT_IDS/,
  );
  env.AUTH_COGNITO_CLIENT_IDS = "web-client,ios-client";
  assert.throws(
    () =>
      createTokenVerifierFromEnv(
        (key) => env[key],
        () => membershipJson,
      ),
    /mapped identity/,
  );
  env.AUTH_MEMBERSHIP_FILE = "/memberships.json";
  const verifier = createTokenVerifierFromEnv(
    (key) => env[key],
    () => membershipJson,
  );
  verifier.close();
});

test("env verifier rejects negative tuning values", () => {
  const env: Record<string, string> = {
    AUTH_ISSUER: issuer.issuer,
    AUTH_AUDIENCE: issuer.audience,
    AUTH_JWKS_URL: "http://127.0.0.1:1/keys",
    AUTH_JWKS_CACHE_MS: "-1",
  };
  assert.throws(
    () =>
      createTokenVerifierFromEnv(
        (k) => env[k],
        () => "",
      ),
    /AUTH_JWKS_CACHE_MS must be/,
  );
});

test("env verifier maps memberships from the configured file over a live JWKS", async () => {
  const jwks = await issuer.serveJwks();
  try {
    const env: Record<string, string> = {
      AUTH_ISSUER: issuer.issuer,
      AUTH_AUDIENCE: issuer.audience,
      AUTH_JWKS_URL: jwks.url,
      AUTH_JWKS_CACHE_MS: "1000",
      AUTH_JWKS_COOLDOWN_MS: "",
      AUTH_CLOCK_TOLERANCE_SEC: "0",
      AUTH_MEMBERSHIP_FILE: "/memberships.json",
    };
    const files: string[] = [];
    const verifier = createTokenVerifierFromEnv(
      (k) => env[k],
      (path) => {
        files.push(path);
        return membershipJson;
      },
    );
    const principal = await verifier.verify(
      bearer(await issuer.sign({ sub: "idp-user" })),
    );
    assert.equal(principal.tenantId, OTHER_TENANT);
    assert.deepEqual(files, ["/memberships.json"]);
  } finally {
    await jwks.close();
  }
});

test("env verifier without a membership file uses signed claims", async () => {
  const jwks = await issuer.serveJwks();
  try {
    const env: Record<string, string> = {
      AUTH_ISSUER: issuer.issuer,
      AUTH_AUDIENCE: issuer.audience,
      AUTH_JWKS_URL: jwks.url,
    };
    const verifier = createTokenVerifierFromEnv(
      (k) => env[k],
      () => "",
    );
    const principal = await verifier.verify(bearer(await issuer.sign()));
    assert.equal(principal.tenantId, TEST_TENANT_ID);
  } finally {
    await jwks.close();
  }
});

test("roles use the complete allow-list and errors identify only the entry index", () => {
  const entry = JSON.parse(membershipJson)[0];
  for (const role of ["owner", 7, null, {}, false]) {
    assert.throws(
      () =>
        parseMemberships(JSON.stringify([entry, { ...entry, roles: [role] }])),
      { message: "membership entry 1 has an invalid role" },
    );
  }
  assert.deepEqual(
    [
      ...parseMemberships(
        JSON.stringify([
          { ...entry, roles: ["viewer", "operator", "admin", "device"] },
        ]),
      ).values(),
    ][0].roles,
    ["viewer", "operator", "admin", "device"],
  );
});

test("refresh revokes membership, publishes whole maps and stops on close", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  let file = membershipJson;
  let reads = 0;
  const store = refreshableMemberships(
    () => {
      reads++;
      return file;
    },
    30,
    100,
  );
  t.after(() => store.close());
  const identity = { iss: issuer.issuer, sub: "idp-user" };
  assert.equal(store.mapIdentity(identity)?.tenant_id, OTHER_TENANT);
  file = "[]";
  t.mock.timers.tick(30);
  assert.equal(store.mapIdentity(identity), undefined);
  file = membershipJson;
  t.mock.timers.tick(30);
  assert.equal(store.mapIdentity(identity)?.tenant_id, OTHER_TENANT);
  store.close();
  t.mock.timers.tick(300);
  assert.equal(reads, 3);
});

test("bad refresh retains the whole last good map then rejects with 401 until recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const logged = t.mock.method(console, "error", () => undefined);
  let file = membershipJson;
  let unreadable = false;
  const store = refreshableMemberships(
    () => {
      if (unreadable) throw new Error("read failed");
      return file;
    },
    30,
    100,
  );
  t.after(() => store.close());
  const identity = { iss: issuer.issuer, sub: "idp-user" };
  const entry = JSON.parse(membershipJson)[0];
  file = JSON.stringify([
    { ...entry, tenantId: TEST_TENANT_ID },
    { ...entry, roles: ["unknown"] },
  ]);
  t.mock.timers.tick(30);
  assert.equal(store.mapIdentity(identity)?.tenant_id, OTHER_TENANT);
  file = "{";
  t.mock.timers.tick(30);
  assert.equal(store.mapIdentity(identity)?.tenant_id, OTHER_TENANT);
  unreadable = true;
  t.mock.timers.tick(39);
  assert.ok(store.mapIdentity(identity));
  t.mock.timers.tick(1);
  assert.equal(store.mapIdentity(identity), undefined);
  const verifier = createTokenVerifier({
    issuer: issuer.issuer,
    audience: issuer.audience,
    keys: { getKey: issuer.getKey },
    mapIdentity: store.mapIdentity,
  });
  await assert.rejects(
    verifier.verify(bearer(await issuer.sign({ sub: identity.sub }))),
    (error: unknown) => error instanceof AuthError && error.status === 401,
  );
  assert.ok(logged.mock.calls.length >= 4);
  unreadable = false;
  file = membershipJson;
  t.mock.timers.tick(20);
  assert.equal(store.mapIdentity(identity)?.tenant_id, OTHER_TENANT);
});

test("refresh timer is unreferenced and zero disables refresh", (t) => {
  const timer = setInterval(() => assert.fail("unexpected timer"), 60_000);
  t.after(() => clearInterval(timer));
  const interval = t.mock.method(globalThis, "setInterval", () => timer);
  const store = refreshableMemberships(() => membershipJson);
  assert.equal(timer.hasRef(), false);
  store.close();
  const disabled = refreshableMemberships(() => membershipJson, 0);
  disabled.close();
  assert.equal(interval.mock.calls.length, 1);
});

test("env membership refresh honors configuration and validates timer bounds", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const env: Record<string, string> = {
    AUTH_ISSUER: issuer.issuer,
    AUTH_AUDIENCE: issuer.audience,
    AUTH_JWKS_URL: "https://issuer.test/keys",
    AUTH_MEMBERSHIP_FILE: "/membership-fixture.json",
  };
  let reads = 0;
  const read = () => {
    reads++;
    return membershipJson;
  };
  const configured = () => createTokenVerifierFromEnv((key) => env[key], read);
  const defaults = configured();
  t.mock.timers.tick(29_999);
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  assert.equal(reads, 2);
  defaults.close();
  env.AUTH_MEMBERSHIP_REFRESH_MS = "10";
  const custom = configured();
  t.mock.timers.tick(10);
  assert.equal(reads, 4);
  custom.close();
  env.AUTH_MEMBERSHIP_REFRESH_MS = "0";
  const disabled = configured();
  t.mock.timers.tick(60_000);
  assert.equal(reads, 5);
  disabled.close();
  for (const invalid of ["-1", "NaN", "0.1", "2147483648"]) {
    env.AUTH_MEMBERSHIP_REFRESH_MS = invalid;
    assert.throws(configured, /AUTH_MEMBERSHIP_REFRESH_MS/);
  }
});

const otherSubject = "another-user";
const validEntry = JSON.parse(membershipJson)[0];
const duplicateFile = JSON.stringify([
  validEntry,
  { ...validEntry, subject: otherSubject },
  { ...validEntry, tenantId: TEST_TENANT_ID },
]);
const duplicateError = "duplicate membership identity at entries 0 and 2";
const invalidTenantError =
  "membership entry 1 needs a canonical lower-case UUID tenantId";
const invalidTenantFile = (tenantId: string) =>
  JSON.stringify([
    { ...validEntry, tenantId: TEST_TENANT_ID },
    { ...validEntry, subject: otherSubject, tenantId },
  ]);

test("duplicate membership keys fail initial load without exposing identifiers", () => {
  assert.throws(() => refreshableMemberships(() => duplicateFile), {
    message: duplicateError,
  });
});

test("noncanonical tenant UUIDs fail initial load with only the entry index", () => {
  for (const tenantId of [
    "not-a-uuid",
    OTHER_TENANT.toUpperCase(),
    ` ${OTHER_TENANT}`,
    `${OTHER_TENANT}\n`,
    OTHER_TENANT.replaceAll("-", ""),
    "",
  ]) {
    assert.throws(
      () => refreshableMemberships(() => invalidTenantFile(tenantId)),
      { message: invalidTenantError },
    );
  }
});

for (const [name, invalidFile] of [
  ["duplicate identity", duplicateFile],
  ["invalid tenant UUID", invalidTenantFile("invalid")],
]) {
  test(`${name} refresh keeps the last good map until max-stale then fails closed`, (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"] });
    const logged = t.mock.method(console, "error", () => undefined);
    let file = membershipJson;
    const store = refreshableMemberships(() => file);
    t.after(() => store.close());
    const identity = { iss: issuer.issuer, sub: validEntry.subject };
    const expected = {
      ...identity,
      tenant_id: OTHER_TENANT,
      roles: validEntry.roles,
    };
    assert.deepEqual(store.mapIdentity(identity), expected);
    file = invalidFile;
    t.mock.timers.tick(30_000);
    assert.deepEqual(store.mapIdentity(identity), expected);
    assert.equal(
      store.mapIdentity({ iss: issuer.issuer, sub: otherSubject }),
      undefined,
    );
    t.mock.timers.tick(269_999);
    assert.deepEqual(store.mapIdentity(identity), expected);
    t.mock.timers.tick(1);
    assert.equal(store.mapIdentity(identity), undefined);
    assert.ok(logged.mock.calls.length > 0);
    file = membershipJson;
    t.mock.timers.tick(30_000);
    assert.deepEqual(store.mapIdentity(identity), expected);
  });
}

test("valid distinct memberships load even when issuer or subject is shared", () => {
  const entries = [
    validEntry,
    { ...validEntry, subject: otherSubject },
    { ...validEntry, issuer: "https://different.test" },
  ];
  const memberships = parseMemberships(JSON.stringify(entries));
  assert.equal(memberships.size, entries.length);
  for (const entry of entries) {
    assert.deepEqual(memberships.get(`${entry.issuer}|${entry.subject}`), {
      tenantId: entry.tenantId,
      roles: entry.roles,
    });
  }
});
