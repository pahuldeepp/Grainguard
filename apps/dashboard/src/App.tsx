import { useEffect, useState } from "react";
import { checkHealth } from "./health";
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
function statusStyle(ready: boolean | null) {
  if (ready === null) return "";
  return ready ? "ready" : "offline";
}
function statusText(ready: boolean | null) {
  if (ready === null) return "Checking…";
  return ready ? "Ready" : "Unavailable";
}
export function App() {
  const [health, setHealth] = useState<(boolean | null)[]>([null, null]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const update = async () => {
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
    void update();
    const timer = setInterval(() => void update(), 5000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return (
    <main>
      <nav>
        <a href="/" className="brand">
          <span className="mark">G</span> GreenGuard
        </a>
        <span className="badge">LOCAL DEVELOPMENT</span>
      </nav>
      <header>
        <p className="eyebrow">FROM THE GROUND UP</p>
        <h1>
          Better grain care.
          <br />
          <span>A solid foundation.</span>
        </h1>
        <p className="intro">
          One platform for grain storage, telemetry and intelligent alerts. Your
          new workspace starts here.
        </p>
      </header>
      <section aria-labelledby="status-title">
        <div className="section-heading">
          <h2 id="status-title">Foundation status</h2>
          <span>Live checks · every 5 seconds</span>
        </div>
        <div className="grid">
          {services.map((s, i) => (
            <article key={s.service}>
              <div className="card-heading">
                <span className="icon">{i === 0 ? "▦" : "↗"}</span>
                <output className={`status ${statusStyle(health[i])}`}>
                  {statusText(health[i])}
                </output>
              </div>
              <h3>{s.name}</h3>
              <p>{s.stack}</p>
              <small>Readiness includes a live database query.</small>
            </article>
          ))}
        </div>
      </section>
      <section className="next">
        <div>
          <p className="eyebrow">NEXT MILESTONE · 02 / 14</p>
          <h2>Give your grain a home.</h2>
          <p>
            Tenant isolation, sites, storage bins and devices — the domain model
            comes next.
          </p>
        </div>
        <span className="outline">Planned</span>
      </section>
      <footer>
        <span>Stage 01 · Workspace foundation</span>
        <span>Local setup · Capacity targets remain unverified</span>
      </footer>
    </main>
  );
}
