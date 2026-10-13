export class GraphqlOperationError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

import type { AccessTokenProvider } from "./provisioning";

export async function operationHash(query: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(query),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function executeOperation<T>(
  getAccessToken: AccessTokenProvider,
  query: string,
  variables: Record<string, string | number>,
  messages: { signIn: string; request: string; empty: string },
  onWatermark?: (token: string) => void,
  deadline = Date.now() + 8000,
  isCurrent?: () => boolean,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const token = await getAccessToken();
  signal?.throwIfAborted();
  if (isCurrent && !isCurrent())
    throw new GraphqlOperationError("session_changed");
  if (!token) throw new Error(messages.signIn);
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new GraphqlOperationError("read_timeout", "read_timeout", 504);
  const response = await fetch("/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      variables,
      extensions: {
        persistedQuery: { version: 1, sha256Hash: await operationHash(query) },
      },
    }),
    signal: signal
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
        ])
      : AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
  });
  signal?.throwIfAborted();
  if (!response.ok)
    throw new Error(`${messages.request} (${response.status}).`);
  const payload = (await response.json()) as {
    data?: T;
    extensions?: { consistencyToken?: unknown };
    errors?: {
      message: string;
      extensions?: { code?: string; httpStatus?: number };
    }[];
  };
  signal?.throwIfAborted();
  if (payload.errors?.length)
    throw new GraphqlOperationError(
      payload.errors[0].extensions?.code ?? payload.errors[0].message,
      payload.errors[0].extensions?.code,
      payload.errors[0].extensions?.httpStatus,
    );
  if (!payload.data) throw new Error(messages.empty);
  const responseToken = payload.extensions?.consistencyToken;
  if (responseToken != null && typeof responseToken !== "string")
    throw new Error("invalid_consistency_response");
  if (typeof responseToken === "string") onWatermark?.(responseToken);
  return payload.data;
}
