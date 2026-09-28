import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AuthError } from "@greenguard/tenant-auth";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import {
  createMembershipCache,
  createMembershipVerifier,
  createVerifierFromEnv,
  httpMembershipFetcher,
  identityKey,
  membershipChangedHandler,
  createRedisMembershipVersionStore,
  type LookupResult,
} from "./index.js";

const TENANT_A = "0a0a0a0a-0000-4000-8000-00000000000a";
const TENANT_B = "0b0b0b0b-0000-4000-8000-00000000000b";
const ISSUER = "https://issuer.test";

const active = (version: string, tenantId = TENANT_A): LookupResult => ({
  tenantId,
  roles: ["operator"],
  version,
  state: "active",
});

test("shared Redis version floor rejects an older lookup on another replica and ignores reordered events", async () => {
  const values = new Map<string, string>();
  const redis = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async eval(
      _script: string,
      options: { keys: string[]; arguments: string[] },
    ) {
      const key = options.keys[0]!;
      const next = BigInt(options.arguments[0]!);
      if (next > BigInt(values.get(key) ?? "0"))
        values.set(key, next.toString());
      return 1;
    },
  };
  const versionStore = createRedisMembershipVersionStore(redis);
  const id = identityKey(ISSUER, "alice");
  await versionStore.advance({
    tenantId: TENANT_A,
    identityId: id,
    version: 9007199254740994n,
  });
  await versionStore.advance({
    tenantId: TENANT_A,
    identityId: id,
    version: 9007199254740993n,
  });
  assert.equal(await versionStore.floor(id, TENANT_A), 9007199254740994n);
  assert.equal(await versionStore.floor(id, TENANT_B), 0n);
  const cache = createMembershipCache({
    fetch: async () => active("9007199254740993"),
    versionStore,
  });
  const issuer = await createTestIssuer();
  const verifier = createMembershipVerifier(
    {
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { getKey: issuer.getKey },
    },
    cache,
  );
  await assert.rejects(
    verifier.verify(`Bearer ${await issuer.sign({ sub: "alice" })}`),
    denied(401, "invalid_claims"),
  );
});
const revoked = (version: string, tenantId = TENANT_A): LookupResult => ({
  tenantId,
  roles: [],
  version,
  state: "revoked",
});

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

async function harness(lookup: () => Promise<LookupResult | null>) {
  const issuer = await createTestIssuer();
  const time = clock();
  let calls = 0;
  const cache = createMembershipCache({
    fetch: async () => {
      calls++;
      return lookup();
    },
    now: time.now,
  });
  const verifier = createMembershipVerifier(
    {
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { getKey: issuer.getKey },
    },
    cache,
  );
  const bearer = async (sub = "alice", extra: Record<string, unknown> = {}) =>
    `Bearer ${await issuer.sign({ sub, ...extra })}`;
  const event = (version: string, tenantId = TENANT_A, sub = "alice") => ({
    event_type: "membership.changed",
    tenant_id: tenantId,
    payload: {
      identity_id: identityKey(ISSUER, sub),
      membership_version: version,
    },
  });
  return {
    time,
    calls: () => calls,
    cache,
    verifier,
    bearer,
    event,
    apply: membershipChangedHandler(cache),
  };
}

const denied = (status: number, code: string) => (error: unknown) =>
  error instanceof AuthError && error.status === status && error.code === code;

test("identity keys are deterministic hashes of issuer|subject, distinct per issuer", () => {
  assert.equal(identityKey(ISSUER, "alice"), identityKey(ISSUER, "alice"));
  assert.notEqual(
    identityKey(ISSUER, "alice"),
    identityKey("https://other", "alice"),
  );
  assert.match(
    identityKey(ISSUER, "alice"),
    /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
});

test("a verified identity is mapped from the store and IdP tenant claims are ignored (M08)", async () => {
  const h = await harness(async () => active("1"));
  const principal = await h.verifier.verify(
    await h.bearer("alice", { tenant_id: TENANT_B, roles: ["admin"] }),
  );
  assert.equal(principal.tenantId, TENANT_A);
  assert.deepEqual(principal.roles, ["operator"]);
  assert.equal(h.calls(), 1);
});

test("a token that fails verification never triggers a membership lookup", async () => {
  const h = await harness(async () => active("1"));
  const other = await createTestIssuer();
  const forged = `Bearer ${await other.sign({ sub: "alice" })}`;
  await assert.rejects(h.verifier.verify(forged), denied(401, "invalid_token"));
  assert.equal(h.calls(), 0);
});

test("revoke -> event -> entry gone -> next request 403, never the stale role", async () => {
  let state = active("1");
  const h = await harness(async () => state);
  const token = await h.bearer();
  await h.verifier.verify(token);
  state = revoked("2");
  h.apply(h.event("2"));
  await assert.rejects(
    h.verifier.verify(token),
    denied(403, "insufficient_role"),
  );
  assert.equal(h.calls(), 2);
});

test("revoke while the consumer is down: still denied within the 30 s TTL bound", async () => {
  let state = active("1");
  const h = await harness(async () => state);
  const token = await h.bearer();
  await h.verifier.verify(token);
  state = revoked("2");
  h.time.advance(29_999);
  assert.equal((await h.verifier.verify(token)).tenantId, TENANT_A);
  h.time.advance(1);
  await assert.rejects(
    h.verifier.verify(token),
    denied(403, "insufficient_role"),
  );
});

test("duplicate and out-of-order events are no-ops once the cache holds a newer version", async () => {
  const h = await harness(async () => active("5"));
  const token = await h.bearer();
  await h.verifier.verify(token);
  h.apply(h.event("5"));
  h.apply(h.event("3"));
  h.apply({ ...h.event("9"), event_type: "tenant.created" });
  await h.verifier.verify(token);
  assert.equal(h.calls(), 1);
});

test("a lookup that answers older than an event already seen is not trusted", async () => {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const inFlight = new Promise<void>((resolve) => (started = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = await harness(async () => {
    started();
    await gate;
    return active("1");
  });
  const pending = h.verifier.verify(await h.bearer());
  await inFlight;
  h.apply(h.event("2"));
  release();
  await assert.rejects(pending, denied(401, "invalid_claims"));
});

test("a newer event for another tenant invalidates the identity; reordered events do not", async () => {
  let ambiguous = false;
  const h = await harness(async () =>
    ambiguous ? null : active("1", TENANT_B),
  );
  const token = await h.bearer();
  await h.verifier.verify(token);
  ambiguous = true;
  await h.apply(h.event("7", TENANT_A));
  await assert.rejects(h.verifier.verify(token), denied(401, "invalid_claims"));
  assert.equal(h.calls(), 2);
  await h.apply(h.event("6", TENANT_A));
  await h.apply(h.event("7", TENANT_A));
  await h.apply(h.event("7", TENANT_B, "never-seen"));
  await assert.rejects(h.verifier.verify(token), denied(401, "invalid_claims"));
  assert.equal(h.calls(), 2);
});

test("negative results are cached for 5 s so a new invitee is admitted soon", async () => {
  let state: LookupResult | null = null;
  const h = await harness(async () => state);
  const token = await h.bearer();
  await assert.rejects(h.verifier.verify(token), denied(401, "invalid_claims"));
  state = active("1");
  h.time.advance(4_999);
  await assert.rejects(h.verifier.verify(token), denied(401, "invalid_claims"));
  h.time.advance(1);
  assert.equal((await h.verifier.verify(token)).tenantId, TENANT_A);
  assert.equal(h.calls(), 2);
});

test("malformed event payload cannot crash the verifier", async () => {
  const h = await harness(async () => active("1"));
  await h.apply({
    event_type: "membership.changed",
    tenant_id: TENANT_A,
    payload: null as unknown as Record<string, unknown>,
  });
  assert.equal((await h.verifier.verify(await h.bearer())).tenantId, TENANT_A);
});

test("lookup outage keeps the last good entry until 5 minutes, then fails closed (M07)", async () => {
  let up = true;
  const h = await harness(async () => {
    if (!up) throw new Error("control plane down");
    return active("1");
  });
  const token = await h.bearer();
  await h.verifier.verify(token);
  up = false;
  h.time.advance(30_000);
  assert.equal((await h.verifier.verify(token)).tenantId, TENANT_A);
  h.time.advance(269_999);
  assert.equal((await h.verifier.verify(token)).tenantId, TENANT_A);
  h.time.advance(1);
  await assert.rejects(h.verifier.verify(token), denied(401, "invalid_claims"));
});

test("an outage with no cached entry denies instead of allowing", async () => {
  const h = await harness(async () => {
    throw new Error("down");
  });
  await assert.rejects(
    h.verifier.verify(await h.bearer()),
    denied(401, "invalid_claims"),
  );
});

test("the HTTP fetcher maps 200 active/revoked and 404, and rejects every other answer", async () => {
  const seen: { url?: string; auth?: string }[] = [];
  const bodies: Record<string, unknown> = {
    active: active("3"),
    revoked: revoked("4"),
  };
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const subject =
      new URL(req.url ?? "/", "http://x").searchParams.get("subject") ?? "";
    res.statusCode = subject in bodies ? 200 : Number(subject);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(bodies[subject] ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const fetchMembership = httpMembershipFetcher({
      baseUrl: base,
      token: "secret",
    });
    assert.deepEqual(await fetchMembership("https://i", "active"), active("3"));
    assert.deepEqual(
      await fetchMembership("https://i", "revoked"),
      revoked("4"),
    );
    assert.equal(await fetchMembership("https://i", "404"), null);
    await assert.rejects(fetchMembership("https://i", "409"), /409/);
    await assert.rejects(fetchMembership("https://i", "500"), /500/);
    assert.equal(seen[0]?.auth, "Bearer secret");
    assert.match(
      seen[0]?.url ?? "",
      /^\/v1\/internal\/memberships\?issuer=https%3A%2F%2Fi&subject=active$/,
    );
  } finally {
    server.close();
  }
});

test("the HTTP fetcher rejects a malformed membership body", async () => {
  const reply = (body: unknown) =>
    httpMembershipFetcher({
      baseUrl: "http://control.test",
      token: "t",
      fetch: async () => new Response(JSON.stringify(body)),
    })("i", "s");
  await assert.rejects(
    reply({ tenantId: "x", roles: [], version: "1", state: "active" }),
    /malformed/,
  );
  await assert.rejects(reply({ ...active("1"), roles: [] }), /malformed/);
  await assert.rejects(reply({ ...active("1"), version: "0" }), /malformed/);
});

test("the env switch keeps the file source by default and validates the control-plane source", async () => {
  const issuer = await createTestIssuer();
  const base: Record<string, string> = {
    AUTH_ISSUER: issuer.issuer,
    AUTH_AUDIENCE: issuer.audience,
    AUTH_JWKS_URL: "http://127.0.0.1:1/keys",
  };
  const fileVerifier = createVerifierFromEnv(
    (k) => base[k],
    () => "[]",
  );
  fileVerifier.close();
  const env: Record<string, string> = {
    ...base,
    AUTH_MEMBERSHIP_SOURCE: "control-plane",
  };
  assert.throws(
    () =>
      createVerifierFromEnv(
        (k) => env[k],
        () => "",
      ),
    /CONTROL_PLANE_URL/,
  );
  const full: Record<string, string> = {
    ...env,
    CONTROL_PLANE_URL: "http://127.0.0.1:3010",
    CONTROL_LOOKUP_TOKEN: "t",
  };
  const verifier = createVerifierFromEnv(
    (k) => full[k],
    () => "",
  );
  await assert.rejects(
    verifier.verify(undefined),
    denied(401, "missing_token"),
  );
  verifier.close();
  const bad: Record<string, string> = {
    ...base,
    AUTH_MEMBERSHIP_SOURCE: "ldap",
  };
  assert.throws(
    () =>
      createVerifierFromEnv(
        (k) => bad[k],
        () => "",
      ),
    /AUTH_MEMBERSHIP_SOURCE/,
  );
});
