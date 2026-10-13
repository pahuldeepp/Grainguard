import {
  SignJWT,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import { randomUUID } from "node:crypto";
import { AuthError, type Principal } from "./index.js";

export const delegatedScopes = {
  "grain-advisor": ["advisor:propose", "advisor:decide"],
  "greenguard-mcp": ["tools:read", "tools:propose"],
  "knowledge-service": ["knowledge:read"],
  "read-api": ["telemetry:read"],
  "workflow-alerts": ["alerts:read", "alerts:acknowledge"],
} as const;
export type DelegatedAudience = keyof typeof delegatedScopes;
export type DelegatedScope =
  (typeof delegatedScopes)[DelegatedAudience][number];
export type DelegatedActor = "grain-advisor" | "greenguard-mcp";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const delegatedClaims = new Set([
  "iss",
  "aud",
  "sub",
  "exp",
  "iat",
  "nbf",
  "jti",
  "tenant_id",
  "roles",
  "act",
  "scope",
  "token_use",
]);
const roles = new Set(["viewer", "operator", "admin"]);
const writeScopes = new Set([
  "advisor:propose",
  "advisor:decide",
  "tools:propose",
  "alerts:acknowledge",
]);

function validIssuer(value: string) {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validSelection(audience: string, scope: string) {
  return (
    Object.hasOwn(delegatedScopes, audience) &&
    (
      delegatedScopes[audience as DelegatedAudience] as readonly string[]
    ).includes(scope)
  );
}

export interface DelegatedPrincipal extends Principal {
  actor: DelegatedActor;
  audience: DelegatedAudience;
  scopes: DelegatedScope[];
  tokenId: string;
}

// The BFF supplies a freshly verified membership principal and stable control-
// plane identity ID. Model/tool arguments never supply any identity field.
export function createDelegatedSigner(options: {
  issuer: string;
  kid: string;
  privateKey: CryptoKey;
  identityId: (principal: Principal) => string;
  actor?: DelegatedActor;
  now?: () => Date;
  ttlSeconds?: number;
}) {
  const now = options.now ?? (() => new Date());
  const actor = options.actor ?? "grain-advisor";
  const ttl = options.ttlSeconds ?? 120;
  if (
    !validIssuer(options.issuer) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(options.kid) ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > 300
  )
    throw new Error("invalid delegation signer configuration");
  return {
    async mint(
      principal: Principal,
      audience: DelegatedAudience,
      scope: DelegatedScope,
    ) {
      const issued = Math.floor(now().getTime() / 1000);
      const expires = Math.min(
        issued + ttl,
        Math.floor(principal.expiresAt.getTime() / 1000),
      );
      const subject = options.identityId(principal);
      if (
        principal.principalType === "service" ||
        !principal.issuer ||
        !UUID.test(subject) ||
        !UUID.test(principal.tenantId) ||
        !validSelection(audience, scope) ||
        !principal.roles.length ||
        principal.roles.some((role) => !roles.has(role)) ||
        !Number.isSafeInteger(expires) ||
        expires <= issued
      )
        throw new AuthError(403, "invalid_claims");
      if (
        writeScopes.has(scope) &&
        !principal.roles.some((role) => role === "operator" || role === "admin")
      )
        throw new AuthError(403, "insufficient_role");
      return new SignJWT({
        tenant_id: principal.tenantId,
        roles: principal.roles,
        act: { sub: actor },
        scope,
        token_use: "delegated",
      })
        .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: options.kid })
        .setIssuer(options.issuer)
        .setSubject(subject)
        .setAudience(audience)
        .setIssuedAt(issued)
        .setNotBefore(issued)
        .setExpirationTime(expires)
        .setJti(randomUUID())
        .sign(options.privateKey);
    },
  };
}

export function createDelegatedVerifier(options: {
  issuer: string;
  audience: DelegatedAudience;
  keys: JWTVerifyGetKey;
  requiredScope: DelegatedScope;
  actor?: DelegatedActor;
  now?: () => Date;
  // Current membership is authoritative. Callback must fail closed on outage.
  membership: (
    tenantId: string,
    userId: string,
  ) => Promise<readonly string[] | null>;
}) {
  if (
    !validIssuer(options.issuer) ||
    !validSelection(options.audience, options.requiredScope)
  )
    throw new Error("invalid delegated scope configuration");
  return {
    async verify(header: string | undefined): Promise<DelegatedPrincipal> {
      const match = /^Bearer ([^\s]{1,16384})$/i.exec(header ?? "");
      if (!match) throw new AuthError(401, "invalid_token");
      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(match[1], options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ["RS256"],
          typ: "at+jwt",
          currentDate: options.now?.(),
          clockTolerance: 0,
          requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nbf", "jti"],
        });
        payload = verified.payload;
        const h = verified.protectedHeader;
        if (
          Object.keys(h).some((key) => !["alg", "typ", "kid"].includes(key)) ||
          typeof h.kid !== "string" ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(h.kid) ||
          Object.keys(payload).some((key) => !delegatedClaims.has(key)) ||
          payload.aud !== options.audience ||
          payload.token_use !== "delegated" ||
          payload.scope !== options.requiredScope ||
          !payload.act ||
          typeof payload.act !== "object" ||
          Array.isArray(payload.act) ||
          Object.keys(payload.act).length !== 1 ||
          (payload.act as { sub?: unknown }).sub !==
            (options.actor ?? "grain-advisor") ||
          typeof payload.sub !== "string" ||
          !UUID.test(payload.sub) ||
          typeof payload.tenant_id !== "string" ||
          !UUID.test(payload.tenant_id) ||
          typeof payload.jti !== "string" ||
          !UUID.test(payload.jti) ||
          !Number.isSafeInteger(payload.iat) ||
          !Number.isSafeInteger(payload.exp) ||
          !Number.isSafeInteger(payload.nbf) ||
          payload.exp! - payload.iat! <= 0 ||
          payload.exp! - payload.iat! > 300 ||
          payload.nbf !== payload.iat ||
          !Array.isArray(payload.roles) ||
          !payload.roles.length ||
          payload.roles.some((role) => !roles.has(role as string))
        )
          throw new Error("invalid delegated claims");
      } catch {
        throw new AuthError(401, "invalid_token");
      }
      let current: readonly string[] | null;
      try {
        current = await options.membership(
          payload.tenant_id as string,
          payload.sub!,
        );
      } catch {
        throw new AuthError(503, "auth_unavailable");
      }
      if (
        Math.floor((options.now?.() ?? new Date()).getTime() / 1000) >=
        payload.exp!
      )
        throw new AuthError(401, "expired_token");
      if (!current || !current.length)
        throw new AuthError(403, "insufficient_role");
      if (current.some((role) => role !== "device" && !roles.has(role)))
        throw new AuthError(503, "auth_unavailable");
      const effective = (payload.roles as string[]).filter((role) =>
        current!.includes(role),
      );
      if (
        !effective.length ||
        (writeScopes.has(options.requiredScope) &&
          !effective.some((role) => role === "operator" || role === "admin"))
      )
        throw new AuthError(403, "insufficient_role");
      return {
        issuer: options.issuer,
        subject: payload.sub!,
        tenantId: payload.tenant_id as string,
        roles: effective as Principal["roles"],
        expiresAt: new Date(payload.exp! * 1000),
        actor: options.actor ?? "grain-advisor",
        audience: options.audience,
        scopes: [options.requiredScope],
        tokenId: payload.jti!,
      };
    },
  };
}

// Loading is done by the BFF from its protected secret file; never accept PEM
// through request bodies. jose is already pinned by this package.
export async function createDelegatedSignerFromPem(
  options: Omit<Parameters<typeof createDelegatedSigner>[0], "privateKey"> & {
    privatePem: string;
  },
) {
  const { importPKCS8 } = await import("jose");
  const key = await importPKCS8(options.privatePem, "RS256");
  const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
  if (algorithm.name !== "RSASSA-PKCS1-v1_5" || algorithm.modulusLength < 2048)
    throw new Error("RSA delegation key required");
  return createDelegatedSigner({ ...options, privateKey: key });
}
