import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { binLabel } from "./bin-label";
import { formatTimestamp } from "./format";
import type {
  BinLatestView,
  BinPolicy,
  BinTrendView,
  ReadApi,
} from "./read-api";
import { EmptyState, ErrorState, Glyph, Loading, PageHeader } from "./ui";

const metricNames: Record<string, { label: string; unit: string }> = {
  temperature_c: { label: "Temperature", unit: "°C" },
  relative_humidity_percent: { label: "Relative humidity", unit: "%" },
  co2_ppm: { label: "Carbon dioxide", unit: "ppm" },
  grain_moisture_percent: { label: "Grain moisture", unit: "%" },
};

function metricName(metric: string) {
  return metricNames[metric] ?? { label: metric, unit: "" };
}

function metricValue(value: number | null, unit: string) {
  return value === null
    ? "No observation"
    : `${value.toLocaleString()} ${unit}`;
}

function policyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return "Policy details unavailable";
  }
}

function LatestReadings({ data }: Readonly<{ data: BinLatestView }>) {
  const readingByMetric = new Map(
    data.readings.map((row) => [row.metric, row]),
  );
  const metrics = Object.entries(metricNames);
  return (
    <section className="section" aria-labelledby="bin-latest-title">
      <h2 id="bin-latest-title">Latest readings</h2>
      <div className="metric-grid">
        {metrics.map(([metric, descriptor]) => {
          const row = readingByMetric.get(metric);
          return (
            <article className="status-card" key={metric}>
              <h3>{descriptor.label}</h3>
              <p className="num data">
                {row ? metricValue(row.value, descriptor.unit) : "Not measured"}
              </p>
              {row ? (
                <p className="meta">
                  Observed{" "}
                  <time dateTime={row.observedAt}>
                    {formatTimestamp(row.observedAt)}
                  </time>
                  {row.ageSeconds !== null &&
                    ` · ${Math.floor(row.ageSeconds)} seconds old`}
                  {row.stale === true ? " · stale" : ""}
                  {row.stale === false ? " · within configured freshness" : ""}
                </p>
              ) : (
                <p className="meta">
                  No projected sample is available for this metric.
                </p>
              )}
            </article>
          );
        })}
      </div>
      <p className="meta">
        Freshness:{" "}
        {data.freshness === "not_configured"
          ? "age is shown; stale limits are not configured"
          : data.freshness}
        .
      </p>
    </section>
  );
}

function Trend({ data }: Readonly<{ data: BinTrendView }>) {
  if (data.source !== "ok" && data.source !== "empty")
    return <p className="meta">Trend source: {data.source}.</p>;
  if (!data.buckets.length)
    return (
      <EmptyState title="No measurements in the reported trend coverage." />
    );
  return (
    <div
      className="table-wrap"
      role="region"
      aria-label="Bin reading trend"
      tabIndex={0}
    >
      <table className="read-table">
        <thead>
          <tr>
            <th scope="col">Bucket</th>
            <th scope="col">Metric</th>
            <th scope="col">Min</th>
            <th scope="col">Average</th>
            <th scope="col">Max</th>
            <th scope="col">Samples</th>
          </tr>
        </thead>
        <tbody>
          {data.buckets.map((bucket) => {
            const metric = metricName(bucket.metric);
            return (
              <tr key={`${bucket.bucketAt}:${bucket.metric}`}>
                <td>
                  <time dateTime={bucket.bucketAt}>
                    {formatTimestamp(bucket.bucketAt)}
                  </time>
                </td>
                <td>{metric.label}</td>
                <td>{metricValue(bucket.minValue, metric.unit)}</td>
                <td>{metricValue(bucket.averageValue, metric.unit)}</td>
                <td>{metricValue(bucket.maxValue, metric.unit)}</td>
                <td>{bucket.sampleCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Policies({ policies }: Readonly<{ policies: BinPolicy[] }>) {
  if (!policies.length)
    return (
      <EmptyState title="No applicable policy is projected for this bin." />
    );
  return (
    <ul className="rows">
      {policies.map((policy) => (
        <li
          className="service-row"
          key={`${policy.policyId}:${policy.policyVersion}`}
        >
          <div>
            <h3>
              {policy.grainType} · policy v{policy.policyVersion}
            </h3>
            <p className="meta">
              {policy.calibrated ? "Calibrated" : "Uncalibrated"} ·{" "}
              {policy.status}
            </p>
            <details className="technical-details">
              <summary>Threshold details</summary>
              <h4>Measurement thresholds</h4>
              <pre>{policyJson(policy.measurementThresholds)}</pre>
              <h4>Risk thresholds</h4>
              <pre>{policyJson(policy.riskThresholds)}</pre>
            </details>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function BinReadings({
  api,
  sessionId,
}: Readonly<{ api: ReadApi | null; sessionId?: string }>) {
  const { binId = "" } = useParams();
  const [window, setWindow] = useState<"H1" | "H6" | "H24">("H24");
  const latest = useQuery({
    queryKey: ["read", sessionId, "bin-latest", binId],
    queryFn: () => api!.binLatest(binId),
    enabled: Boolean(api && sessionId && binId),
    retry: false,
    gcTime: 0,
  });
  const trend = useQuery({
    queryKey: ["read", sessionId, "bin-trend", binId, window],
    queryFn: () => api!.binTrend(binId, window),
    enabled: Boolean(api && sessionId && binId),
    retry: false,
    gcTime: 0,
  });

  if (!api || !sessionId)
    return (
      <section className="read-view">
        <PageHeader id="bin-title" title="Bin readings" />
        <EmptyState title="Sign in to view bin data." />
      </section>
    );
  if (!binId)
    return (
      <section className="read-view">
        <PageHeader id="bin-title" title="Bin readings" />
        <EmptyState title="Choose a bin from an alert or device." />
      </section>
    );
  const name = latest.data?.bin
    ? binLabel(binId, latest.data.bin.name)
    : binLabel(binId);
  return (
    <section className="read-view" aria-labelledby="bin-title">
      <Link to="/devices" className="back">
        <Glyph name="arrow-left" />
        Devices
      </Link>
      <PageHeader id="bin-title" title={name}>
        {latest.data?.bin?.siteName?.trim() ||
          "Site name has not been projected yet."}
      </PageHeader>
      {latest.isPending && (
        <Loading label="Loading latest bin readings…" rows={2} />
      )}
      {latest.isError && (
        <ErrorState
          message="Bin readings are temporarily unavailable."
          onRetry={() => void latest.refetch()}
        />
      )}
      {latest.isSuccess && !latest.data && (
        <EmptyState title="Bin not found in your workspace." />
      )}
      {latest.isSuccess && latest.data && (
        <>
          {latest.data.devices.length === 0 ? (
            <EmptyState title="No eligible devices are bound to this bin.">
              Readings require an active device binding.
            </EmptyState>
          ) : (
            <>
              <p className="meta">
                {latest.data.devices.length} eligible device
                {latest.data.devices.length === 1 ? "" : "s"}
                {latest.data.devicesTruncated
                  ? " · list truncated at the service limit"
                  : ""}
                .
              </p>
              <LatestReadings data={latest.data} />
            </>
          )}
          <section className="section" aria-labelledby="trend-title">
            <div className="section-head">
              <h2 id="trend-title">Reading trends</h2>
              <div
                className="segmented"
                role="group"
                aria-label="Trend time window"
              >
                {(["H1", "H6", "H24"] as const).map((choice) => (
                  <button
                    key={choice}
                    className="segment"
                    type="button"
                    aria-pressed={window === choice}
                    onClick={() => setWindow(choice)}
                  >
                    {choice === "H1"
                      ? "1 hour"
                      : choice === "H6"
                        ? "6 hours"
                        : "24 hours"}
                  </button>
                ))}
              </div>
            </div>
            {trend.isPending && <Loading label="Loading trend…" />}
            {trend.isError && (
              <ErrorState
                message="Trend data is temporarily unavailable. Latest readings remain available."
                onRetry={() => void trend.refetch()}
              />
            )}
            {trend.isSuccess && (
              <>
                <p className="meta">
                  Coverage: {formatTimestamp(trend.data.from)} to{" "}
                  {formatTimestamp(trend.data.to)} · {trend.data.resolution},{" "}
                  {trend.data.bucketSeconds}s buckets.
                </p>
                <Trend data={trend.data} />
              </>
            )}
          </section>
          <section className="section" aria-labelledby="sensor-title">
            <h2 id="sensor-title">Sensor placement</h2>
            {latest.data.layout.length ? (
              <ul className="rows">
                {latest.data.layout.map((sensor) => (
                  <li
                    className="service-row"
                    key={`${sensor.sensorId}:${sensor.position}`}
                  >
                    <div>
                      <h3>{sensor.label || `Sensor ${sensor.position}`}</h3>
                      <p className="meta">
                        Position {sensor.position}
                        {sensor.depthM === null
                          ? ""
                          : ` · ${sensor.depthM} m deep`}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Sensor positions are not configured." />
            )}
            <h3>Identified sensor readings</h3>
            {latest.data.sensorReadings.length ? (
              <ul className="rows">
                {latest.data.sensorReadings.map((sample) => (
                  <li
                    className="service-row"
                    key={`${sample.sensorId}:${sample.observedAt}:${sample.metric}`}
                  >
                    <div>
                      <h3>
                        {sample.label || sample.sensorId} ·{" "}
                        {metricName(sample.metric).label}
                      </h3>
                      <p className="meta">
                        {sample.value.toLocaleString()}{" "}
                        {metricName(sample.metric).unit} · observed{" "}
                        {formatTimestamp(sample.observedAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No identified sensor measurements are available." />
            )}
          </section>
          <section className="section" aria-labelledby="policy-title">
            <h2 id="policy-title">Active thresholds and calibration</h2>
            <Policies policies={latest.data.policies} />
          </section>
        </>
      )}
    </section>
  );
}
