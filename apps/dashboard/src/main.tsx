import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AuthGate } from "./AuthGate";
import { DashboardProviders } from "./DashboardProviders";
import { loadPublicOidcConfig } from "./public-config";
import "./style.css";
if (import.meta.env.PROD) {
  try {
    await loadPublicOidcConfig();
  } catch {
    document.getElementById("root")!.textContent =
      "GreenGuard sign-in configuration is unavailable. Try again later.";
    throw new Error("Public OIDC configuration unavailable");
  }
}
if (import.meta.env.VITE_SENTRY_DSN) {
  const { startFrontendMonitoring } = await import("./monitoring");
  startFrontendMonitoring(
    import.meta.env.VITE_SENTRY_DSN,
    import.meta.env.MODE,
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DashboardProviders>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </DashboardProviders>
  </StrictMode>,
);
