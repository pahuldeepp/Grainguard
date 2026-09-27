import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { AlertsApi, type AlertPage, type AlertView } from "./alerts-api";
import { formatTimestamp, relativeTime } from "./format";
import {
  alertStateMarker,
  nextOpenAlert,
  severityMarker,
  sortAlerts,
} from "./severity";
import {
  Banner,
  EmptyState,
  ErrorState,
  Glyph,
  Loading,
  PageHeader,
  StatusMarker,
} from "./ui";

const filters = [
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
] as const;
type Filter = (typeof filters)[number]["value"];
const countable = ["open", "acknowledged", "resolved"] as const;

function isFilter(value: string | null): value is Filter {
  return filters.some((f) => f.value === value);
}

function listUrl(state: Filter, after?: string) {
  const search = new URLSearchParams();
  if (state !== "open") search.set("state", state);
  if (after) search.set("after", after);
  const text = search.toString();
  return { pathname: "/alerts", search: text ? `?${text}` : "" };
}

function alertUrl(state: Filter, after: string | undefined, alertId: string) {
  const search = new URLSearchParams(listUrl(state, after).search);
  search.set("alert", alertId);
  return { pathname: "/alerts", search: `?${search.toString()}` };
}

function useAlertCount(
  api: AlertsApi | null,
  sessionId: string | undefined,
  name: (typeof countable)[number],
) {
  return useQuery({
    queryKey: ["alerts", sessionId, "count", name] as const,
    queryFn: () => api!.list(undefined, name),
    enabled: Boolean(api && sessionId),
    retry: false,
    gcTime: 0,
  });
}

function When({ iso }: Readonly<{ iso: string }>) {
  return (
    <time dateTime={iso} title={formatTimestamp(iso)}>
      {relativeTime(iso) || formatTimestamp(iso)}
    </time>
  );
}

interface Confirmation {
  alertId: string;
  binId: string;
  nextId: string | null;
}

function emptyListCopy(state: Filter) {
  if (state === "open") {
    return {
      title: "No open alerts. Bins are within limits.",
      message: "New alerts appear here when a bin crosses a risk limit.",
    };
  }
  if (state === "all") {
    return { title: "No alerts in this view.", message: "Try another state." };
  }
  return {
    title: `No ${state} alerts in this view.`,
    message: "Try another state.",
  };
}

function AlertDetailResult({
  alert,
  pending,
  failed,
  onRetry,
  onAcknowledge,
}: Readonly<{
  alert?: AlertView;
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
  onAcknowledge: (alert: AlertView, primary?: boolean) => ReactNode;
}>) {
  if (alert) {
    return (
      <AlertDetail
        alert={alert}
        action={alert.state === "open" ? onAcknowledge(alert, true) : null}
      />
    );
  }
  if (pending) return <Loading label="Loading alert…" rows={2} />;
  if (failed) {
    return (
      <ErrorState
        message="Alerts are temporarily unavailable."
        onRetry={onRetry}
      />
    );
  }
  return (
    <>
      <PageHeader id="alerts-title" title="Alert not found" />
      <EmptyState title="This alert is not in the current list.">
        It may have been resolved or be on another page. Go back to the list to
        find it.
      </EmptyState>
    </>
  );
}

function AlertListResult({
  items,
  state,
  after,
  onRemember,
  onAcknowledge,
}: Readonly<{
  items: AlertView[];
  state: Filter;
  after?: string;
  onRemember: (id: string) => void;
  onAcknowledge: (alert: AlertView, primary?: boolean) => ReactNode;
}>) {
  if (items.length === 0) {
    const copy = emptyListCopy(state);
    return <EmptyState title={copy.title}>{copy.message}</EmptyState>;
  }
  return (
    <ul className="rows">
      {items.map((alert) => {
        const severity = severityMarker(alert.severity);
        const titleId = `alert-title-${alert.alertId}`;
        const stateClass = alert.state === "open" ? severity.kind : "closed";
        return (
          <li
            key={alert.alertId}
            className={`alert-row alert-${stateClass} sev-${severity.kind}`}
          >
            <div className="alert-main">
              <Link
                id={`alert-link-${alert.alertId}`}
                to={alertUrl(state, after, alert.alertId)}
                className="alert-title row-title"
                onClick={() => onRemember(alert.alertId)}
              >
                <span id={titleId} className="alert-title-text">
                  <StatusMarker marker={severity} />
                  <span className="sep" aria-hidden="true">
                    {" · "}
                  </span>
                  <span className="bin-id">Bin {alert.binId}</span>
                </span>
              </Link>
              <span className="meta">
                Opened <When iso={alert.openedAt} />
              </span>
            </div>
            <div className="alert-side">
              <span className="score">
                <span className="meta">Score</span>{" "}
                <span className="num data">{alert.score}</span>
              </span>
              {state !== "open" && (
                <StatusMarker marker={alertStateMarker(alert.state)} />
              )}
              {alert.state === "open" && onAcknowledge(alert)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AlertPager({
  state,
  after,
  nextCursor,
}: Readonly<{ state: Filter; after?: string; nextCursor?: string | null }>) {
  if (!after && !nextCursor) return null;
  return (
    <div className="pager">
      {after && (
        <Link className="btn btn-secondary" to={listUrl(state)}>
          First page
        </Link>
      )}
      {nextCursor && (
        <Link className="btn btn-secondary" to={listUrl(state, nextCursor)}>
          Next page
        </Link>
      )}
    </div>
  );
}

export function AlertsView({
  api,
  sessionId,
}: Readonly<{ api: AlertsApi | null; sessionId?: string }>) {
  const [params, setParams] = useSearchParams();
  const stateParam = params.get("state");
  const state: Filter = isFilter(stateParam) ? stateParam : "open";
  const after = params.get("after") || undefined;
  const alertId = params.get("alert") || undefined;
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pendingKeys = useRef(new Map<string, string>());
  // Alerts seen so far, so a detail stays readable after it leaves the open list.
  const seen = useRef(new Map<string, AlertView>());
  const acknowledgedHere = useRef(new Set<string>());
  const scrollBeforeDetail = useRef<number | null>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const enabled = Boolean(api && sessionId);
  const apiState = state === "all" ? undefined : state;
  const page = useQuery({
    queryKey: ["alerts", sessionId, state, after] as const,
    queryFn: async (): Promise<AlertPage> => {
      const result = await api!.list(after, apiState);
      for (const item of result.items)
        if (!acknowledgedHere.current.has(item.alertId))
          seen.current.set(item.alertId, item);
      return result;
    },
    enabled,
    retry: false,
    gcTime: 0,
  });
  const counts = [
    useAlertCount(api, sessionId, "open"),
    useAlertCount(api, sessionId, "acknowledged"),
    useAlertCount(api, sessionId, "resolved"),
  ];
  const acknowledge = useMutation({
    mutationFn: (alert: AlertView) => {
      const command = `${alert.alertId}:${alert.version}`;
      let key = pendingKeys.current.get(command);
      if (!key) {
        const storageKey = `gg.alert.ack:${sessionId}:${command}`;
        try {
          key = window.sessionStorage.getItem(storageKey) ?? undefined;
        } catch {
          // Private browsing may disable storage; retry remains stable this mount.
        }
        key ??= crypto.randomUUID();
        pendingKeys.current.set(command, key);
        try {
          window.sessionStorage.setItem(storageKey, key);
        } catch {
          // The in-memory key still covers retries until this view is closed.
        }
      }
      return api!.acknowledge(alert.alertId, alert.version, key);
    },
    onSuccess: (_, alert) => {
      const command = `${alert.alertId}:${alert.version}`;
      pendingKeys.current.delete(command);
      try {
        window.sessionStorage.removeItem(
          `gg.alert.ack:${sessionId}:${command}`,
        );
      } catch {
        // The server has already acknowledged this command.
      }
      setError("");
      acknowledgedHere.current.add(alert.alertId);
      seen.current.set(alert.alertId, {
        ...alert,
        state: "acknowledged",
        acknowledgedAt: new Date().toISOString(),
      });
      const next = nextOpenAlert(
        sortAlerts(page.data?.items ?? []),
        alert.alertId,
      );
      setConfirmation({
        alertId: alert.alertId,
        binId: alert.binId,
        nextId: next?.alertId ?? null,
      });
    },
    onError: (cause: Error) => setError(cause.message),
    onSettled: async () => {
      // A timeout can occur after the owner committed; reconcile from its read API.
      await queryClient.invalidateQueries({ queryKey: ["alerts", sessionId] });
    },
  });

  const items = sortAlerts(page.data?.items ?? []);
  let selected: AlertView | undefined;
  if (alertId) {
    selected = seen.current.get(alertId);
    if (!acknowledgedHere.current.has(alertId)) {
      selected = items.find((item) => item.alertId === alertId) ?? selected;
    }
  }
  const inDetail = Boolean(alertId);

  // Bring the confirmation into view: the button that caused it may be far down the page.
  useEffect(() => {
    if (confirmation) bannerRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [confirmation]);

  // Back on the list: restore scroll position and the row the user came from.
  useEffect(() => {
    if (inDetail || !page.isSuccess) return;
    const row = returnFocusTo.current
      ? document.getElementById(returnFocusTo.current)
      : null;
    row?.focus({ preventScroll: true });
    if (scrollBeforeDetail.current !== null)
      window.scrollTo({ top: scrollBeforeDetail.current });
    returnFocusTo.current = null;
    scrollBeforeDetail.current = null;
  }, [inDetail, page.isSuccess]);

  function rememberPosition(id: string) {
    scrollBeforeDetail.current = window.scrollY;
    returnFocusTo.current = `alert-link-${id}`;
  }

  // A render helper, not a component: the button must keep its identity across renders.
  const acknowledgeButton = (alert: AlertView, primary = false) => {
    const busy = acknowledge.isPending && acknowledge.variables === alert;
    return (
      <button
        type="button"
        className={`btn ${primary ? "btn-primary" : "btn-secondary"}`}
        disabled={acknowledge.isPending}
        aria-busy={busy}
        onClick={() => acknowledge.mutate(alert)}
      >
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="sr-only">Acknowledging</span>
          </>
        ) : (
          "Acknowledge"
        )}
      </button>
    );
  };

  const confirmationBanner = (
    <div
      ref={bannerRef}
      role="status"
      aria-live="polite"
      className="banner-slot"
    >
      {confirmation && (
        <Banner kind="ok">
          <span>Acknowledged Bin {confirmation.binId}.</span>
          <span className="banner-actions">
            {inDetail && (
              <Link to={listUrl(state, after)} className="banner-link">
                Back to alerts
              </Link>
            )}
            {confirmation.nextId && (
              <Link
                to={alertUrl(state, after, confirmation.nextId)}
                className="banner-link"
              >
                Next open alert
              </Link>
            )}
          </span>
        </Banner>
      )}
    </div>
  );

  if (!api || !sessionId)
    return (
      <section className="read-view" aria-labelledby="alerts-title">
        <PageHeader id="alerts-title" title="Grain alerts" />
        <EmptyState title="Sign in to view alerts." />
      </section>
    );

  if (inDetail) {
    return (
      <section className="read-view" aria-labelledby="alerts-title">
        <Link to={listUrl(state, after)} className="back">
          <Glyph name="arrow-left" />
          Back to alerts
        </Link>
        {confirmationBanner}
        {error && (
          <p role="alert" className="field-error inline-error">
            <Glyph name="critical" />
            <span>{error}</span>
          </p>
        )}
        <AlertDetailResult
          alert={selected}
          pending={page.isPending}
          failed={page.isError}
          onRetry={() => void page.refetch()}
          onAcknowledge={acknowledgeButton}
        />
      </section>
    );
  }

  const countFor = (name: Filter) => {
    if (name === "all") {
      const all = counts.map((c) => c.data);
      if (all.some((c) => !c)) return "";
      const total = all.reduce((sum, c) => sum + c!.items.length, 0);
      const more = all.some((c) => c!.nextCursor);
      return ` (${total}${more ? "+" : ""})`;
    }
    const data = counts[countable.indexOf(name)].data;
    if (!data) return "";
    const more = data.nextCursor ? "+" : "";
    return ` (${data.items.length}${more})`;
  };

  return (
    <section className="read-view" aria-labelledby="alerts-title">
      <PageHeader id="alerts-title" title="Grain alerts">
        Open alerts come first, by severity and then by how long they have
        waited.
      </PageHeader>
      {confirmationBanner}
      <div className="toolbar">
        <div className="field">
          <label htmlFor="alert-state">State</label>
          <select
            id="alert-state"
            className="select"
            value={state}
            onChange={(event) => {
              setConfirmation(null);
              const next = event.target.value as Filter;
              setParams(listUrl(next).search.replace(/^\?/, ""));
            }}
          >
            {filters.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
                {countFor(f.value)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {page.isPending && <Loading label="Loading alerts…" />}
      {page.isError && (
        <ErrorState
          message="Alerts are temporarily unavailable."
          onRetry={() => void page.refetch()}
        />
      )}
      {error && (
        <p role="alert" className="field-error inline-error">
          <Glyph name="critical" />
          <span>{error}</span>
        </p>
      )}
      {page.isSuccess && (
        <AlertListResult
          items={items}
          state={state}
          after={after}
          onRemember={rememberPosition}
          onAcknowledge={acknowledgeButton}
        />
      )}
      {page.isSuccess && (
        <AlertPager
          state={state}
          after={after}
          nextCursor={page.data.nextCursor}
        />
      )}
    </section>
  );
}

function AlertDetail({
  alert,
  action,
}: Readonly<{ alert: AlertView; action: ReactNode }>) {
  const severity = severityMarker(alert.severity);
  return (
    <>
      <PageHeader id="alerts-title" title={`${severity.word} alert`}>
        <StatusMarker marker={alertStateMarker(alert.state)} />
      </PageHeader>
      <p className="bin-line">
        Bin <span className="mono">{alert.binId}</span>
      </p>
      {action && <div className="form-actions detail-actions">{action}</div>}
      <section className="section" aria-labelledby="alert-facts">
        <h2 id="alert-facts">Details</h2>
        <dl className="kv facts">
          <dt>Risk score</dt>
          <dd className="num data">{alert.score}</dd>
          <dt>Severity</dt>
          <dd>
            <StatusMarker marker={severity} />
          </dd>
          <dt>Rule</dt>
          <dd>{alert.ruleId}</dd>
          <dt>Escalation level</dt>
          <dd className="num">{alert.escalationLevel}</dd>
          <dt>Version</dt>
          <dd className="num">{alert.version}</dd>
          <dt>Alert ID</dt>
          <dd className="mono">{alert.alertId}</dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="alert-history">
        <h2 id="alert-history">History</h2>
        <ol className="timeline">
          <li>
            <span className="action">Opened</span>
            <span className="when">
              <When iso={alert.openedAt} />
            </span>
          </li>
          {alert.acknowledgedAt && (
            <li>
              <span className="action">Acknowledged</span>
              <span className="when">
                <When iso={alert.acknowledgedAt} />
              </span>
            </li>
          )}
        </ol>
      </section>
    </>
  );
}
