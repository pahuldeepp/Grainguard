import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { AlertsApi } from "./alerts-api";
import { relativeTime, formatTimestamp } from "./format";
import { binLabel } from "./bin-label";
import { severityMarker, sortAlerts } from "./severity";
import { EmptyState, ErrorState, Loading, StatusMarker } from "./ui";

const shown = 5;

// Overview list of what needs attention now: real open alerts, worst first.
export function AlertSummary({
  api,
  sessionId,
}: Readonly<{ api: AlertsApi | null; sessionId?: string }>) {
  if (!api || !sessionId) return null;
  return <OpenAlerts api={api} sessionId={sessionId} />;
}

function OpenAlerts({
  api,
  sessionId,
}: Readonly<{ api: AlertsApi; sessionId: string }>) {
  const query = useQuery({
    queryKey: ["alerts", sessionId, "open", undefined] as const,
    queryFn: () => api.list(undefined, "open"),
    retry: false,
    gcTime: 0,
  });
  const items = sortAlerts(query.data?.items ?? []);
  return (
    <section className="section" aria-labelledby="attention-title">
      <div className="section-head">
        <h2 id="attention-title">
          Open alerts
          {query.isSuccess && (
            <span className="count num">
              {" "}
              {items.length}
              {query.data.nextCursor ? "+" : ""}
            </span>
          )}
        </h2>
        <Link to="/alerts" className="section-link">
          All alerts
        </Link>
      </div>
      {query.isPending && <Loading label="Loading open alerts…" rows={2} />}
      {query.isError && (
        <ErrorState
          message="Alerts are temporarily unavailable."
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isSuccess &&
        (items.length === 0 ? (
          <EmptyState title="No open alerts. Bins are within limits." />
        ) : (
          <ul className="rows">
            {items.slice(0, shown).map((alert) => (
              <li
                key={alert.alertId}
                className={`link-row summary-row sev-${severityMarker(alert.severity).kind}`}
              >
                <Link to={`/alerts?alert=${encodeURIComponent(alert.alertId)}`}>
                  <StatusMarker marker={severityMarker(alert.severity)} />
                  <span className="sep" aria-hidden="true">
                    {" · "}
                  </span>
                  <span className="mono">
                    {binLabel(alert.binId, alert.binName)}
                  </span>
                  {alert.siteName?.trim() && (
                    <span className="site-name">{alert.siteName.trim()}</span>
                  )}
                </Link>
                <span className="meta">
                  Score <span className="num">{alert.score}</span>
                  {" · Opened "}
                  <time
                    dateTime={alert.openedAt}
                    title={formatTimestamp(alert.openedAt)}
                  >
                    {relativeTime(alert.openedAt) ||
                      formatTimestamp(alert.openedAt)}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
