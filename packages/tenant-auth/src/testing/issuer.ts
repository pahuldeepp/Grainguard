import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";

export interface SignOptions {
  expiresInSec?: number;
  kid?: string;
  issuer?: string;
  audience?: string;
  notBeforeSec?: number;
}

export const TEST_TENANT_ID = "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d";

interface KeyEntry {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
  publicPem: string;
}

async function newKey(kid: string): Promise<KeyEntry> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  };
  return { kid, privateKey, publicJwk, publicPem: await exportSPKI(publicKey) };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export async function createTestIssuer(
  config: { issuer?: string; audience?: string } = {},
) {
  const issuer = config.issuer ?? "https://issuer.test";
  const audience = config.audience ?? "greenguard-api";
  const entries: KeyEntry[] = [await newKey("test-key-1")];

  const current = (): KeyEntry => entries[entries.length - 1];
  const jwks = (): JSONWebKeySet => ({ keys: entries.map((e) => e.publicJwk) });

  const claimsFor = (
    claims: Record<string, unknown>,
    options: SignOptions,
  ) => ({
    tenant_id: TEST_TENANT_ID,
    roles: ["viewer"],
    sub: "user-1",
    iss: options.issuer ?? issuer,
    aud: options.audience ?? audience,
    iat: nowSec(),
    exp: nowSec() + (options.expiresInSec ?? 300),
    ...(options.notBeforeSec === undefined
      ? {}
      : { nbf: nowSec() + options.notBeforeSec }),
    ...claims,
  });

  const base64url = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const api = {
    issuer,
    audience,
    get jwks(): JSONWebKeySet {
      return jwks();
    },
    getKey: ((header, token) =>
      createLocalJWKSet(jwks())(header, token)) as JWTVerifyGetKey,
    async rotate(): Promise<string> {
      const entry = await newKey(`test-key-${entries.length + 1}`);
      entries.push(entry);
      return entry.kid;
    },
    async sign(
      claims: Record<string, unknown> = {},
      options: SignOptions = {},
    ): Promise<string> {
      return new SignJWT(claimsFor(claims, options))
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? current().kid })
        .sign(current().privateKey);
    },
    async signHs256WithPublicKey(
      claims: Record<string, unknown> = {},
    ): Promise<string> {
      const secret = new TextEncoder().encode(current().publicPem);
      return new SignJWT(claimsFor(claims, {}))
        .setProtectedHeader({ alg: "HS256", kid: current().kid })
        .sign(secret);
    },
    signNone(claims: Record<string, unknown> = {}): string {
      return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claimsFor(claims, {}))}.`;
    },
    async serveJwks() {
      let count = 0;
      const server: Server = createServer((_req, res) => {
        count += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(jwks()));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const { port } = server.address() as AddressInfo;
      return {
        url: `http://127.0.0.1:${port}/jwks.json`,
        requests: (): number => count,
        rotate: api.rotate,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      };
    },
  };
  return api;
}

export type TestIssuer = Awaited<ReturnType<typeof createTestIssuer>>;
