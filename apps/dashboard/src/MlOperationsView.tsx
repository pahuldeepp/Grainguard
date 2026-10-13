import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useLocation } from "react-router";
import type { ReactNode } from "react";
import type { MlApi, MlOperationsSnapshot } from "./ml-api";
import { formatTimestamp } from "./format";
import {
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  StatusMarker,
} from "./ui";
import type { Marker } from "./severity";

const ML_SECTIONS = [
  ["overview", "/ml", "Overview"],
  ["drift", "/ml/drift", "Drift"],
  ["performance", "/ml/performance", "Performance"],
  ["models", "/ml/models", "Models"],
  ["retraining", "/ml/retraining", "Retraining"],
] as const;
type MlSection = (typeof ML_SECTIONS)[number][0];

function mlSectionFor(pathname: string): MlSection {
  switch (pathname) {
    case "/ml/drift":
      return "drift";
    case "/ml/performance":
      return "performance";
    case "/ml/models":
      return "models";
    case "/ml/retraining":
      return "retraining";
    default:
      return "overview";
  }
}

const mlPageTitles: Record<MlSection, string> = {
  overview: "ML operations",
  drift: "Feature drift",
  performance: "Model performance",
  models: "Model registry",
  retraining: "Retraining",
};

function MlSectionNavigation({ section }: { section: MlSection }) {
  return (
    <nav aria-label="ML operations" className="ml-section-nav">
      {ML_SECTIONS.map(([key, to, label]) => (
        <NavLink
          key={key}
          to={to}
          end={key === "overview"}
          className={section === key ? "active" : undefined}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function statusMarker(value: string): Marker {
  if (value === "healthy" || value === "ready")
    return { kind: "ok", word: "Ready" };
  if (value === "elevated" || value === "degraded")
    return { kind: "warning", word: "Attention" };
  return { kind: "critical", word: "Unavailable" };
}

function ShadowNotice() {
  return (
    <aside className="ml-safety-note" aria-label="Model safety status">
      <span className="ml-note-mark" aria-hidden="true">
        i
      </span>
      <div>
        <strong>Shadow model · synthetic data</strong>
        <p>
          Predictions are for evaluation only. This model is synthetic/shadow
          and is not production validated, so promotion and dashboard retraining
          are disabled.
        </p>
      </div>
    </aside>
  );
}

function SectionHeading({
  id,
  title,
  description,
  action,
}: {
  id?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="ml-section-heading">
      <div>
        <h2 id={id}>{title}</h2>
        {description && <p className="meta">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function DriftRows({ data }: { data: MlOperationsSnapshot["drift"] }) {
  if (data.length === 0)
    return (
      <EmptyState title="No drift observations yet">
        Feature drift will appear after the scorer has collected enough
        observations for a comparison window.
      </EmptyState>
    );
  return (
    <>
      <ul className="ml-drift-list">
        {data.map((item) => {
          const level =
            item.psi == null
              ? null
              : Math.min(100, Math.max(0, (item.psi / 0.25) * 100));
          return (
            <li className="ml-drift-row" key={item.feature}>
              <div className="ml-drift-feature">
                <h3>{item.feature.replaceAll("_", " ")}</h3>
                <p className="meta">
                  {item.sampleCount.toLocaleString()} observations
                </p>
              </div>
              <div className="ml-drift-value">
                {item.psi == null ? (
                  <span className="ml-muted-value">Collecting baseline</span>
                ) : (
                  <>
                    <strong className="num">PSI {item.psi.toFixed(3)}</strong>
                  </>
                )}
              </div>
              <div
                className="ml-drift-meter"
                aria-label={
                  item.psi == null
                    ? "Drift sample is warming"
                    : `Population stability index ${item.psi.toFixed(3)}`
                }
              >
                {level == null ? (
                  <span className="ml-meter-empty" />
                ) : (
                  <span
                    className={`ml-meter-fill ${item.status === "elevated" ? "is-elevated" : ""}`}
                    style={{ width: `${level}%` }}
                  />
                )}
              </div>
              <div className="ml-drift-status">
                <StatusMarker marker={statusMarker(item.status)} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="ml-scale-note">
        Bar scale is capped at PSI 0.25 for readability; the status comes from
        the scorer.
      </p>
    </>
  );
}

function ModelIdentity({ data }: { data: MlOperationsSnapshot["model"] }) {
  return (
    <div className="ml-model-identity">
      <div className="ml-model-symbol" aria-hidden="true">
        ML
      </div>
      <div className="ml-model-copy">
        <span className="eyebrow">Active model</span>
        <h2>{data.name}</h2>
        <p className="meta">
          Version <code>{data.version}</code>
        </p>
      </div>
      <div className="ml-model-tags">
        <span className="ml-tag">{data.mode}</span>
        <span className="ml-tag ml-tag-muted">{data.dataOrigin}</span>
      </div>
    </div>
  );
}

function ModelList({ data }: { data: MlOperationsSnapshot["models"] }) {
  if (data.length === 0)
    return (
      <EmptyState title="No registered versions">
        Registered model versions will appear here.
      </EmptyState>
    );
  return (
    <ul className="ml-model-list">
      {data.map((model) => (
        <li key={model.version}>
          <div className="ml-model-list-copy">
            <strong>{model.version}</strong>
            <span className="meta">
              {model.name} · {model.dataOrigin}
            </span>
          </div>
          <div className="ml-model-list-state">
            <StatusMarker
              marker={statusMarker(
                model.mode === "shadow" ? "degraded" : model.status,
              )}
            />
            <span>{model.mode}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MlOperationsView({
  api,
  sessionId,
}: {
  api: MlApi | null;
  sessionId?: string;
}) {
  const pathname = useLocation().pathname;
  const section: MlSection = mlSectionFor(pathname);
  const pageTitle = mlPageTitles[section];
  const query = useQuery({
    queryKey: ["ml-operations", sessionId],
    queryFn: () => api!.snapshot(),
    enabled: Boolean(api && sessionId),
    refetchInterval: 15_000,
    retry: false,
    gcTime: 0,
  });
  const queryClient = useQueryClient();
  const action = useMutation({
    mutationFn: ({
      name,
      version,
    }: {
      name: "promote" | "rollback" | "retrain";
      version?: string;
    }) => api!.action(name, version),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ["ml-operations", sessionId],
      }),
  });

  if (!api || !sessionId)
    return (
      <section className="read-view">
        <PageHeader id="ml-title" title={pageTitle} />
        <EmptyState title="Sign in to view ML operations." />
      </section>
    );
  if (query.isPending)
    return (
      <section className="read-view">
        <PageHeader id="ml-title" title={pageTitle} />
        <MlSectionNavigation section={section} />
        <Loading label="Loading ML operations…" rows={3} />
      </section>
    );
  if (query.isError)
    return (
      <section className="read-view">
        <PageHeader id="ml-title" title={pageTitle} />
        <MlSectionNavigation section={section} />
        <ErrorState
          message="ML operations are temporarily unavailable."
          onRetry={() => void query.refetch()}
        />
      </section>
    );

  const data = query.data;
  const performanceReady = data.performance.brierScore != null;
  return (
    <section className="read-view ml-dashboard" aria-labelledby="ml-title">
      <PageHeader id="ml-title" title={pageTitle}>
        <span className="ml-live-indicator">
          <span aria-hidden="true" /> Operator workspace
        </span>
        <span className="ml-lede-divider" aria-hidden="true">
          ·
        </span>
        Updated {formatTimestamp(data.capturedAt)}
      </PageHeader>
      <MlSectionNavigation section={section} />
      {section === "overview" && (
        <>
          {!data.model.productionEligible && <ShadowNotice />}
          <div className="ml-metrics" aria-label="Model health summary">
            <article className="ml-metric-card">
              <h2 className="eyebrow">Scorer</h2>
              <p className="ml-metric-value">
                <StatusMarker
                  marker={statusMarker(
                    data.scorerReady ? "ready" : "unavailable",
                  )}
                />
              </p>
              <p className="meta">Inference service health</p>
            </article>
            <article className="ml-metric-card">
              <span className="eyebrow">Predictions</span>
              <p className="ml-metric-value num">
                {data.predictionsTotal.toLocaleString()}
              </p>
              <p className="meta">Shadow predictions observed</p>
            </article>
            <article className="ml-metric-card">
              <span className="eyebrow">Inference p95</span>
              <p className="ml-metric-value num">
                {data.inferenceP95Ms == null ? (
                  <span className="ml-muted-value">No samples yet</span>
                ) : (
                  `${data.inferenceP95Ms.toFixed(1)} ms`
                )}
              </p>
              <p className="meta">95th percentile latency</p>
            </article>
            <article className="ml-metric-card">
              <span className="eyebrow">Canary traffic</span>
              <p className="ml-metric-value num">
                {data.canaryPercentage.toFixed(1)}
                <span className="ml-unit">%</span>
              </p>
              <p className="meta">Traffic on candidate model</p>
            </article>
          </div>
          <section className="ml-panel" aria-labelledby="active-model-heading">
            <SectionHeading
              id="active-model-heading"
              title="Active model"
              description="Current scorer configuration and eligibility."
            />
            <ModelIdentity data={data.model} />
            <dl className="ml-facts">
              <div>
                <dt>Model mode</dt>
                <dd>
                  <StatusMarker
                    marker={statusMarker(
                      data.model.mode === "shadow"
                        ? "degraded"
                        : data.model.status,
                    )}
                  />{" "}
                  {data.model.mode}
                </dd>
              </div>
              <div>
                <dt>Data origin</dt>
                <dd>{data.model.dataOrigin}</dd>
              </div>
              <div>
                <dt>Production eligibility</dt>
                <dd>
                  {data.model.productionEligible ? (
                    <StatusMarker marker={{ kind: "ok", word: "Eligible" }} />
                  ) : (
                    <span className="ml-state-muted">
                      Not eligible · synthetic and shadow
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </section>
          <section className="ml-panel" aria-labelledby="drift-heading">
            <SectionHeading
              id="drift-heading"
              title="Feature drift"
              description="Population stability across the active model’s input features."
              action={
                <NavLink className="ml-text-link" to="/ml/drift">
                  View drift <span aria-hidden="true">→</span>
                </NavLink>
              }
            />
            <DriftRows data={data.drift} />
          </section>
          <div className="ml-overview-grid">
            <section
              className="ml-panel ml-analytics-panel"
              aria-labelledby="analytics-heading"
            >
              <SectionHeading
                id="analytics-heading"
                title="Telemetry analytics"
                description="Tenant-filtered 24-hour aggregates from the optional ClickHouse lab."
              />
              {data.analytics.status === "ready" ? (
                <>
                  <div className="ml-analytics-metrics">
                    <div>
                      <span className="eyebrow">Readings</span>
                      <strong className="num">
                        {data.analytics.rows.toLocaleString()}
                      </strong>
                    </div>
                    <div>
                      <span className="eyebrow">Bins</span>
                      <strong className="num">
                        {data.analytics.bins.toLocaleString()}
                      </strong>
                    </div>
                    <div>
                      <span className="eyebrow">Avg. temperature</span>
                      <strong className="num">
                        {data.analytics.averageTemperatureC == null
                          ? "—"
                          : `${data.analytics.averageTemperatureC.toFixed(1)}°C`}
                      </strong>
                    </div>
                    <div>
                      <span className="eyebrow">Avg. humidity</span>
                      <strong className="num">
                        {data.analytics.averageHumidityPercent == null
                          ? "—"
                          : `${data.analytics.averageHumidityPercent.toFixed(1)}%`}
                      </strong>
                    </div>
                  </div>
                </>
              ) : (
                <div className="ml-inline-empty">
                  <span className="ml-empty-icon" aria-hidden="true">
                    —
                  </span>
                  <div>
                    <strong>ClickHouse analytics not connected</strong>
                    <p className="meta">
                      Start the optional local analytics profile to see
                      synthetic telemetry summaries. ML scoring remains
                      available without it.
                    </p>
                  </div>
                </div>
              )}
            </section>
            <section className="ml-panel" aria-labelledby="performance-heading">
              <SectionHeading
                id="performance-heading"
                title="Performance"
                description="Evaluation against labeled outcomes."
                action={
                  <NavLink className="ml-text-link" to="/ml/performance">
                    Details <span aria-hidden="true">→</span>
                  </NavLink>
                }
              />
              {performanceReady ? (
                <div className="ml-score">
                  <strong>{data.performance.brierScore!.toFixed(4)}</strong>
                  <span>Brier score</span>
                  <p className="meta">
                    {data.performance.sampleCount.toLocaleString()} evaluated
                    labels
                  </p>
                </div>
              ) : (
                <div className="ml-inline-empty">
                  <span className="ml-empty-icon" aria-hidden="true">
                    —
                  </span>
                  <div>
                    <strong>Evaluation data not available</strong>
                    <p className="meta">
                      No labeled outcomes have been evaluated yet.
                    </p>
                  </div>
                </div>
              )}
            </section>
            <section className="ml-panel" aria-labelledby="versions-heading">
              <SectionHeading
                id="versions-heading"
                title="Model versions"
                description={`${data.models.length} registered ${data.models.length === 1 ? "version" : "versions"}`}
                action={
                  <NavLink className="ml-text-link" to="/ml/models">
                    Registry <span aria-hidden="true">→</span>
                  </NavLink>
                }
              />
              <ModelList data={data.models} />
            </section>
          </div>
          <section
            className="ml-panel ml-retraining-summary"
            aria-labelledby="retraining-heading"
          >
            <div>
              <SectionHeading
                id="retraining-heading"
                title="Retraining"
                description="Latest workflow status."
              />
              <p className="ml-inline-status">
                <StatusMarker
                  marker={statusMarker(
                    data.retraining.status === "idle"
                      ? "healthy"
                      : data.retraining.status,
                  )}
                />{" "}
                {data.retraining.status}
                {data.retraining.runId && (
                  <span className="meta"> · Run {data.retraining.runId}</span>
                )}
              </p>
            </div>
            <NavLink className="ml-text-link" to="/ml/retraining">
              View workflow <span aria-hidden="true">→</span>
            </NavLink>
          </section>
        </>
      )}
      {section === "drift" && (
        <section
          className="ml-panel ml-detail-panel"
          aria-labelledby="drift-heading"
        >
          <SectionHeading
            id="drift-heading"
            title="Feature drift"
            description="Population stability for the active model’s input features. Values are shown only when the scorer has enough observations."
          />
          <DriftRows data={data.drift} />
        </section>
      )}
      {section === "performance" && (
        <section
          className="ml-panel ml-detail-panel"
          aria-labelledby="performance-heading"
        >
          <SectionHeading
            id="performance-heading"
            title="Model performance"
            description="Metrics are calculated from evaluated, labeled outcomes."
          />
          {performanceReady ? (
            <div className="ml-performance-card">
              <span className="eyebrow">Brier score</span>
              <strong className="num">
                {data.performance.brierScore!.toFixed(4)}
              </strong>
              <p>
                {data.performance.sampleCount.toLocaleString()} evaluated labels
              </p>
              {data.performance.evaluatedAt && (
                <p className="meta">
                  Last evaluated {formatTimestamp(data.performance.evaluatedAt)}
                </p>
              )}
            </div>
          ) : (
            <div className="ml-empty-panel">
              <div className="ml-empty-icon" aria-hidden="true">
                ∿
              </div>
              <h3>Waiting for labeled outcomes</h3>
              <p>
                Performance metrics will appear after predictions can be matched
                with verified outcomes. Until then, this model remains in shadow
                evaluation.
              </p>
              <div className="ml-empty-stat">
                <strong>{data.performance.sampleCount.toLocaleString()}</strong>
                <span>evaluated labels</span>
              </div>
            </div>
          )}
        </section>
      )}
      {section === "models" && (
        <>
          <section
            className="ml-panel"
            aria-labelledby="registry-active-heading"
          >
            <SectionHeading
              id="registry-active-heading"
              title="Active model"
              description="Model currently configured on the scorer."
            />
            <ModelIdentity data={data.model} />
            <dl className="ml-facts">
              <div>
                <dt>Mode</dt>
                <dd>
                  <StatusMarker
                    marker={statusMarker(
                      data.model.mode === "shadow"
                        ? "degraded"
                        : data.model.status,
                    )}
                  />{" "}
                  {data.model.mode}
                </dd>
              </div>
              <div>
                <dt>Data origin</dt>
                <dd>{data.model.dataOrigin}</dd>
              </div>
              <div>
                <dt>Production eligibility</dt>
                <dd>
                  {data.model.productionEligible
                    ? "Eligible"
                    : "Not eligible · synthetic and shadow"}
                </dd>
              </div>
            </dl>
          </section>
          <section className="ml-panel" aria-labelledby="versions-heading">
            <SectionHeading
              id="versions-heading"
              title="Registered versions"
              description="Versions available in the model registry."
            />
            <ModelList data={data.models} />
          </section>
          <section className="ml-panel" aria-labelledby="model-actions-heading">
            <SectionHeading
              id="model-actions-heading"
              title="Model actions"
              description="Promotion and rollback require an operator role and production-eligible model evidence."
            />
            {!data.model.productionEligible && (
              <div className="ml-action-lock">
                <span className="ml-lock-icon">Restricted</span>
                <div>
                  <strong>Actions unavailable for this model</strong>
                  <p className="meta">
                    Synthetic shadow evidence cannot be promoted to production.
                  </p>
                </div>
              </div>
            )}
            <div className="button-row">
              <button
                className="btn btn-primary"
                type="button"
                disabled={!data.model.productionEligible || action.isPending}
                onClick={() =>
                  action.mutate({
                    name: "promote",
                    version: data.model.version,
                  })
                }
              >
                Promote
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={!data.model.productionEligible || action.isPending}
                onClick={() =>
                  action.mutate({
                    name: "rollback",
                    version: data.model.version,
                  })
                }
              >
                Rollback
              </button>
            </div>
            {action.isError && (
              <p role="alert" className="field-error">
                {action.error instanceof Error
                  ? action.error.message
                  : "ML action failed."}
              </p>
            )}
            {action.isSuccess && (
              <p role="status" className="meta">
                {action.data?.message ?? "Action accepted."}
              </p>
            )}
          </section>
        </>
      )}
      {section === "retraining" && (
        <>
          <section
            className="ml-panel"
            aria-labelledby="retraining-status-heading"
          >
            <SectionHeading
              id="retraining-status-heading"
              title="Retraining status"
              description="The latest model training workflow reported by the control plane."
            />
            <div className="ml-retraining-state">
              <span className="ml-state-orb" aria-hidden="true" />
              <div>
                <strong>{data.retraining.status}</strong>
                <p className="meta">
                  {data.retraining.runId
                    ? `Run ${data.retraining.runId}`
                    : "No active retraining run"}
                </p>
                {data.retraining.completedAt && (
                  <p className="meta">
                    Completed {formatTimestamp(data.retraining.completedAt)}
                  </p>
                )}
              </div>
            </div>
          </section>
          <section
            className="ml-panel"
            aria-labelledby="retraining-actions-heading"
          >
            <SectionHeading
              id="retraining-actions-heading"
              title="Start a retraining run"
              description="Training requests are guarded by model and data eligibility."
            />
            {!data.model.productionEligible && (
              <div className="ml-retraining-gate">
                <span className="ml-gate-icon" aria-hidden="true">
                  !
                </span>
                <div>
                  <strong>
                    Dashboard retraining is unavailable for synthetic shadow
                    models
                  </strong>
                  <p>
                    The active model is synthetic and shadow-only. The local
                    offline retraining and release-controller workflow is
                    separate; this page will not submit a request the scorer
                    rejects.
                  </p>
                </div>
              </div>
            )}
            <div className="button-row">
              <button
                className="btn btn-primary"
                type="button"
                disabled={!data.model.productionEligible || action.isPending}
                onClick={() => action.mutate({ name: "retrain" })}
              >
                Start retraining
              </button>
            </div>
            {action.isError && (
              <p role="alert" className="field-error">
                {action.error instanceof Error
                  ? action.error.message
                  : "ML action failed."}
              </p>
            )}
            {action.isSuccess && (
              <p role="status" className="meta">
                {action.data?.message ?? "Action accepted."}
              </p>
            )}
          </section>
        </>
      )}
      {section !== "overview" && !data.model.productionEligible && (
        <div className="ml-page-footnote">
          <span>Model safety</span>
          <p>
            Synthetic-data shadow evaluation only · predictions are not
            production validated.
          </p>
        </div>
      )}
    </section>
  );
}
