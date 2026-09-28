import assert from "node:assert/strict";
import test from "node:test";
import { exchangeCode, OidcError, refreshTokens } from "./oidc.js";
import { fakeJwt, FakeClock, jsonResponse } from "./support.test.js";

const config = {
  authorizationEndpoint: "https://idp.example/auth",
  tokenEndpoint: "https://idp.example/token",
  clientId: "greenguard-mobile",
  redirectUri: "greenguard://auth/callback",
  scope: "openid",
};

function deps(
  respond: (body: URLSearchParams) => Response | Promise<Response>,
) {
  const clock = new FakeClock();
  const calls: URLSearchParams[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    // React Native's fetch does not serialise a URLSearchParams object: the body must be a string.
    assert.equal(typeof init.body, "string");
    const body = new URLSearchParams(String(init.body));
    calls.push(body);
    return respond(body);
  }) as unknown as typeof fetch;
  return { clock, calls, deps: { fetch: fetchFn, now: clock.now } };
}

test("code exchange sends the verifier and computes expiry from the clock", async () => {
  const idToken = fakeJwt({ nonce: "n1" });
  const ctx = deps(() =>
    jsonResponse(200, {
      access_token: "at",
      refresh_token: "rt",
      id_token: idToken,
      expires_in: 300,
    }),
  );
  const tokens = await exchangeCode(
    config,
    { code: "c1", verifier: "v1", nonce: "n1" },
    ctx.deps,
  );
  assert.equal(ctx.calls[0].get("grant_type"), "authorization_code");
  assert.equal(ctx.calls[0].get("code_verifier"), "v1");
  assert.equal(ctx.calls[0].get("redirect_uri"), config.redirectUri);
  assert.equal(tokens.accessToken, "at");
  assert.equal(tokens.expiresAt, ctx.clock.now() + 300_000);
});

test("code exchange rejects an id token with the wrong nonce", async () => {
  const ctx = deps(() =>
    jsonResponse(200, {
      access_token: "at",
      id_token: fakeJwt({ nonce: "other" }),
      expires_in: 60,
    }),
  );
  await assert.rejects(
    exchangeCode(config, { code: "c", verifier: "v", nonce: "n1" }, ctx.deps),
    /nonce/,
  );
});

test("openid code exchange rejects a missing id token", async () => {
  const ctx = deps(() => jsonResponse(200, { access_token: "at", expires_in: 60 }));
  await assert.rejects(
    exchangeCode(config, { code: "c", verifier: "v", nonce: "n1" }, ctx.deps),
    /no id_token/,
  );
});

test("refresh keeps the old refresh token when none is rotated", async () => {
  const ctx = deps(() =>
    jsonResponse(200, { access_token: "at2", expires_in: 60 }),
  );
  const tokens = await refreshTokens(config, "rt-old", ctx.deps);
  assert.equal(ctx.calls[0].get("grant_type"), "refresh_token");
  assert.equal(tokens.refreshToken, "rt-old");
  assert.equal(tokens.accessToken, "at2");
});

test("invalid_grant is permanent; 5xx and network errors are transient", async () => {
  const permanent = deps(() => jsonResponse(400, { error: "invalid_grant" }));
  await assert.rejects(
    refreshTokens(config, "rt", permanent.deps),
    (e: unknown) => e instanceof OidcError && !e.transient,
  );
  const server = deps(() => jsonResponse(503, {}));
  await assert.rejects(
    refreshTokens(config, "rt", server.deps),
    (e: unknown) => e instanceof OidcError && e.transient,
  );
  const offline = deps(() => {
    throw new TypeError("Network request failed");
  });
  await assert.rejects(
    refreshTokens(config, "rt", offline.deps),
    (e: unknown) => e instanceof OidcError && e.transient,
  );
});

test("a token response without an access token is rejected", async () => {
  const ctx = deps(() => jsonResponse(200, { expires_in: 10 }));
  await assert.rejects(refreshTokens(config, "rt", ctx.deps), /access_token/);
});
