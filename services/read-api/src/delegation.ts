import { readFileSync } from "node:fs";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JSONWebKeySet,
} from "jose";
import { createDelegatedVerifier } from "@greenguard/tenant-auth/delegated";
import type { Principal } from "@greenguard/tenant-auth";

export function readDelegation(
  env: NodeJS.ProcessEnv,
): { verify(header: string | undefined): Promise<Principal> } | undefined {
  if (
    !env.DELEGATED_ISSUER &&
    !env.DELEGATED_JWKS_FILE &&
    !env.DELEGATED_JWKS_URL
  )
    return undefined;
  if (
    !env.DELEGATED_ISSUER ||
    !env.DELEGATED_CONTROL_URL ||
    !env.DELEGATED_CONTROL_TOKEN ||
    !!env.DELEGATED_JWKS_FILE === !!env.DELEGATED_JWKS_URL
  )
    throw new Error(
      "Read delegated auth requires issuer, one public key source and current membership configuration",
    );
  const control = new URL(env.DELEGATED_CONTROL_URL);
  if (
    control.username ||
    control.password ||
    control.hash ||
    control.search ||
    (control.protocol !== "https:" &&
      !(
        control.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(control.hostname)
      ))
  )
    throw new Error("unsafe delegated membership URL");
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
      env.DELEGATED_CONTROL_URL,
    );
    url.search = new URLSearchParams({ tenantId, identityId }).toString();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.DELEGATED_CONTROL_TOKEN!}` },
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
  return createDelegatedVerifier({
    issuer: env.DELEGATED_ISSUER,
    audience: "read-api",
    keys,
    requiredScope: "telemetry:read",
    actor: "greenguard-mcp",
    membership,
  });
}
