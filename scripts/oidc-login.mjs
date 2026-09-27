// Browser-less OIDC authorization code + PKCE login against the local Dex
// (ADR-0014). Validates state and nonce exactly as a browser client must.
// Tokens are returned to the caller and never printed.
import { createHash, randomBytes } from "node:crypto";

export const ISSUER = process.env.OIDC_ISSUER ?? "http://127.0.0.1:5556/dex";
const ORIGIN = new URL(ISSUER).origin;
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
export const decodeJwt = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

async function follow(url, init = {}) {
  const response = await fetch(new URL(url, ORIGIN), {
    ...init,
    redirect: "manual",
  });
  return response;
}

// Walk Dex redirects until the redirect_uri is reached; return its query.
async function walk(response, redirectUri) {
  let current = response;
  for (let hop = 0; hop < 10; hop++) {
    const location = current.headers.get("location");
    if (!location) return current;
    if (location.startsWith(redirectUri)) return new URL(location).searchParams;
    current = await follow(location);
  }
  throw new Error("too many redirects");
}

export async function login({
  email,
  password,
  clientId = "greenguard-dashboard",
  redirectUri = "http://127.0.0.1:5173/auth/callback",
}) {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const auth = new URL(`${ISSUER}/auth`);
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile offline_access",
    state,
    nonce,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  const form = await walk(await follow(auth), redirectUri);
  if (form instanceof URLSearchParams) throw new Error("unexpected redirect");
  const html = await form.text();
  const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1];
  const target = action
    ? action.replaceAll("&amp;", "&")
    : new URL(form.url).pathname;
  const posted = await follow(target, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: email, password }).toString(),
  });
  const query = await walk(posted, redirectUri);
  if (!(query instanceof URLSearchParams)) throw new Error("login failed");
  if (query.get("state") !== state) throw new Error("state mismatch");
  const token = await fetch(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (!token.ok) throw new Error(`token exchange failed: ${token.status}`);
  const tokens = await token.json();
  if (decodeJwt(tokens.id_token).nonce !== nonce)
    throw new Error("nonce mismatch");
  return tokens;
}

export async function refresh(refreshToken, clientId = "greenguard-dashboard") {
  const response = await fetch(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
  if (!response.ok) throw new Error(`refresh failed: ${response.status}`);
  return response.json();
}

if (process.argv[2] === "--subjects") {
  for (const user of ["alice", "victor", "bob"]) {
    const tokens = await login({
      email: `${user}@greenguard.test`,
      password: process.env.OIDC_DEV_PASSWORD,
    });
    const claims = decodeJwt(tokens.access_token);
    console.log(user, claims.sub, claims.aud, Object.keys(claims).join(","));
  }
}
