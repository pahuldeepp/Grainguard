export interface CryptoDeps {
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  randomUUID(): string;
}

export interface PkceRequest {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
}

export interface AuthorizationConfig {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  audience?: string;
}

const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

export function defaultCrypto(): CryptoDeps {
  const webCrypto = globalThis.crypto;
  return {
    randomBytes: (length) => webCrypto.getRandomValues(new Uint8Array(length)),
    sha256: async (data) =>
      new Uint8Array(
        await webCrypto.subtle.digest("SHA-256", data as BufferSource),
      ),
    randomUUID: () => webCrypto.randomUUID(),
  };
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function challengeFor(
  verifier: string,
  crypto: CryptoDeps,
): Promise<string> {
  const digest = await crypto.sha256(new TextEncoder().encode(verifier));
  return base64Url(digest);
}

export async function createPkceRequest(
  crypto: CryptoDeps,
): Promise<PkceRequest> {
  const verifier = base64Url(crypto.randomBytes(VERIFIER_BYTES));
  return {
    verifier,
    challenge: await challengeFor(verifier, crypto),
    state: base64Url(crypto.randomBytes(STATE_BYTES)),
    nonce: base64Url(crypto.randomBytes(STATE_BYTES)),
  };
}

export function buildAuthorizationUrl(
  config: AuthorizationConfig,
  request: PkceRequest,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
  });
  if (config.audience) params.set("audience", config.audience);
  return `${config.authorizationEndpoint}?${params}`;
}

export function parseCallback(callbackUrl: string, expectedState: string) {
  const params = new URL(callbackUrl).searchParams;
  if (params.get("state") !== expectedState)
    throw new Error("Authorization state mismatch");
  const error = params.get("error");
  if (error) throw new Error(`Authorization failed: ${error}`);
  const code = params.get("code");
  if (!code) throw new Error("Authorization response has no code");
  return code;
}
