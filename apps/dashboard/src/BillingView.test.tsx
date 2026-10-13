// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BillingView, billingPlans } from "./BillingView";

describe("BillingView checkout catalog", () => {
  it("offers only plan identifiers accepted by billing-service", async () => {
    const user = userEvent.setup();
    const checkout = vi
      .fn()
      .mockResolvedValue({ commandId: "cmd", status: "pending" });
    const api = {
      snapshot: vi.fn().mockResolvedValue({
        subscription: {
          status: "free",
          planKey: "free",
          entitlementPlanKey: "free",
        },
        usage: [],
      }),
      checkout,
      portal: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <BillingView api={api as never} sessionId="session" />
      </QueryClientProvider>,
    );

    for (const plan of billingPlans) {
      const heading = await screen.findByRole("heading", { name: plan.name });
      await user.click(
        within(heading.parentElement!).getByRole("button", {
          name: "Buy with Stripe",
        }),
      );
      await waitFor(() =>
        expect(checkout).toHaveBeenCalledWith(
          plan.key,
          window.location.href,
          window.location.href,
        ),
      );
      checkout.mockClear();
    }
    expect(billingPlans.map(({ key }) => key)).toEqual([
      "standard",
      "enterprise",
    ]);
    client.clear();
  });
});
