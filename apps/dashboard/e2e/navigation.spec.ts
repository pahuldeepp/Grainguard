import { expect, test } from "@playwright/test";

test("navigates to provisioning without exposing controls before sign-in", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.getByRole("link", { name: "Provisioning" }).click();
  await expect(page).toHaveURL(/\/provisioning$/);
  await expect(
    page.getByText(
      "Sign-in integration is required to start or view provisioning.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start provisioning" }),
  ).toHaveCount(0);
});
