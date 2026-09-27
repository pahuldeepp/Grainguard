import {
  createTokenVerifier,
  type VerifierOptions,
} from "@greenguard/tenant-auth";
import {
  createMultiIssuerVerifier,
  type IssuerConfig,
} from "@greenguard/tenant-auth/issuers";
import type { Actor } from "../domain/store.js";

// Reserved, never assigned to an organization (organization IDs are name-based
// version-5 UUIDs; this one is version 4).
const IDENTITY_ONLY_TENANT = "ffffffff-ffff-4fff-bfff-ffffffffffff";

export type AuthOptions =
  Omit<VerifierOptions, "mapIdentity"> | { issuers: IssuerConfig[] };

export interface IdentityVerifier {
  verify(authorization: string | undefined): Promise<Actor>;
}

// The control plane authorizes from its own store, so it needs the verified
// identity only. Verification is @greenguard/tenant-auth's (signature, issuer,
// audience, expiry first); any IdP tenant_id/roles are overwritten and discarded.
// jwtVerify pins the issuer, so the principal's subject plus the configured issuer
// is the identity.
export function createIdentityVerifier(options: AuthOptions): IdentityVerifier {
  if ("issuers" in options) {
    const verifier = createMultiIssuerVerifier(options.issuers, (payload) => ({
      ...payload,
      tenant_id: IDENTITY_ONLY_TENANT,
      roles: ["viewer"],
    }));
    return {
      async verify(authorization) {
        const verified = await verifier.verify(authorization);
        return {
          issuer: verified.issuer,
          subject: verified.principal.subject,
          email: verified.principal.email,
          emailVerified: verified.principal.emailVerified,
        };
      },
    };
  }
  const verifier = createTokenVerifier({
    ...options,
    mapIdentity: (payload) => ({
      ...payload,
      tenant_id: IDENTITY_ONLY_TENANT,
      roles: ["viewer"],
    }),
  });
  return {
    async verify(authorization) {
      const principal = await verifier.verify(authorization);
      return {
        issuer: options.issuer,
        subject: principal.subject,
        email: principal.email,
        emailVerified: principal.emailVerified,
      };
    },
  };
}
