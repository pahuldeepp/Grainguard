import {
  configureStore,
  createSlice,
  type PayloadAction,
} from "@reduxjs/toolkit";

type UiState = {
  selectedSiteId: string | null;
  selectedDeviceId: string | null;
  showTechnicalDetails: boolean;
};

const initialState: UiState = {
  selectedSiteId: null,
  selectedDeviceId: null,
  showTechnicalDetails: true,
};

const ui = createSlice({
  name: "ui",
  initialState,
  reducers: {
    selectSite(state, action: PayloadAction<string | null>) {
      state.selectedSiteId = action.payload;
      state.selectedDeviceId = null;
    },
    selectDevice(state, action: PayloadAction<string | null>) {
      state.selectedDeviceId = action.payload;
    },
    toggleTechnicalDetails(state) {
      state.showTechnicalDetails = !state.showTechnicalDetails;
    },
    clearSessionSelections(state) {
      state.selectedSiteId = null;
      state.selectedDeviceId = null;
    },
  },
});

export const uiActions = ui.actions;

export function createDashboardStore() {
  return configureStore({ reducer: { ui: ui.reducer } });
}

export const dashboardStore = createDashboardStore();
export type DashboardState = ReturnType<typeof dashboardStore.getState>;
export type DashboardDispatch = typeof dashboardStore.dispatch;
