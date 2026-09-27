import { expect, test } from "vitest";
import { createDashboardStore, uiActions } from "./dashboard-state";

test("site changes clear client selection without storing API responses", () => {
  const store = createDashboardStore();
  store.dispatch(uiActions.selectSite("site-a"));
  store.dispatch(uiActions.selectDevice("device-a"));
  expect(store.getState().ui.selectedDeviceId).toBe("device-a");
  store.dispatch(uiActions.selectSite("site-b"));
  expect(store.getState().ui).toMatchObject({
    selectedSiteId: "site-b",
    selectedDeviceId: null,
  });
  store.dispatch(uiActions.clearSessionSelections());
  expect(store.getState().ui.selectedSiteId).toBeNull();
});
