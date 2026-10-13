import type { CryptoDeps } from "./pkce.js";
import { IdentityChangedError } from "./session.js";
import type { Identity } from "./session.js";
import type { AccessGrant } from "./session.js";

export interface AccessSource {
  getAccessToken(options?: { force?: boolean }): Promise<AccessGrant>;
}

export interface GraphqlDeps {
  fetch: typeof fetch;
  crypto: CryptoDeps;
  timeoutMs?: number;
}

// status 0 means the request never reached the BFF (offline, timeout).
export class GraphqlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GraphqlError";
  }
}

interface GraphqlPayload<T> {
  data?: T;
  extensions?: { consistencyToken?: unknown };
  errors?: {
    message: string;
    extensions?: { code?: string; httpStatus?: number };
  }[];
}

const DEFAULT_TIMEOUT_MS = 8000;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class GraphqlClient {
  constructor(
    private readonly endpoint: string,
    private readonly session: AccessSource,
    private readonly deps: GraphqlDeps,
  ) {}

  async execute<T>(
    query: string,
    variables: Record<string, string | number>,
    expectedIdentity?: Identity,
    onWatermark?: (token: string) => void,
    deadline = Date.now() + (this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  ): Promise<T> {
    const hash = toHex(
      await this.deps.crypto.sha256(new TextEncoder().encode(query)),
    );
    let grant = await this.session.getAccessToken();
    const identity = expectedIdentity ?? grant;
    const requireIdentity = (value: AccessGrant) => {
      if (
        value.tenantId !== identity.tenantId ||
        value.subject !== identity.subject
      )
        throw new IdentityChangedError();
    };
    requireIdentity(grant);
    let response = await this.post(
      hash,
      variables,
      grant.accessToken,
      deadline,
    );
    if (response.status === 401) {
      // One forced refresh; a second 401 is the caller's re-login problem.
      grant = await this.session.getAccessToken({ force: true });
      requireIdentity(grant);
      response = await this.post(hash, variables, grant.accessToken, deadline);
    }
    return this.unwrap<T>(response, onWatermark);
  }

  private async post(
    hash: string,
    variables: Record<string, string | number>,
    accessToken: string,
    deadline: number,
  ): Promise<Response> {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new GraphqlError("read_timeout", 0, "read_timeout");
    try {
      return await this.deps.fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          variables,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        }),
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
      });
    } catch {
      throw new GraphqlError("Network request failed", 0);
    }
  }

  private async unwrap<T>(
    response: Response,
    onWatermark?: (token: string) => void,
  ): Promise<T> {
    if (!response.ok)
      throw new GraphqlError(
        `Request failed (${response.status})`,
        response.status,
      );
    const payload = (await response.json()) as GraphqlPayload<T>;
    const failure = payload.errors?.[0];
    if (failure)
      throw new GraphqlError(
        failure.message,
        failure.extensions?.httpStatus ?? 200,
        failure.extensions?.code,
      );
    if (!payload.data) throw new GraphqlError("Response has no data", 200);
    const token = payload.extensions?.consistencyToken;
    if (token != null && typeof token !== "string")
      throw new GraphqlError("invalid_consistency_response", 502);
    if (typeof token === "string") onWatermark?.(token);
    return payload.data;
  }
}
