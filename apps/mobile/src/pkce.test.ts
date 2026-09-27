import assert from "node:assert/strict";
import test from "node:test";
import {
  base64Url,
  buildAuthorizationUrl,
  challengeFor,
  createPkceRequest,
  defaultCrypto,
  parseCallback,
} from "./pkce.js";

const config = {
  authorizationEndpoint: "https://idp.example/auth",
  clientId: "greenguard-mobile",
  redirectUri: "greenguard://auth/callback",
  scope: "openid profile email offline_access",
  audience: "greenguard-api",
};

test("S256 challenge matches the RFC 7636 appendix B vector", async () => {
  const challenge = await challengeFor(
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    defaultCrypto(),
  );
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("base64Url is unpadded and url safe", () => {
  assert.equal(base64Url(new Uint8Array([251, 255, 254])), "-__-");
  assert.equal(base64Url(new Uint8Array([1])), "AQ");
});

test("request material is random, long enough and distinct", async () => {
  const one = await createPkceRequest(defaultCrypto());
  const two = await createPkceRequest(defaultCrypto());
  assert.ok(one.verifier.length >= 43 && one.verifier.length <= 128);
  assert.notEqual(one.verifier, two.verifier);
  assert.notEqual(one.state, one.nonce);
  assert.match(one.challenge, /^[A-Za-z0-9_-]{43}$/);
});

test("authorization URL carries PKCE, state, nonce and audience", async () => {
  const request = await createPkceRequest(defaultCrypto());
  const url = new URL(buildAuthorizationUrl(config, request));
  const q = url.searchParams;
  assert.equal(url.origin + url.pathname, config.authorizationEndpoint);
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("code_challenge"), request.challenge);
  assert.equal(q.get("state"), request.state);
  assert.equal(q.get("nonce"), request.nonce);
  assert.equal(q.get("audience"), "greenguard-api");
  assert.equal(q.get("client_id"), config.clientId);
  assert.equal(url.searchParams.has("code_verifier"), false);
});

test("callback returns the code when state matches", () => {
  assert.equal(
    parseCallback("greenguard://auth/callback?code=abc&state=s1", "s1"),
    "abc",
  );
});

test("callback rejects state mismatch, missing state and idp errors", () => {
  assert.throws(
    () => parseCallback("greenguard://auth/callback?code=abc&state=evil", "s1"),
    /state/,
  );
  assert.throws(
    () => parseCallback("greenguard://auth/callback?code=abc", "s1"),
    /state/,
  );
  assert.throws(
    () =>
      parseCallback(
        "greenguard://auth/callback?error=access_denied&state=s1",
        "s1",
      ),
    /access_denied/,
  );
  assert.throws(
    () => parseCallback("greenguard://auth/callback?state=s1", "s1"),
    /code/,
  );
});
