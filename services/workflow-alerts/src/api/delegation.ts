import { readFileSync } from "node:fs";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JSONWebKeySet,
} from "jose";
import { AuthError } from "@greenguard/tenant-auth";
import { createDelegatedVerifier } from "@greenguard/tenant-auth/delegated";
import type { OwnershipConfig } from "./ownership.js";
import type { Verifier } from "./auth.js";

export function alertsDelegation(
  env: NodeJS.ProcessEnv,
  ownership?: OwnershipConfig,
): Verifier | undefined {
  if (
    !env.DELEGATED_ISSUER &&
    !env.DELEGATED_JWKS_FILE &&
    !env.DELEGATED_JWKS_URL
  )
    return undefined;
  if (
    !env.DELEGATED_ISSUER ||
    !ownership ||
    !!env.DELEGATED_JWKS_FILE === !!env.DELEGATED_JWKS_URL
  )
    throw new Error(
      "Alerts delegated auth requires issuer, exactly one key source, and ownership membership configuration",
    );
  const keys = env.DELEGATED_JWKS_FILE
    ? (() => {
        const data = readFileSync(env.DELEGATED_JWKS_FILE!);
        if (data.length > 16384)
          throw new Error("delegated public keys too large");
        const value = JSON.parse(data.toString("utf8")) as JSONWebKeySet;
        if (
          !Array.isArray(value.keys) ||
          value.keys.length < 1 ||
          value.keys.length > 8 ||
          value.keys.some((k) =>
            ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(
              (field) => field in k,
            ),
          )
        )
          throw new Error("invalid delegated public key set");
        return createLocalJWKSet(value);
      })()
    : (() => {
        const url = new URL(env.DELEGATED_JWKS_URL!);
        if (
          url.username ||
          url.password ||
          url.hash ||
          url.search ||
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
            ))
        )
          throw new Error("unsafe delegated key URL");
        return createRemoteJWKSet(url, { timeoutDuration: 2000 });
      })();
  const membership = async (tenantId: string, identityId: string) => {
    const url = new URL(
      "/v1/internal/delegated-memberships",
      ownership.membershipUrl,
    );
    url.search = new URLSearchParams({ tenantId, identityId }).toString();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${ownership.membershipToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("membership unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing membership");
    const blocks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 8192) throw new Error("membership response too large");
        blocks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const value = JSON.parse(Buffer.concat(blocks).toString("utf8"));
    if (
      value.tenantId !== tenantId ||
      value.identityId !== identityId ||
      value.state !== "active" ||
      !Array.isArray(value.roles)
    )
      throw new Error("invalid current membership");
    return value.roles as string[];
  };
  const read = createDelegatedVerifier({
    issuer: env.DELEGATED_ISSUER,
    audience: "workflow-alerts",
    keys,
    requiredScope: "alerts:read",
    actor: "greenguard-mcp",
    membership,
  });
  const write = createDelegatedVerifier({
    issuer: env.DELEGATED_ISSUER,
    audience: "workflow-alerts",
    keys,
    requiredScope: "alerts:acknowledge",
    membership,
  });
  return {
    verify: async (header) => {
      try {
        return {
          ...(await write.verify(header)),
          issuer: env.DELEGATED_ISSUER!,
        };
      } catch (error) {
        if (error instanceof AuthError && error.status === 401)
          return {
            ...(await read.verify(header)),
            issuer: env.DELEGATED_ISSUER!,
          };
        throw error;
      }
    },
  };
}
