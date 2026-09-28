import assert from "node:assert/strict";
import test from "node:test";
import { defaultCrypto } from "./pkce.js";
import { MobileSession, ReloginRequiredError } from "./session.js";
import {
  FakeClock,
  fakeJwt,
  jsonResponse,
  MemoryStore,
} from "./support.test.js";

const config = {
  authorizationEndpoint: "https://idp.example/auth",
  tokenEndpoint: "https://idp.example/token",
  clientId: "greenguard-mobile",
  redirectUri: "greenguard://auth/callback",
  scope: "openid offline_access",
};

type Grant = {
  tenant?: string;
  sub?: string;
  expiresIn?: number;
  // Real IdPs (Dex) issue no tenant claim; the BFF maps membership.
  noTenantClaim?: boolean;
};

function harness() {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const grants: Grant[] = [];
  const requests: URLSearchParams[] = [];
  let refreshFailure: Response | null = null;
  let counter = 0;
  let membershipLookups = 0;
  let currentNonce = "";
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body));
    requests.push(body);
    if (body.get("grant_type") === "refresh_token" && refreshFailure)
      return refreshFailure.clone();
    const grant = grants.shift() ?? {};
    counter += 1;
    const response = {
      access_token: fakeJwt({
        ...(grant.noTenantClaim
          ? { iss: "http://127.0.0.1:5556/dex" }
          : { tenant_id: grant.tenant ?? "tenant-a" }),
        sub: grant.sub ?? "user-1",
        n: counter,
      }),
      refresh_token: `rt-${counter}`,
      expires_in: grant.expiresIn ?? 300,
    };
    return jsonResponse(200, body.get("grant_type") === "authorization_code"
      ? { ...response, id_token: fakeJwt({ nonce: currentNonce }) }
      : response);
  }) as unknown as typeof fetch;
  const session = new MobileSession(config, store, {
    fetch: fetchFn,
    now: clock.now,
    crypto: defaultCrypto(),
    resolveMembership: async () => {
      membershipLookups += 1;
      return { tenantId: "tenant-authoritative", subject: "user-1" };
    },
  });
  const beginSignIn = session.beginSignIn.bind(session);
  session.beginSignIn = async () => {
    const authorizationUrl = await beginSignIn();
    currentNonce = new URL(authorizationUrl).searchParams.get("nonce") ?? "";
    return authorizationUrl;
  };
  return {
    store,
    clock,
    grants,
    requests,
    session,
    membershipLookups: () => membershipLookups,
    failRefresh: (response: Response | null) => (refreshFailure = response),
  };
}

async function signIn(h: ReturnType<typeof harness>) {
  const url = new URL(await h.session.beginSignIn());
  const state = url.searchParams.get("state");
  return h.session.completeSignIn(
    `greenguard://auth/callback?code=c&state=${state}`,
  );
}

test("sign-in stores tokens only in the secure store and reads identity from claims", async () => {
  const h = harness();
  const identity = await signIn(h);
  assert.deepEqual(identity, { tenantId: "tenant-a", subject: "user-1" });
  assert.ok([...h.store.data.keys()].some((k) => k.includes("tokens")));
  assert.equal(
    [...h.store.data.keys()].some((k) => k.includes("pkce")),
    false,
  );
});

test("a token without a tenant claim uses the BFF membership for local tenant scope", async () => {
  const h = harness();
  h.grants.push({ noTenantClaim: true });
  const identity = await signIn(h);
  assert.deepEqual(identity, {
    tenantId: "tenant-authoritative",
    subject: "user-1",
  });
  assert.deepEqual(await h.session.identity(), identity);
  const verified = await h.session.getAccessToken();
  assert.deepEqual(
    { tenantId: verified.tenantId, subject: verified.subject },
    identity,
  );
  assert.equal(h.membershipLookups(), 1);
});

test("a token without a tenant claim rejects a mismatched BFF session", async () => {
  const h = harness();
  h.grants.push({ noTenantClaim: true });
  let nonce = "";
  const verifying = new MobileSession(config, h.store, {
    fetch: (async () =>
      jsonResponse(200, {
        access_token: fakeJwt({ iss: "https://issuer.example", sub: "user-1" }),
        id_token: fakeJwt({ nonce }),
        expires_in: 300,
      })) as unknown as typeof fetch,
    now: h.clock.now,
    crypto: defaultCrypto(),
    resolveMembership: async () => ({
      tenantId: "tenant-b",
      subject: "other-user",
    }),
  });
  const url = new URL(await verifying.beginSignIn());
  nonce = url.searchParams.get("nonce") ?? "";
  await assert.rejects(
    verifying.completeSignIn(
      `greenguard://auth/callback?code=c&state=${url.searchParams.get("state")}`,
    ),
    /does not match/,
  );
});

test("a no-tenant token cannot enter offline state without a BFF membership resolver", async () => {
  const h = harness();
  let nonce = "";
  const session = new MobileSession(config, h.store, {
    fetch: (async () =>
      jsonResponse(200, {
        access_token: fakeJwt({ iss: "https://issuer.example", sub: "user-1" }),
        id_token: fakeJwt({ nonce }),
        expires_in: 300,
      })) as unknown as typeof fetch,
    now: h.clock.now,
    crypto: defaultCrypto(),
  });
  const url = new URL(await session.beginSignIn());
  nonce = url.searchParams.get("nonce") ?? "";
  await assert.rejects(
    session.completeSignIn(
      `greenguard://auth/callback?code=c&state=${url.searchParams.get("state")}`,
    ),
    /resolved by the BFF/,
  );
});

test("a token with neither tenant claim nor issuer is rejected", async () => {
  const h = harness();
  h.grants.push({ noTenantClaim: true });
  const original = h.session;
  const url = new URL(await original.beginSignIn());
  // Replace the issuer-bearing grant with a bare token for this case.
  const bare = new MobileSession(config, h.store, {
    fetch: (async () =>
      jsonResponse(200, {
        access_token: fakeJwt({ sub: "user-1" }),
        id_token: fakeJwt({ nonce: url.searchParams.get("nonce") ?? "" }),
        expires_in: 300,
      })) as unknown as typeof fetch,
    now: h.clock.now,
    crypto: defaultCrypto(),
  });
  await assert.rejects(
    bare.completeSignIn(
      `greenguard://auth/callback?code=c&state=${url.searchParams.get("state")}`,
    ),
    /tenant/i,
  );
});

test("callback with a forged state is rejected and pending state is consumed", async () => {
  const h = harness();
  await h.session.beginSignIn();
  await assert.rejects(
    h.session.completeSignIn("greenguard://auth/callback?code=c&state=forged"),
    /state/,
  );
  await assert.rejects(
    h.session.completeSignIn("greenguard://auth/callback?code=c&state=forged"),
    /No sign-in in progress/,
  );
  assert.equal(h.requests.length, 0);
});

test("unexpired tokens are reused; expiring tokens refresh once for concurrent callers", async () => {
  const h = harness();
  await signIn(h);
  const first = await h.session.getAccessToken();
  assert.equal(h.requests.length, 1);
  h.clock.advance(300_000 - 10_000);
  const [a, b] = await Promise.all([
    h.session.getAccessToken(),
    h.session.getAccessToken(),
  ]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].get("refresh_token"), "rt-1");
  assert.equal(a.accessToken, b.accessToken);
  assert.notEqual(a.accessToken, first.accessToken);
});

test("permanent refresh failure clears tokens and requires re-login", async () => {
  const h = harness();
  await signIn(h);
  let notified = 0;
  h.session.onReloginRequired(() => notified++);
  h.clock.advance(400_000);
  h.failRefresh(jsonResponse(400, { error: "invalid_grant" }));
  await assert.rejects(h.session.getAccessToken(), ReloginRequiredError);
  assert.equal(notified, 1);
  assert.equal(await h.session.identity(), null);
});

test("transient refresh failure keeps tokens so the caller can retry later", async () => {
  const h = harness();
  await signIn(h);
  h.clock.advance(400_000);
  h.failRefresh(jsonResponse(503, {}));
  await assert.rejects(h.session.getAccessToken(), /unavailable|transient/i);
  assert.deepEqual(await h.session.identity(), {
    tenantId: "tenant-a",
    subject: "user-1",
  });
  h.failRefresh(null);
  assert.ok((await h.session.getAccessToken()).accessToken);
});

test("forced refresh replaces a token the server rejected", async () => {
  const h = harness();
  await signIn(h);
  const before = await h.session.getAccessToken();
  const after = await h.session.getAccessToken({ force: true });
  assert.notEqual(before.accessToken, after.accessToken);
});

test("no tokens means re-login required", async () => {
  const h = harness();
  await assert.rejects(h.session.getAccessToken(), ReloginRequiredError);
});

test("switching tenant clears tokens and cached data, then starts a new sign-in", async () => {
  const h = harness();
  await signIn(h);
  const reasons: string[] = [];
  h.session.onCleared((reason) => reasons.push(reason));
  const url = await h.session.switchTenant();
  assert.match(url, /code_challenge=/);
  assert.deepEqual(reasons, ["tenant-switch"]);
  assert.equal(await h.session.identity(), null);
});

test("signing in as a different tenant over a live session clears caches", async () => {
  const h = harness();
  await signIn(h);
  const reasons: string[] = [];
  h.session.onCleared((reason) => reasons.push(reason));
  h.grants.push({ tenant: "tenant-b", sub: "user-1" });
  const identity = await signIn(h);
  assert.equal(identity.tenantId, "tenant-b");
  assert.deepEqual(reasons, ["identity-change"]);
});

test("a token without a tenant claim is refused", async () => {
  const h = harness();
  h.grants.push({ tenant: "" });
  await assert.rejects(signIn(h), /tenant/);
  assert.equal(await h.session.identity(), null);
});

test("sign-out removes tokens and notifies listeners", async () => {
  const h = harness();
  await signIn(h);
  const reasons: string[] = [];
  h.session.onCleared((reason) => reasons.push(reason));
  await h.session.signOut();
  assert.deepEqual(reasons, ["sign-out"]);
  assert.equal(await h.session.identity(), null);
});
