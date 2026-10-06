import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { AlertsApi, type AlertPage, type AlertView } from "./alerts-api";
import { formatTimestamp, relativeTime } from "./format";
import { binLabel } from "./bin-label";
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
import type { ProvisioningApi } from "./provisioning";

const filters = [
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
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
  binName?: string | null;
  nextId: string | null;
}

export function AlertsView({
  api,
  provisioningApi,
  sessionId,
}: Readonly<{
  api: AlertsApi | null;
  provisioningApi?: ProvisioningApi | null;
  sessionId?: string;
}>) {
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
        binName: alert.binName,
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
  const selected = alertId
    ? acknowledgedHere.current.has(alertId)
      ? seen.current.get(alertId)
      : (items.find((a) => a.alertId === alertId) ?? seen.current.get(alertId))
    : undefined;
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
          <span>
            Acknowledged {binLabel(confirmation.binId, confirmation.binName)}.
          </span>
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
        {selected ? (
          <AlertDetail
            alert={selected}
            api={api}
            provisioningApi={provisioningApi ?? null}
            sessionId={sessionId}
            action={
              selected.state === "open"
                ? acknowledgeButton(selected, true)
                : null
            }
          />
        ) : page.isPending ? (
          <Loading label="Loading alert…" rows={2} />
        ) : page.isError ? (
          <ErrorState
            message="Alerts are temporarily unavailable."
            onRetry={() => void page.refetch()}
          />
        ) : (
          <>
            <PageHeader id="alerts-title" title="Alert not found" />
            <EmptyState title="This alert is not in the current list.">
              It may have been resolved or be on another page. Go back to the
              list to find it.
            </EmptyState>
          </>
        )}
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
    return data ? ` (${data.items.length}${data.nextCursor ? "+" : ""})` : "";
  };

  return (
    <section className="read-view" aria-labelledby="alerts-title">
      <PageHeader id="alerts-title" title="Grain alerts">
        Open alerts come first, by severity and then by how long they have
        waited.
      </PageHeader>
      {confirmationBanner}
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Alert state">
          {filters.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className="segment"
              aria-pressed={state === filter.value}
              onClick={() => {
                setConfirmation(null);
                setParams(listUrl(filter.value).search.replace(/^\?/, ""));
              }}
            >
              {filter.label}
              {countFor(filter.value)}
            </button>
          ))}
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
      {page.isSuccess &&
        (items.length === 0 ? (
          <EmptyState
            title={
              state === "open"
                ? "No open alerts. Bins are within limits."
                : `No ${state === "all" ? "" : `${state} `}alerts in this view.`
            }
          >
            {state === "open"
              ? "New alerts appear here when a bin crosses a risk limit."
              : "Try another state."}
          </EmptyState>
        ) : (
          <ul className="rows">
            {items.map((alert) => {
              const severity = severityMarker(alert.severity);
              const titleId = `alert-title-${alert.alertId}`;
              return (
                <li
                  key={alert.alertId}
                  className={`alert-row alert-${alert.state === "open" ? severity.kind : "closed"} sev-${severity.kind}`}
                >
                  <div className="alert-main">
                    <Link
                      id={`alert-link-${alert.alertId}`}
                      to={alertUrl(state, after, alert.alertId)}
                      className="alert-title row-title"
                      onClick={() => rememberPosition(alert.alertId)}
                    >
                      <span id={titleId} className="alert-title-text">
                        <StatusMarker marker={severity} />
                        <span className="sep" aria-hidden="true">
                          {" · "}
                        </span>
                        <span className="bin-id">
                          {binLabel(alert.binId, alert.binName)}
                        </span>
                      </span>
                    </Link>
                    {alert.siteName?.trim() && (
                      <span className="site-name">{alert.siteName.trim()}</span>
                    )}
                    <span className="meta">
                      Opened <When iso={alert.openedAt} />
                    </span>
                  </div>
                  <div className="alert-side">
                    <span className="score">
                      <span className="meta">Score</span>{" "}
                      <span className="num data">{alert.score}</span>
                    </span>
                    <StatusMarker marker={alertStateMarker(alert.state)} />
                    {alert.state === "open" && acknowledgeButton(alert)}
                  </div>
                </li>
              );
            })}
          </ul>
        ))}
      {page.isSuccess && (after || page.data.nextCursor) && (
        <div className="pager">
          {after && (
            <Link className="btn btn-secondary" to={listUrl(state)}>
              First page
            </Link>
          )}
          {page.data.nextCursor && (
            <Link
              className="btn btn-secondary"
              to={listUrl(state, page.data.nextCursor)}
            >
              Next page
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

function AlertDetail({
  alert,
  api,
  provisioningApi,
  sessionId,
  action,
}: Readonly<{
  alert: AlertView;
  api: AlertsApi;
  provisioningApi: ProvisioningApi | null;
  sessionId: string;
  action: ReactNode;
}>) {
  const [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const history = useQuery({
    queryKey: ["alerts", sessionId, "history", alert.alertId, historyCursor],
    queryFn: () => api.history(alert.alertId, historyCursor),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const session = useQuery({
    queryKey: ["alerts", sessionId, "notification-role"],
    queryFn: () => provisioningApi!.session(),
    enabled: Boolean(provisioningApi),
    retry: false,
    gcTime: 0,
  });
  const mayViewNotifications = Boolean(
    session.data?.roles.some((role) => role === "operator" || role === "admin"),
  );
  const [notificationCursor, setNotificationCursor] = useState<
    string | undefined
  >();
  const notifications = useQuery({
    queryKey: [
      "alerts",
      sessionId,
      "notifications",
      alert.alertId,
      notificationCursor,
    ],
    queryFn: () => api.notifications(alert.alertId, notificationCursor),
    enabled: mayViewNotifications,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const severity = severityMarker(alert.severity);
  return (
    <>
      <PageHeader id="alerts-title" title={`${severity.word} alert`}>
        <StatusMarker marker={alertStateMarker(alert.state)} />
      </PageHeader>
      <p className="bin-line">
        <Link to={`/bins/${encodeURIComponent(alert.binId)}`}>
          {binLabel(alert.binId, alert.binName)}
        </Link>
        {alert.siteName?.trim() && (
          <span className="site-name">{alert.siteName.trim()}</span>
        )}
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
        </dl>
      </section>
      <details className="technical-details section">
        <summary>Technical identifiers</summary>
        <dl className="kv facts">
          <dt>Alert ID</dt>
          <dd className="mono">{alert.alertId}</dd>
          <dt>Version</dt>
          <dd className="num">{alert.version}</dd>
        </dl>
      </details>
      <section className="section" aria-labelledby="alert-history">
        <h2 id="alert-history">History</h2>
        {history.isPending && <Loading label="Loading alert history…" />}
        {history.isError && (
          <ErrorState
            message="Alert history is temporarily unavailable."
            onRetry={() => void history.refetch()}
          />
        )}
        {history.isSuccess && (
          <>
            {history.data.source.status !== "ok" &&
              history.data.source.status !== "empty" && (
                <Banner kind="warning">
                  {history.data.source.reasonCode === "incomplete_lifecycle"
                    ? "Some alert lifecycle transitions are missing from the stored history. The transitions still available are shown below."
                    : `History is ${history.data.source.status}${history.data.source.reasonCode ? ` (${history.data.source.reasonCode})` : ""}.`}
                </Banner>
              )}
            {!history.data.complete && (
              <p className="meta">
                This alert’s current state is available, but its stored
                transition history has gaps. Missing events are not
                reconstructed from current state.
              </p>
            )}
            {history.data.items.length ? (
              <ol className="timeline">
                {history.data.items.map((transition) => (
                  <li key={transition.transitionId}>
                    <span className="action">
                      {transition.type
                        .replaceAll("_", " ")
                        .replace(/^./, (first) => first.toUpperCase())}
                      {transition.actor.isYou
                        ? " · You"
                        : transition.actor.handle
                          ? ` · ${transition.actor.handle}`
                          : " · Team member"}
                    </span>
                    <span className="when">
                      <When iso={transition.occurredAt} />
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState
                title={
                  history.data.complete
                    ? "No transitions were recorded."
                    : "No lifecycle transitions are available for this alert."
                }
              />
            )}
            {history.data.nextCursor && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() =>
                  setHistoryCursor(history.data.nextCursor ?? undefined)
                }
              >
                Load older transitions
              </button>
            )}
          </>
        )}
      </section>
      <section className="section" aria-labelledby="delivery-history-title">
        <h2 id="delivery-history-title">Notification delivery history</h2>
        {!provisioningApi && (
          <p className="meta">
            Notification history is not configured in this dashboard session.
          </p>
        )}
        {provisioningApi && session.isPending && (
          <Loading label="Checking notification history access…" />
        )}
        {provisioningApi && session.isError && (
          <ErrorState
            message="Could not verify access to notification history."
            onRetry={() => void session.refetch()}
          />
        )}
        {provisioningApi && session.isSuccess && !mayViewNotifications && (
          <p className="meta">
            Operator or administrator access is required to view notification
            delivery history.
          </p>
        )}
        {mayViewNotifications && notifications.isPending && (
          <Loading label="Loading notification history…" />
        )}
        {mayViewNotifications && notifications.isError && (
          <ErrorState
            message="Notification history is temporarily unavailable."
            onRetry={() => void notifications.refetch()}
          />
        )}
        {mayViewNotifications && notifications.isSuccess && (
          <>
            <dl className="kv facts">
              <dt>Warning channel</dt>
              <dd>
                {notifications.data.sources.warning.status}
                {notifications.data.sources.warning.reasonCode
                  ? ` · ${notifications.data.sources.warning.reasonCode}`
                  : ""}
              </dd>
              <dt>Critical channel</dt>
              <dd>
                {notifications.data.sources.critical.status === "not_configured"
                  ? "Not configured"
                  : notifications.data.sources.critical.status}
                {notifications.data.sources.critical.reasonCode
                  ? ` · ${notifications.data.sources.critical.reasonCode}`
                  : ""}
              </dd>
              <dt>Intent source</dt>
              <dd>{notifications.data.sources.intents.status}</dd>
            </dl>
            {notifications.data.items.length ? (
              <ul className="rows">
                {notifications.data.items.map((item) => (
                  <li
                    className="service-row"
                    key={`${item.intentId}:${item.deliveryGeneration}`}
                  >
                    <div>
                      <h3>
                        {item.channel} · {item.state.replaceAll("_", " ")}
                      </h3>
                      <p className="meta">
                        {item.transition.replaceAll("_", " ")} ·{" "}
                        {item.severity ?? "severity unavailable"} · generation{" "}
                        {item.deliveryGeneration}
                      </p>
                      {item.queuedAt && (
                        <p className="meta">
                          Queued <When iso={item.queuedAt} />
                        </p>
                      )}
                      {item.reasonCode && (
                        <p className="meta">Reason: {item.reasonCode}</p>
                      )}
                      {item.events.length > 0 && (
                        <p className="meta">
                          {item.events
                            .map((event) => `${event.kind}: ${event.outcome}`)
                            .join(" · ")}
                          {item.attemptsTruncated
                            ? " · some attempts omitted"
                            : ""}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No notification attempts are available from the configured sources." />
            )}
            {notifications.data.nextCursor && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() =>
                  setNotificationCursor(
                    notifications.data.nextCursor ?? undefined,
                  )
                }
              >
                Load older attempts
              </button>
            )}
          </>
        )}
      </section>
    </>
  );
}
