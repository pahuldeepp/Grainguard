// Stage 09g local proof with two independent Dex issuers. Run with
// `node --env-file=.env scripts/oidc-multi-live.mjs` after starting both Dex.
// Tokens and credentials are never printed.
import assert from "node:assert/strict";
import { createMultiIssuerVerifier } from "../packages/tenant-auth/dist/issuers.js";
import {
  membershipMapper,
  parseMemberships,
} from "../packages/tenant-auth/dist/index.js";

const first = "http://127.0.0.1:5556/dex";
const second = "http://127.0.0.1:5557/dex";
const password = process.env.OIDC_DEV_PASSWORD;
if (!password) throw new Error("OIDC_DEV_PASSWORD is required");

async function tokenFor(issuer) {
  process.env.OIDC_ISSUER = issuer;
  const { login } = await import(
    `./oidc-login.mjs?issuer=${encodeURIComponent(issuer)}`
  );
  return (await login({ email: "alice@greenguard.test", password }))
    .access_token;
}

const a = await tokenFor(first);
const b = await tokenFor(second);
const subjectOf = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
    .sub;
assert.equal(subjectOf(a), subjectOf(b));
const memberships = parseMemberships(
  JSON.stringify([
    {
      issuer: first,
      subject: subjectOf(a),
      tenantId: "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d",
      roles: ["admin"],
    },
    {
      issuer: second,
      subject: subjectOf(b),
      tenantId: "9b2c7d1e-3f4a-4b5c-8d6e-7f8091a2b3c4",
      roles: ["viewer"],
    },
  ]),
);
const verifier = createMultiIssuerVerifier(
  [
    {
      issuer: first,
      audience: "greenguard-dashboard",
      keys: { jwksUrl: `${first}/keys` },
    },
    {
      issuer: second,
      audience: "greenguard-dashboard",
      keys: { jwksUrl: `${second}/keys` },
    },
  ],
  membershipMapper(memberships),
);
const actualA = await verifier.verify(`Bearer ${a}`);
const actualB = await verifier.verify(`Bearer ${b}`);
assert.equal(actualA.issuer, first);
assert.equal(actualB.issuer, second);
assert.equal(actualA.principal.subject, actualB.principal.subject);
assert.notEqual(actualA.principal.tenantId, actualB.principal.tenantId);
assert.deepEqual(actualA.principal.roles, ["admin"]);
assert.deepEqual(actualB.principal.roles, ["viewer"]);
console.log(
  "S02: two live Dex issuers verified; same subject mapped to distinct tenants",
);
