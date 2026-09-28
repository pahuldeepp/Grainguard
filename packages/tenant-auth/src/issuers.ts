import { decodeJwt, type JWTPayload } from "jose";
import {
  AuthError,
  createTokenVerifier,
  type Principal,
  type VerifierOptions,
} from "./index.js";

export type IssuerConfig = Omit<VerifierOptions, "mapIdentity">;

export interface VerifiedIdentity {
  issuer: string;
  principal: Principal;
}

// The decoded issuer only selects a configured verifier. No decoded claim is
// trusted until that verifier checks the signature, issuer and audience.
export function createMultiIssuerVerifier(
  issuers: IssuerConfig[],
  mapIdentity?: (payload: JWTPayload) => JWTPayload | undefined,
): { verify(header: string | undefined): Promise<VerifiedIdentity> } {
  if (issuers.length === 0) throw new Error("at least one issuer is required");
  const configured = new Map<string, ReturnType<typeof createTokenVerifier>>();
  for (const issuer of issuers) {
    if (!issuer.issuer || configured.has(issuer.issuer))
      throw new Error("issuer must be unique and nonempty");
    configured.set(
      issuer.issuer,
      createTokenVerifier({ ...issuer, mapIdentity }),
    );
  }
  return {
    async verify(header) {
      if (!header) throw new AuthError(401, "missing_token");
      const match = /^bearer (\S+)$/i.exec(header);
      if (!match) throw new AuthError(401, "malformed_header");
      let issuer: string | undefined;
      try {
        issuer = decodeJwt(match[1]!).iss;
      } catch {
        throw new AuthError(401, "invalid_token");
      }
      if (!issuer) throw new AuthError(401, "invalid_token");
      const verifier = configured.get(issuer);
      if (!verifier) throw new AuthError(401, "invalid_token");
      return { issuer, principal: await verifier.verify(header) };
    },
  };
}
