import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";

export interface SagaMtlsClient {
  fetcher: typeof fetch;
  close(): Promise<void>;
}

/** Keep client credentials scoped to the saga upstream, never the global dispatcher. */
export function createSagaMtlsClient(
  env: NodeJS.ProcessEnv,
  baseURL: string,
): SagaMtlsClient | null {
  const paths = [
    env.SAGA_MTLS_CA_FILE,
    env.SAGA_MTLS_CERT_FILE,
    env.SAGA_MTLS_KEY_FILE,
  ];
  if (paths.every((path) => !path)) return null;
  if (paths.some((path) => !path))
    throw new Error(
      "SAGA_MTLS_CA_FILE, SAGA_MTLS_CERT_FILE and SAGA_MTLS_KEY_FILE must be set together",
    );
  if (new URL(baseURL).protocol !== "https:")
    throw new Error("Saga mTLS requires an HTTPS SAGA_API_URL");
  const agent = new Agent({
    connect: {
      ca: readFileSync(paths[0]!),
      cert: readFileSync(paths[1]!),
      key: readFileSync(paths[2]!),
      rejectUnauthorized: true,
    },
    connections: 10,
  });
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as string | undefined,
      signal: init?.signal ?? undefined,
      dispatcher: agent,
      redirect: "error",
    }) as unknown as Promise<Response>) as typeof fetch;
  return { fetcher, close: () => agent.close() };
}
