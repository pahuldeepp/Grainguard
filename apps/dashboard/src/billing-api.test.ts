// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingApi } from "./billing-api";

afterEach(() => vi.unstubAllGlobals());

describe("BillingApi checkout polling", () => {
  it("surfaces terminal Stripe command failures instead of silently staying on the page", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              startBillingCheckout: { commandId: "cmd-1", status: "pending" },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { billingCommand: { commandId: "cmd-1", status: "failed" } },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(
      new BillingApi(async () => "access-token").checkout(
        "standard",
        "http://127.0.0.1:5173/billing",
        "http://127.0.0.1:5173/billing",
      ),
    ).rejects.toThrow("Stripe could not complete the checkout");
  });
});
