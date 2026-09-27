// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Provisioning } from "./ProvisioningPanel";
import type { ProvisioningApi } from "./provisioning";

test("validates physical sensor IDs before calling the command API", async () => {
  const start = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Provisioning
        api={
          {
            start,
            session: async () => ({
              subject: "operator",
              tenantId: "tenant-a",
              roles: ["operator"],
            }),
          } as unknown as ProvisioningApi
        }
        sessionId="test-user"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.type(
    await screen.findByRole(
      "textbox",
      { name: "Device ID" },
      { timeout: 5000 },
    ),
    "not-a-uuid",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Physical sensor asset ID" }),
    "22222222-2222-4222-8222-222222222222",
  );
  await user.click(screen.getByRole("button", { name: "Start provisioning" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Enter a valid device ID.",
  );
  expect(start).not.toHaveBeenCalled();
  client.clear();
});
