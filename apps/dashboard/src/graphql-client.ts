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
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error(messages.signIn);
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
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw new Error(`${messages.request} (${response.status}).`);
  const payload = (await response.json()) as {
    data?: T;
    errors?: { message: string; extensions?: { code?: string } }[];
  };
  if (payload.errors?.length)
    throw new Error(
      payload.errors[0].extensions?.code ?? payload.errors[0].message,
    );
  if (!payload.data) throw new Error(messages.empty);
  return payload.data;
}
