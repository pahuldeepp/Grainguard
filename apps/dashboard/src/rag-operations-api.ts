import type { AccessTokenProvider } from "./provisioning";

export const ragOperationsSections = [
  "overview",
  "retrieval",
  "documents",
  "evaluations",
  "cache",
  "traces",
] as const;

export type RagOperationsSection = (typeof ragOperationsSections)[number];

export class RagOperationsApi {
  constructor(
    private readonly getAccessToken: AccessTokenProvider,
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {}

  async snapshot(
    section: RagOperationsSection,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    if (!token) throw new Error("sign_in_required");
    const response = await this.fetcher(`/v1/rag/ops/${section}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(7000)])
        : AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      throw new Error(
        response.status === 403
          ? "operator_access_required"
          : "rag_ops_unavailable",
      );
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid_rag_ops_response");
    return value as Record<string, unknown>;
  }
}
