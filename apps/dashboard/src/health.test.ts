import { afterEach, expect, test, vi } from "vitest";
import { checkHealth } from "./health";
afterEach(() => vi.unstubAllGlobals());
test("only matching ready responses are healthy", async () => {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ service: "device-service", status: "ready" }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ service: "other", status: "ready" })),
    )
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", mock);
  expect(await checkHealth("/readyz", "device-service")).toBe(true);
  for (let i = 0; i < 3; i++)
    expect(await checkHealth("/readyz", "device-service")).toBe(false);
});
