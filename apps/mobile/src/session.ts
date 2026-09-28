import { decodeClaims } from "./jwt.js";
import { exchangeCode, OidcError, refreshTokens } from "./oidc.js";
import type { OidcConfig, TokenSet } from "./oidc.js";
import {
  buildAuthorizationUrl,
  createPkceRequest,
  parseCallback,
} from "./pkce.js";
import type { CryptoDeps, PkceRequest } from "./pkce.js";
import type { SecureStore } from "./secure-store.js";

export interface Identity {
  tenantId: string;
  subject: string;
}

export interface AccessGrant extends Identity {
  accessToken: string;
}

export type ClearReason = "sign-out" | "tenant-switch" | "identity-change";

export class ReloginRequiredError extends Error {
  constructor() {
    super("Sign-in required");
    this.name = "ReloginRequiredError";
  }
}

export class IdentityChangedError extends Error {
  constructor() {
    super("Signed-in identity differs from the one that queued the command");
    this.name = "IdentityChangedError";
  }
}

export interface SessionDeps {
  fetch: typeof fetch;
  now: () => number;
  crypto: CryptoDeps;
  refreshSkewMs?: number;
  // Cognito/Dex tokens contain no authoritative GreenGuard tenant. Resolve it
  // through the BFF's verified session before using tenant-scoped local state.
  resolveMembership?: (accessToken: string) => Promise<Identity>;
}

const TOKENS_KEY = "greenguard.mobile.tokens.v1";
const PENDING_KEY = "greenguard.mobile.pkce.v1";
const DEFAULT_SKEW_MS = 30_000;

function identityOf(tokens: TokenSet): Identity {
  const claims = decodeClaims(tokens.accessToken);
  const { tenant_id: tenantClaim, sub, iss } = claims;
  if (typeof sub !== "string" || !sub) throw new Error("Token has no subject");
  if (typeof tenantClaim === "string" && tenantClaim)
    return { tenantId: tenantClaim, subject: sub };
  // The local IdP (Dex) issues no tenant claim: GreenGuard maps membership to a
  // tenant server side (ADR-0014). The BFF stays the authority; this value only
  // scopes local caches and queues per user, and is never sent as a tenant.
  if (typeof iss === "string" && iss)
    return { tenantId: `unresolved@${iss}`, subject: sub };
  throw new Error("Token has no tenant claim");
}

// Tokens and the PKCE material live only in the injected SecureStore (Keychain
// or Keystore in the React Native shell), never in plain storage.
export class MobileSession {
  private refreshing: Promise<TokenSet> | null = null;
  private readonly clearListeners: ((reason: ClearReason) => void)[] = [];
  private readonly reloginListeners: (() => void)[] = [];

  constructor(
    private readonly config: OidcConfig,
    private readonly store: SecureStore,
    private readonly deps: SessionDeps,
  ) {}

  onCleared(listener: (reason: ClearReason) => void): void {
    this.clearListeners.push(listener);
  }

  onReloginRequired(listener: () => void): void {
    this.reloginListeners.push(listener);
  }

  async beginSignIn(): Promise<string> {
    const request = await createPkceRequest(this.deps.crypto);
    await this.store.setItem(PENDING_KEY, JSON.stringify(request));
    return buildAuthorizationUrl(this.config, request);
  }

  async completeSignIn(callbackUrl: string): Promise<Identity> {
    const raw = await this.store.getItem(PENDING_KEY);
    if (!raw) throw new Error("No sign-in in progress");
    // Single use: a replayed or forged callback can never reuse the verifier.
    await this.store.removeItem(PENDING_KEY);
    const pending = JSON.parse(raw) as PkceRequest;
    const code = parseCallback(callbackUrl, pending.state);
    const tokens = await exchangeCode(
      this.config,
      { code, verifier: pending.verifier, nonce: pending.nonce },
      this.deps,
    );
    const identity = await this.identityFor(tokens);
    tokens.resolvedIdentity = identity;
    const previous = await this.identity();
    await this.store.setItem(TOKENS_KEY, JSON.stringify(tokens));
    if (previous && !sameIdentity(previous, identity))
      this.emitCleared("identity-change");
    return identity;
  }

  async identity(): Promise<Identity | null> {
    const tokens = await this.load();
    return tokens ? this.identityFor(tokens) : null;
  }

  async getAccessToken(
    options: { force?: boolean } = {},
  ): Promise<AccessGrant> {
    let tokens = await this.load();
    if (!tokens) throw new ReloginRequiredError();
    const skew = this.deps.refreshSkewMs ?? DEFAULT_SKEW_MS;
    if (options.force || tokens.expiresAt - skew <= this.deps.now())
      tokens = await this.refresh(tokens);
    return { accessToken: tokens.accessToken, ...await this.identityFor(tokens) };
  }

  async signOut(): Promise<void> {
    await this.dropTokens();
    this.emitCleared("sign-out");
  }

  async switchTenant(): Promise<string> {
    await this.dropTokens();
    this.emitCleared("tenant-switch");
    return this.beginSignIn();
  }

  private refresh(tokens: TokenSet): Promise<TokenSet> {
    this.refreshing ??= this.runRefresh(tokens).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) return this.requireRelogin();
    try {
      const renewed = await refreshTokens(
        this.config,
        tokens.refreshToken,
        this.deps,
      );
      renewed.resolvedIdentity = await this.identityFor(renewed);
      await this.store.setItem(TOKENS_KEY, JSON.stringify(renewed));
      return renewed;
    } catch (error) {
      if (error instanceof OidcError && error.transient) throw error;
      return this.requireRelogin();
    }
  }

  private async requireRelogin(): Promise<never> {
    await this.dropTokens();
    for (const listener of this.reloginListeners) listener();
    throw new ReloginRequiredError();
  }

  private async load(): Promise<TokenSet | null> {
    const raw = await this.store.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as TokenSet) : null;
  }

  private async identityFor(tokens: TokenSet): Promise<Identity> {
    const claimed = identityOf(tokens);
    if (tokens.resolvedIdentity) {
      if (tokens.resolvedIdentity.subject !== claimed.subject ||
          !tokens.resolvedIdentity.tenantId ||
          tokens.resolvedIdentity.tenantId.startsWith("unresolved@"))
        throw new Error("Stored tenant membership does not match the token");
      return tokens.resolvedIdentity;
    }
    if (!claimed.tenantId.startsWith("unresolved@")) return claimed;
    if (!this.deps.resolveMembership)
      throw new Error("Tenant membership must be resolved by the BFF");
    const verified = await this.deps.resolveMembership(tokens.accessToken);
    if (!verified.tenantId || verified.tenantId.startsWith("unresolved@") ||
        verified.subject !== claimed.subject)
      throw new Error("BFF session does not match the signed-in identity");
    return verified;
  }

  private dropTokens(): Promise<void> {
    return this.store.removeItem(TOKENS_KEY);
  }

  private emitCleared(reason: ClearReason): void {
    for (const listener of this.clearListeners) listener(reason);
  }
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.tenantId === b.tenantId && a.subject === b.subject;
}
