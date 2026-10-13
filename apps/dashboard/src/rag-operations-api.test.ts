import { afterEach, expect, test, vi } from "vitest";
import { RagOperationsApi } from "./rag-operations-api";

afterEach(() => vi.unstubAllGlobals());

test("sends the authenticated no-store request to the selected RAG section", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ health: "ready" }), { status: 200 }),
  );
  const api = new RagOperationsApi(async () => "access-token", fetcher);
  await expect(api.snapshot("overview")).resolves.toEqual({ health: "ready" });
  expect(fetcher).toHaveBeenCalledWith(
    "/v1/rag/ops/overview",
    expect.objectContaining({
      cache: "no-store",
      headers: {
        Authorization: "Bearer access-token",
        Accept: "application/json",
      },
    }),
  );
});

test("rejects access denial and malformed telemetry responses", async () => {
  const denied = new RagOperationsApi(
    async () => "token",
    async () => new Response("", { status: 403 }),
  );
  await expect(denied.snapshot("documents")).rejects.toThrow(
    "operator_access_required",
  );

  const malformed = new RagOperationsApi(
    async () => "token",
    async () => new Response("[]", { status: 200 }),
  );
  await expect(malformed.snapshot("traces")).rejects.toThrow(
    "invalid_rag_ops_response",
  );
});

test("calls the default browser fetch with its global receiver", async () => {
  vi.stubGlobal("fetch", function (this: unknown) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(
      new Response(JSON.stringify({ health: "ready" }), { status: 200 }),
    );
  });
  await expect(
    new RagOperationsApi(async () => "token").snapshot("overview"),
  ).resolves.toEqual({ health: "ready" });
});

test("retains timeout and caller cancellation together", async () => {
  const caller = new AbortController();
  const timeout = new AbortController();
  const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  let signal: AbortSignal | null | undefined;
  const api = new RagOperationsApi(
    async () => "token",
    async (_url, init) => {
      signal = init?.signal;
      return new Response("{}", { status: 200 });
    },
  );
  try {
    await api.snapshot("cache", caller.signal);
    expect(signal).not.toBe(caller.signal);
    expect(spy).toHaveBeenCalledWith(7000);
    timeout.abort();
    expect(signal?.aborted).toBe(true);
    await api.snapshot("evaluations", caller.signal);
    caller.abort();
    expect(signal?.aborted).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
