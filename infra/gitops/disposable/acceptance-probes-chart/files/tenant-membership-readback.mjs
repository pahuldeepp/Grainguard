import { createPublicKey, verify as verifySignature } from "node:crypto";

const required = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`required probe setting is missing: ${name}`);
  }
  return value;
};

const decodePart = (value) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("access token is malformed");
  return Buffer.from(value, "base64url");
};

const issuer = required("DEX_ISSUER").replace(/\/+$/, "");
const audience = required("MEMBERSHIP_AUDIENCE");
const token = required("GREENGUARD_ACCESS_TOKEN");
const issuerUrl = new URL(issuer);
if (issuerUrl.protocol !== "https:" || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) {
  throw new Error("configured OIDC issuer must be an HTTPS URL without credentials or query parameters");
}
const jwksUrl = `${issuer}/keys`;
const pieces = token.split(".");
if (pieces.length !== 3) throw new Error("access token is not a signed JWT");

let header;
let claims;
let signature;
try {
  header = JSON.parse(decodePart(pieces[0]));
  claims = JSON.parse(decodePart(pieces[1]));
  signature = decodePart(pieces[2]);
} catch {
  throw new Error("access token is malformed");
}
if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
  throw new Error("access token signing algorithm or key ID is unsupported");
}
if ((header.typ !== undefined && header.typ !== "JWT") ||
    (header.crit !== undefined && (!Array.isArray(header.crit) || header.crit.length > 0))) {
  throw new Error("access token contains unsupported JOSE header parameters");
}

const readJsonBounded = async (response, maximumBytes, errorMessage) => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(errorMessage);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new Error(errorMessage);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(errorMessage);
  }
};

let jwksResponse;
try {
  jwksResponse = await fetch(jwksUrl, {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
} catch {
  throw new Error("OIDC issuer signing keys could not be fetched over HTTPS");
}
if (!jwksResponse.ok || jwksResponse.url !== jwksUrl) {
  throw new Error("OIDC issuer signing keys are unavailable or redirected");
}
const jwks = await readJsonBounded(jwksResponse, 256 * 1024, "OIDC issuer signing keys are malformed or oversized");
const candidates = Array.isArray(jwks?.keys)
  ? jwks.keys.filter((key) => key?.kid === header.kid)
  : [];
if (candidates.length !== 1) throw new Error("OIDC issuer key ID is missing or ambiguous");
const jwk = candidates[0];
if (jwk.kty !== "RSA" || (jwk.use && jwk.use !== "sig") || (jwk.alg && jwk.alg !== "RS256") ||
    (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify"))) ||
    typeof jwk.n !== "string" || typeof jwk.e !== "string") {
  throw new Error("OIDC issuer key is not an approved RSA signing key");
}
let publicKey;
try {
  publicKey = createPublicKey({ key: jwk, format: "jwk" });
} catch {
  throw new Error("OIDC issuer public key is malformed");
}
if (publicKey.asymmetricKeyDetails?.modulusLength < 2048) {
  throw new Error("OIDC issuer RSA signing key is below the minimum strength");
}
if (!verifySignature("RSA-SHA256", Buffer.from(`${pieces[0]}.${pieces[1]}`), publicKey, signature)) {
  throw new Error("access token signature does not match the OIDC issuer JWKS");
}

const now = Math.floor(Date.now() / 1000);
const tokenAudiences = typeof claims?.aud === "string" ? [claims.aud] : claims?.aud;
if (claims?.iss !== issuer || !Array.isArray(tokenAudiences) || !tokenAudiences.includes(audience) ||
    !Number.isSafeInteger(claims.exp) || claims.exp <= now ||
    (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)) ||
    typeof claims.sub !== "string" || claims.sub.length === 0) {
  throw new Error("verified access token issuer, audience, lifetime or subject is invalid");
}
// Only the subject from the signature-verified token is used for membership lookup.
const subject = claims.sub;

const lookupBase = process.env.MEMBERSHIP_LOOKUP_URL ??
  "http://tenant-control-plane.greenguard.svc.cluster.local:3010/v1/internal/memberships";
const endpoint = new URL(lookupBase);
endpoint.searchParams.set("issuer", issuer);
endpoint.searchParams.set("subject", subject);
let response;
try {
  response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${required("CONTROL_LOOKUP_TOKEN")}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
} catch {
  throw new Error("tenant membership read-back request failed");
}
if (!response.ok || response.url !== endpoint.href) {
  throw new Error(`tenant membership lookup returned HTTP ${response.status}`);
}

const membership = await readJsonBounded(response, 32 * 1024, "tenant membership read-back response is malformed or oversized");
if (
  typeof membership !== "object" || membership === null ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(membership.tenantId ?? "") ||
  membership.state !== "active" ||
  !Array.isArray(membership.roles) || !membership.roles.includes("admin") ||
  typeof membership.version !== "string" || !/^[1-9][0-9]*$/.test(membership.version)
) {
  throw new Error("tenant membership read-back did not return an active admin membership");
}

// Tenant ID and identity claims are deliberately omitted from the retained Job log.
console.log(`PASS tenant-membership-readback state=active role=admin version=${membership.version}`);
