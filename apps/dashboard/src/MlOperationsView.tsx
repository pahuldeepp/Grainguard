import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { MlApi } from "./ml-api";
import { formatTimestamp } from "./format";
import { EmptyState, ErrorState, Loading, PageHeader, StatusMarker } from "./ui";
import type { Marker } from "./severity";

function statusMarker(value: string): Marker {
  if (value === "healthy" || value === "ready") return { kind: "ok", word: "Ready" };
  if (value === "elevated" || value === "degraded") return { kind: "warning", word: "Attention" };
  return { kind: "critical", word: "Unavailable" };
}

export function MlOperationsView({ api, sessionId }: { api: MlApi | null; sessionId?: string }) {
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
    mutationFn: ({ name, version }: { name: "promote" | "rollback" | "retrain"; version?: string }) => api!.action(name, version),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["ml-operations", sessionId] }),
  });

  if (!api || !sessionId)
    return <section className="read-view"><PageHeader id="ml-title" title="ML operations" /><EmptyState title="Sign in to view ML operations." /></section>;
  if (query.isPending) return <section className="read-view"><PageHeader id="ml-title" title="ML operations" /><Loading label="Loading ML operations…" rows={3} /></section>;
  if (query.isError) return <section className="read-view"><PageHeader id="ml-title" title="ML operations" /><ErrorState message="ML operations are temporarily unavailable." onRetry={() => void query.refetch()} /></section>;

  const data = query.data;
  return (
    <section className="read-view" aria-labelledby="ml-title">
      <PageHeader id="ml-title" title="ML operations">
        Operator view · captured {formatTimestamp(data.capturedAt)}
      </PageHeader>
      <nav aria-label="ML operations" className="section-nav">
        <Link to="/ml">Overview</Link> · <Link to="/ml/drift">Drift</Link> · <Link to="/ml/performance">Performance</Link> · <Link to="/ml/models">Models</Link> · <Link to="/ml/retraining">Retraining</Link>
      </nav>
      <div className="metric-grid">
        <article className="status-card"><h2>Scorer</h2><p><StatusMarker marker={statusMarker(data.scorerReady ? "ready" : "unavailable")} /> {data.scorerReady ? "Ready" : "Unavailable"}</p></article>
        <article className="status-card"><h2>Predictions</h2><p className="num data">{data.predictionsTotal.toLocaleString()}</p><p className="meta">Observed shadow predictions</p></article>
        <article className="status-card"><h2>Inference p95</h2><p className="num data">{data.inferenceP95Ms == null ? "Unavailable" : `${data.inferenceP95Ms.toFixed(1)} ms`}</p></article>
        <article className="status-card"><h2>Canary traffic</h2><p className="num data">{data.canaryPercentage.toFixed(1)}%</p></article>
      </div>
      <section className="section" aria-labelledby="model-status-title">
        <h2 id="model-status-title">Active model</h2>
        <dl className="details">
          <dt>Name</dt><dd>{data.model.name}</dd><dt>Version</dt><dd>{data.model.version}</dd>
          <dt>Mode</dt><dd><StatusMarker marker={statusMarker(data.model.mode === "shadow" ? "degraded" : data.model.status)} /> {data.model.mode}</dd>
          <dt>Data origin</dt><dd>{data.model.dataOrigin}</dd>
          <dt>Production eligible</dt><dd>{data.model.productionEligible ? "Yes" : "No — synthetic/shadow only"}</dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="drift-title"><h2 id="drift-title">Feature drift</h2><ul className="rows">{data.drift.map((item) => <li className="service-row" key={item.feature}><div><h3>{item.feature}</h3><p className="meta">{item.sampleCount.toLocaleString()} observations</p></div><span><StatusMarker marker={statusMarker(item.status)} /> {item.psi == null ? "Warming" : `PSI ${item.psi.toFixed(3)}`}</span></li>)}</ul></section>
      <section className="section" aria-labelledby="performance-title"><h2 id="performance-title">Performance</h2><p><StatusMarker marker={statusMarker(data.performance.status)} /> {data.performance.status}</p><p className="meta">Brier score: {data.performance.brierScore == null ? "Unavailable until labeled outcomes exist" : data.performance.brierScore.toFixed(4)} · {data.performance.sampleCount.toLocaleString()} evaluated labels</p></section>
      <section className="section" aria-labelledby="models-title"><h2 id="models-title">Model versions</h2><ul className="rows">{data.models.map((model) => <li className="service-row" key={model.version}><div><h3>{model.version}</h3><p className="meta">{model.name} · {model.dataOrigin}</p></div><span><StatusMarker marker={statusMarker(model.mode === "shadow" ? "degraded" : model.status)} /> {model.mode}</span></li>)}</ul></section>
      <section className="section" aria-labelledby="retraining-title"><h2 id="retraining-title">Retraining</h2><p><StatusMarker marker={statusMarker(data.retraining.status === "idle" ? "healthy" : data.retraining.status)} /> {data.retraining.status}</p>{data.retraining.runId && <p className="meta">Run {data.retraining.runId}</p>}</section>
      <section className="section" aria-labelledby="actions-title"><h2 id="actions-title">Operator actions</h2><p className="meta">Actions require operator/admin role and production-eligible model evidence.</p><div className="button-row"><button className="btn btn-primary" type="button" disabled={!data.model.productionEligible || action.isPending} onClick={() => action.mutate({ name: "promote", version: data.model.version })}>Promote</button><button className="btn btn-secondary" type="button" disabled={!data.model.productionEligible || action.isPending} onClick={() => action.mutate({ name: "rollback", version: data.model.version })}>Rollback</button><button className="btn btn-secondary" type="button" disabled={action.isPending} onClick={() => action.mutate({ name: "retrain" })}>Start retraining</button></div>{action.isError && <p role="alert" className="field-error">{action.error instanceof Error ? action.error.message : "ML action failed."}</p>}{action.isSuccess && <p role="status" className="meta">{action.data?.message ?? "Action accepted."}</p>}</section>
      <p className="banner warning">This model is synthetic/shadow and is not production validated. Promotion and retraining controls remain operator-only.</p>
    </section>
  );
}
