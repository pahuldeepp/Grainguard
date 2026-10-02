import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Link, NavLink, Route, Routes } from "react-router";
import { checkHealth } from "./health";
import { ProvisioningApi, type AccessTokenProvider } from "./provisioning";
import { ReadApi } from "./read-api";
import { AlertsApi } from "./alerts-api";
import { MlApi } from "./ml-api";
import { BillingApi } from "./billing-api";
import { type DashboardState, uiActions } from "./dashboard-state";
import { AlertSummary } from "./AlertSummary";
import { useOnline } from "./online";
import { Banner, Glyph, Loading, NavIcon, PageHeader } from "./ui";

// Routes load on demand; Provisioning alone pulls in react-hook-form and zod.
const Provisioning = lazy(() =>
  import("./ProvisioningPanel").then((m) => ({ default: m.Provisioning })),
);
const AlertsView = lazy(() =>
  import("./AlertsView").then((m) => ({ default: m.AlertsView })),
);
const DeviceSearch = lazy(() =>
  import("./ReadViews").then((m) => ({ default: m.DeviceSearch })),
);
const DeviceCurrent = lazy(() =>
  import("./ReadViews").then((m) => ({ default: m.DeviceCurrent })),
);
const DeviceHistory = lazy(() =>
  import("./ReadViews").then((m) => ({ default: m.DeviceHistory })),
);
const DeviceRollups = lazy(() =>
  import("./ReadViews").then((m) => ({ default: m.DeviceRollups })),
);
const BinReadings = lazy(() =>
  import("./BinReadings").then((m) => ({ default: m.BinReadings })),
);
const MlOperationsView = lazy(() =>
  import("./MlOperationsView").then((m) => ({ default: m.MlOperationsView })),
);
const BillingView = lazy(() => import("./BillingView").then((m) => ({ default: m.BillingView })));
const services = [
  {
    name: "Device service",
    service: "device-service",
    path: "/api/devices/readyz",
    stack: "TypeScript · NestJS · PostgreSQL",
  },
  {
    name: "Telemetry ingestion",
    service: "telemetry-ingest",
    path: "/api/telemetry/readyz",
    stack: "Go · PostgreSQL",
  },
];
function statusGlyph(ready: boolean | null) {
  if (ready === null) return "notice";
  return ready ? "ok" : "critical";
}
function statusStyle(ready: boolean | null) {
  if (ready === null) return "";
  return ready ? "ready" : "offline";
}
function statusText(ready: boolean | null) {
  if (ready === null) return "Checking…";
  return ready ? "Ready" : "Unavailable";
}
const navItems = [
  { to: "/", label: "Overview", icon: "overview", end: true },
  { to: "/provisioning", label: "Provisioning", icon: "provisioning" },
  { to: "/devices", label: "Devices", icon: "devices" },
  { to: "/alerts", label: "Alerts", icon: "alerts" },
  { to: "/ml", label: "ML operations", icon: "overview" },
  { to: "/billing", label: "Billing", icon: "overview" },
] as const;

function Overview({
  health,
  alertsApi,
  sessionId,
}: Readonly<{
  health: (boolean | null)[];
  alertsApi: AlertsApi | null;
  sessionId?: string;
}>) {
  const dispatch = useDispatch();
  const showTechnicalDetails = useSelector(
    (state: DashboardState) => state.ui.showTechnicalDetails,
  );
  return (
    <>
      <PageHeader id="overview-title" title="Overview" />
      <AlertSummary api={alertsApi} sessionId={sessionId} />
      <section className="section" aria-labelledby="status-title">
        <div className="section-head">
          <h2 id="status-title">Service status</h2>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => dispatch(uiActions.toggleTechnicalDetails())}
            aria-pressed={showTechnicalDetails}
          >
            Technical details
          </button>
        </div>
        <ul className="rows">
          {services.map((s, i) => (
            <li key={s.service} className="service-row">
              <div>
                <h3>{s.name}</h3>
                {showTechnicalDetails && (
                  <p className="meta">
                    {s.stack}. Readiness includes a live database query.
                  </p>
                )}
              </div>
              <output className={`status ${statusStyle(health[i])}`}>
                <Glyph name={statusGlyph(health[i])} />
                {statusText(health[i])}
              </output>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function App({
  getAccessToken,
  sessionId,
  onSignOut,
}: {
  getAccessToken?: AccessTokenProvider;
  sessionId?: string;
  onSignOut?: () => void;
} = {}) {
  const provisioning = useMemo(
    () => (getAccessToken ? new ProvisioningApi(getAccessToken) : null),
    [getAccessToken],
  );
  const readApi = useMemo(
    () => (getAccessToken ? new ReadApi(getAccessToken) : null),
    [getAccessToken, sessionId],
  );
  const alertsApi = useMemo(
    () => (getAccessToken ? new AlertsApi(getAccessToken) : null),
    [getAccessToken],
  );
  const mlApi = useMemo(
    () => (getAccessToken ? new MlApi(getAccessToken) : null),
    [getAccessToken],
  );
  const billingApi = useMemo(() => (getAccessToken ? new BillingApi(getAccessToken) : null), [getAccessToken]);
  const [health, setHealth] = useState<(boolean | null)[]>([null, null]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const update = async () => {
      if (document.hidden) return;
      const results = await Promise.all(
        services.map((s) =>
          checkHealth(
            s.path,
            s.service,
            AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
          ),
        ),
      );
      if (active) setHealth(results);
    };
    const onVisible = () => {
      if (!document.hidden) void update();
    };
    document.addEventListener("visibilitychange", onVisible);
    void update();
    const timer = setInterval(() => void update(), 5000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const online = useOnline();
  const down = services.filter((_, i) => health[i] === false);
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <svg
              className="brand-mark"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M12 2.5 21 7v2H3V7z" fill="currentColor" />
              <path
                d="M4.5 10.5h15v10h-15zM4.5 14.2h15m-15 3.3h15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
            </svg>
            GreenGuard
          </Link>
          <nav className="nav" aria-label="Primary">
            <ul>
              {navItems.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={"end" in item ? item.end : false}>
                    <NavIcon name={item.icon} />
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          {onSignOut && (
            <button type="button" className="btn btn-quiet" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </header>
      <main id="main" className="page" tabIndex={-1}>
        <div role="status" className="banner-slot">
          {!online && (
            <Banner kind="offline">
              Offline. Data on screen may be out of date, and acknowledgements
              cannot be sent until you reconnect.
            </Banner>
          )}
          {online && down.length > 0 && (
            <Banner kind="warning">
              {down.map((s) => s.name).join(" and ")}{" "}
              {down.length === 1 ? "is" : "are"} unavailable. Readings and
              provisioning can fail until {down.length === 1 ? "it" : "they"}{" "}
              recover{down.length === 1 ? "s" : ""}.
            </Banner>
          )}
        </div>
        <Suspense fallback={<Loading label="Loading…" rows={3} />}>
          <Routes>
            <Route
              path="/"
              element={
                <Overview
                  health={health}
                  alertsApi={alertsApi}
                  sessionId={sessionId}
                />
              }
            />
            <Route
              path="/provisioning"
              element={
                <Provisioning api={provisioning} sessionId={sessionId} />
              }
            />
            <Route
              path="/devices"
              element={<DeviceSearch api={readApi} sessionId={sessionId} />}
            />
            <Route
              path="/alerts"
              element={
                <AlertsView
                  api={alertsApi}
                  provisioningApi={provisioning}
                  sessionId={sessionId}
                />
              }
            />
            <Route
              path="/devices/:deviceId"
              element={<DeviceCurrent api={readApi} sessionId={sessionId} />}
            />
            <Route
              path="/devices/:deviceId/history"
              element={<DeviceHistory api={readApi} sessionId={sessionId} />}
            />
            <Route
              path="/devices/:deviceId/rollups"
              element={<DeviceRollups api={readApi} sessionId={sessionId} />}
            />
            <Route
              path="/bins/:binId"
              element={<BinReadings api={readApi} sessionId={sessionId} />}
            />
            <Route
              path="/ml"
              element={<MlOperationsView api={mlApi} sessionId={sessionId} />}
            />
            <Route
              path="/ml/drift"
              element={<MlOperationsView api={mlApi} sessionId={sessionId} />}
            />
            <Route
              path="/ml/performance"
              element={<MlOperationsView api={mlApi} sessionId={sessionId} />}
            />
            <Route
              path="/ml/models"
              element={<MlOperationsView api={mlApi} sessionId={sessionId} />}
            />
            <Route
              path="/ml/retraining"
              element={<MlOperationsView api={mlApi} sessionId={sessionId} />}
            />
            <Route path="/billing" element={<BillingView api={billingApi} sessionId={sessionId} />} />
          </Routes>
        </Suspense>
      </main>
    </>
  );
}
