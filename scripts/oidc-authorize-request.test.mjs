import assert from "node:assert/strict";
import test from "node:test";
import { isInteractiveAuthorizeRequest } from "./oidc-authorize-request.mjs";

const issuer = "http://127.0.0.1:5556/dex";

test("silent OIDC restore is not mistaken for a user login", () => {
  assert.equal(
    isInteractiveAuthorizeRequest(
      `${issuer}/auth?prompt=none&response_type=code`,
      issuer,
    ),
    false,
  );
});

test("interactive authorize requests are selected when query fields vary", () => {
  assert.equal(
    isInteractiveAuthorizeRequest(
      `${issuer}/auth?response_type=code&state=s&nonce=n&code_challenge_method=S256`,
      issuer,
    ),
    true,
  );
  assert.equal(
    isInteractiveAuthorizeRequest(
      `${issuer}/auth?prompt=login&response_type=code`,
      issuer,
    ),
    true,
  );
  assert.equal(
    isInteractiveAuthorizeRequest(
      "https://id.greenguard.test/tenant/dex/auth?response_type=code&state=s&nonce=n",
      "https://id.greenguard.test/tenant/dex/",
    ),
    true,
  );
});

test("unrelated, malformed, and other issuer requests are ignored", () => {
  assert.equal(isInteractiveAuthorizeRequest("not a URL", issuer), false);
  assert.equal(
    isInteractiveAuthorizeRequest("http://127.0.0.1:5556/dex/token", issuer),
    false,
  );
  assert.equal(
    isInteractiveAuthorizeRequest(
      "http://127.0.0.1:5557/dex/auth?response_type=code",
      issuer,
    ),
    false,
  );
});
