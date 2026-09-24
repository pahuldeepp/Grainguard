import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AuthError,
  createTokenVerifier,
  requireRole,
  type Principal,
} from "./index.js";
import { TEST_TENANT_ID, createTestIssuer } from "./testing/issuer.js";

const issuer = await createTestIssuer();
const verifier = createTokenVerifier({
  issuer: issuer.issuer,
  audience: issuer.audience,
  keys: { getKey: issuer.getKey },
});

async function rejects(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

const bearer = (token: string): string => `Bearer ${token}`;

test("valid token yields a principal from signed claims", async () => {
  const token = await issuer.sign({
    roles: ["admin", "viewer", "admin"],
    sub: "abc",
  });
  const principal = await verifier.verify(bearer(token));
  assert.equal(principal.subject, "abc");
  assert.equal(principal.tenantId, TEST_TENANT_ID);
  assert.deepEqual(principal.roles, ["admin", "viewer"]);
  assert.ok(principal.expiresAt.getTime() > Date.now());
});

test("scheme is case-insensitive", async () => {
  const token = await issuer.sign();
  const principal = await verifier.verify(`bEaReR ${token}`);
  assert.equal(principal.tenantId, TEST_TENANT_ID);
});

test("missing header is missing_token", async () => {
  await rejects(verifier.verify(undefined), 401, "missing_token");
  await rejects(verifier.verify(""), 401, "missing_token");
});

test("malformed headers are malformed_header", async () => {
  const token = await issuer.sign();
  for (const header of [
    token,
    `Basic ${token}`,
    `Bearer  ${token}`,
    `Bearer ${token} x`,
    "Bearer ",
    `Bearer\t${token}`,
  ]) {
    await rejects(verifier.verify(header), 401, "malformed_header");
  }
});

test("alg none is rejected", async () => {
  await rejects(
    verifier.verify(bearer(issuer.signNone())),
    401,
    "invalid_token",
  );
});

test("HS256 signed with the public key is rejected", async () => {
  const token = await issuer.signHs256WithPublicKey();
  await rejects(verifier.verify(bearer(token)), 401, "invalid_token");
});

test("unknown kid is rejected", async () => {
  const token = await issuer.sign({}, { kid: "nope" });
  await rejects(verifier.verify(bearer(token)), 401, "invalid_token");
});

test("garbage token and tampered signature are rejected without leaking details", async () => {
  const token = await issuer.sign();
  for (const bad of ["not-a-jwt", `${token.slice(0, -4)}AAAA`]) {
    await assert.rejects(verifier.verify(bearer(bad)), (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, "invalid_token");
      assert.equal(err.message, "invalid_token");
      assert.ok(!err.message.includes(bad));
      return true;
    });
  }
});

test("wrong issuer and audience are rejected", async () => {
  await rejects(
    verifier.verify(bearer(await issuer.sign({}, { issuer: "https://evil" }))),
    401,
    "invalid_token",
  );
  await rejects(
    verifier.verify(bearer(await issuer.sign({}, { audience: "other" }))),
    401,
    "invalid_token",
  );
});

test("expired token is expired_token, within tolerance passes", async () => {
  await rejects(
    verifier.verify(bearer(await issuer.sign({}, { expiresInSec: -120 }))),
    401,
    "expired_token",
  );
  await verifier.verify(bearer(await issuer.sign({}, { expiresInSec: -10 })));
});

test("token without exp is rejected", async () => {
  const token = await issuer.sign({ exp: undefined });
  await rejects(verifier.verify(bearer(token)), 401, "invalid_token");
});

test("nbf in the future is rejected", async () => {
  await rejects(
    verifier.verify(bearer(await issuer.sign({}, { notBeforeSec: 300 }))),
    401,
    "invalid_token",
  );
});

test("injected now and clock tolerance drive expiry", async () => {
  const token = await issuer.sign({}, { expiresInSec: 60 });
  const later = createTokenVerifier({
    issuer: issuer.issuer,
    audience: issuer.audience,
    keys: { getKey: issuer.getKey },
    clockToleranceSec: 0,
    now: () => new Date(Date.now() + 120_000),
  });
  await rejects(later.verify(bearer(token)), 401, "expired_token");
});

test("invalid tenant_id claims are invalid_claims", async () => {
  const bad = [
    undefined,
    42,
    "",
    "not-a-uuid",
    TEST_TENANT_ID.toUpperCase(),
    "00000000-0000-0000-0000-000000000000",
    "3f2b8c1e-5d4a-9b7e-9c1a-2e6f8a9b0c1d",
  ];
  for (const tenant_id of bad) {
    await rejects(
      verifier.verify(bearer(await issuer.sign({ tenant_id }))),
      401,
      "invalid_claims",
    );
  }
});

test("invalid roles claims are invalid_claims", async () => {
  for (const roles of [
    undefined,
    "admin",
    [],
    ["root"],
    ["viewer", 1],
    ["Admin"],
  ]) {
    await rejects(
      verifier.verify(bearer(await issuer.sign({ roles }))),
      401,
      "invalid_claims",
    );
  }
});

test("invalid sub is invalid_claims", async () => {
  for (const sub of [undefined, "", 7]) {
    await rejects(
      verifier.verify(bearer(await issuer.sign({ sub }))),
      401,
      "invalid_claims",
    );
  }
});

test("requireRole allows listed roles and denies others, admin is not implicit", () => {
  const principal: Principal = {
    subject: "s",
    tenantId: TEST_TENANT_ID,
    roles: ["operator"],
    expiresAt: new Date(),
  };
  requireRole(principal, "viewer", "operator");
  assert.throws(
    () => requireRole(principal, "admin"),
    (err: unknown) =>
      err instanceof AuthError &&
      err.status === 403 &&
      err.code === "insufficient_role",
  );
  assert.throws(
    () => requireRole({ ...principal, roles: ["admin"] }, "viewer"),
    AuthError,
  );
  assert.throws(() => requireRole(principal), AuthError);
});

test("remote JWKS is cached: two verifies make one request", async () => {
  const server = await issuer.serveJwks();
  try {
    const remote = createTokenVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { jwksUrl: server.url },
    });
    const token = bearer(await issuer.sign());
    await remote.verify(token);
    await remote.verify(token);
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }
});

test("key rotation is picked up after the cooldown", async () => {
  const server = await issuer.serveJwks();
  try {
    const remote = createTokenVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { jwksUrl: server.url, cacheMaxAgeMs: 60_000, cooldownMs: 5 },
    });
    await remote.verify(bearer(await issuer.sign()));
    await server.rotate();
    const rotated = bearer(await issuer.sign());
    await sleep(20);
    await remote.verify(rotated);
    assert.equal(server.requests(), 2);
  } finally {
    await server.close();
  }
});

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const remoteVerifier = (jwksUrl: string, timeoutMs = 300) =>
  createTokenVerifier({
    issuer: issuer.issuer,
    audience: issuer.audience,
    keys: { jwksUrl, timeoutMs },
  });

test("an unreachable, failing or slow key server is 503 auth_unavailable, not a bad token", async () => {
  const token = bearer(await issuer.sign());
  await rejects(
    remoteVerifier("http://127.0.0.1:1/jwks").verify(token),
    503,
    "auth_unavailable",
  );
  await withServer(
    (_req, res) => {
      res.statusCode = 500;
      res.end("down");
    },
    (url) =>
      rejects(remoteVerifier(url).verify(token), 503, "auth_unavailable"),
  );
  await withServer(
    () => undefined,
    (url) =>
      rejects(remoteVerifier(url).verify(token), 503, "auth_unavailable"),
  );
});

test("a healthy key server that lacks the token's key stays 401 invalid_token", async () => {
  const token = bearer(await issuer.sign());
  await withServer(
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [] }));
    },
    (url) => rejects(remoteVerifier(url).verify(token), 401, "invalid_token"),
  );
});
