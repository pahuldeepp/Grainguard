import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import { formatTimestamp } from "./format";
import { deviceStatusMarker } from "./severity";
import {
  EmptyState,
  ErrorState,
  FieldError,
  Glyph,
  Loading,
  PageHeader,
  StatusMarker,
} from "./ui";
import {
  ReadApi,
  type DeviceView,
  type ReadingView,
  type RollupView,
} from "./read-api";

function message(error: unknown) {
  if (!(error instanceof Error))
    return "Device data is temporarily unavailable.";
  if (/FORBIDDEN|UNAUTHORIZED|401|403/i.test(error.message))
    return "Your session cannot access this device. Sign in again or choose another device.";
  if (/unavailable|read_busy|\b50[23]\b/i.test(error.message))
    return "Device data is temporarily unavailable. Try again shortly.";
  return error.message;
}

function value(number: number | null | undefined, unit: string) {
  return number == null
    ? "No measurement"
    : `${number.toLocaleString()} ${unit}`;
}

function Moment({ iso }: Readonly<{ iso: string }>) {
  return (
    <time dateTime={iso} title={iso}>
      {formatTimestamp(iso)}
    </time>
  );
}

function ReadingTable({ readings }: Readonly<{ readings: ReadingView[] }>) {
  return (
    <div
      className="table-wrap"
      role="region"
      aria-label="Readings"
      tabIndex={0}
    >
      <table className="read-table" role="table">
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              Observed
            </th>
            <th scope="col" role="columnheader">
              Received
            </th>
            <th scope="col" role="columnheader">
              Projected
            </th>
            <th scope="col" role="columnheader">
              Temperature
            </th>
            <th scope="col" role="columnheader">
              Humidity
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {readings.map((reading) => (
            <tr key={reading.readingId} role="row">
              <td role="cell" data-label="Observed">
                <Moment iso={reading.observedAt} />
              </td>
              <td role="cell" data-label="Received">
                <Moment iso={reading.receivedAt} />
              </td>
              <td role="cell" data-label="Projected">
                {reading.projectedAt ? (
                  <Moment iso={reading.projectedAt} />
                ) : (
                  "Unavailable"
                )}
              </td>
              <td role="cell" data-label="Temperature">
                {value(reading.temperatureC, "°C")}
              </td>
              <td role="cell" data-label="Humidity">
                {value(reading.relativeHumidityPercent, "%")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BackLink({
  to,
  children,
}: Readonly<{ to: string; children: string }>) {
  return (
    <Link to={to} className="back">
      <Glyph name="arrow-left" />
      {children}
    </Link>
  );
}

export function DeviceSearch({
  api,
  sessionId,
}: Readonly<{
  api: ReadApi | null;
  sessionId?: string;
}>) {
  const [draft, setDraft] = useState("");
  const [term, setTerm] = useState("");
  const search = useQuery({
    queryKey: ["read", sessionId, "search", term],
    queryFn: () => api!.search(term),
    enabled: Boolean(api && sessionId && term),
    retry: false,
    gcTime: 0,
  });
  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setTerm(draft.trim());
  }
  return (
    <section className="read-view" aria-labelledby="search-title">
      <PageHeader id="search-title" title="Find a device">
        Search your workspace by device name, ID or serial number.
      </PageHeader>
      {!api || !sessionId ? (
        <EmptyState title="Sign in to search devices." />
      ) : (
        <>
          <form onSubmit={submit} role="search">
            <div className="field">
              <label htmlFor="device-search">
                Device name, ID, or serial number
              </label>
              <div className="search-row">
                <input
                  id="device-search"
                  className="input"
                  type="search"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  autoComplete="off"
                  maxLength={100}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!draft.trim()}
                >
                  Search
                </button>
              </div>
            </div>
          </form>
          <div className="section">
            {!term && (
              <EmptyState title="Enter a device name, ID, or serial number to search your workspace." />
            )}
            {search.isPending && term && (
              <Loading label="Searching devices…" rows={2} />
            )}
            {search.isError && (
              <ErrorState
                message={message(search.error)}
                onRetry={() => void search.refetch()}
              />
            )}
            {search.isSuccess &&
              (search.data.length ? (
                <ul className="rows">
                  {search.data.map((device) => (
                    <li key={device.deviceId} className="link-row">
                      <Link
                        to={`/devices/${encodeURIComponent(device.deviceId)}`}
                      >
                        {device.name || device.deviceId}
                      </Link>
                      <span className="meta search-meta">
                        {device.status ? (
                          <StatusMarker
                            marker={deviceStatusMarker(device.status)}
                          />
                        ) : (
                          "Status unavailable"
                        )}
                        {device.siteId ? " · Site name not projected" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No devices match this search.">
                  Check the spelling or try the serial number.
                </EmptyState>
              ))}
          </div>
        </>
      )}
    </section>
  );
}

function CurrentResult({
  device,
  latestReading,
  deviceId,
}: Readonly<{
  device: DeviceView | null;
  latestReading: ReadingView | null;
  deviceId: string;
}>) {
  if (!device)
    return <EmptyState title="Device not found in your workspace." />;
  return (
    <>
      <div className="status-card">
        <p className="row-title">
          <strong>{device.name || device.deviceId}</strong>
        </p>
        <p className="meta search-meta">
          {device.status && (
            <StatusMarker marker={deviceStatusMarker(device.status)} />
          )}
          {device.siteId && " Site name not projected"}
          {device.binId && (
            <>
              {" "}
              ·{" "}
              <Link to={`/bins/${encodeURIComponent(device.binId)}`}>
                View bin readings
              </Link>
            </>
          )}
        </p>
      </div>
      <section className="section" aria-labelledby="latest-title">
        <h2 id="latest-title">Latest reading</h2>
        {latestReading ? (
          <ReadingTable readings={[latestReading]} />
        ) : (
          <EmptyState title="No readings have been projected for this device yet." />
        )}
      </section>
      <section className="section" aria-labelledby="more-title">
        <h2 id="more-title">More data</h2>
        <ul className="rows">
          <li className="link-row">
            <Link to={`/devices/${encodeURIComponent(deviceId)}/history`}>
              View reading history
            </Link>
            <span className="meta">Every reading in a time range.</span>
          </li>
          <li className="link-row">
            <Link to={`/devices/${encodeURIComponent(deviceId)}/rollups`}>
              View hourly or daily averages
            </Link>
            <span className="meta">Averages grouped by hour or day.</span>
          </li>
        </ul>
      </section>
    </>
  );
}

export function DeviceCurrent({
  api,
  sessionId,
}: Readonly<{
  api: ReadApi | null;
  sessionId?: string;
}>) {
  const { deviceId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const acceptedReadingId = searchParams.get("readingId")?.trim() || "";
  const tracking = useRef({ id: acceptedReadingId, startedAt: Date.now() });
  if (tracking.current.id !== acceptedReadingId)
    tracking.current = { id: acceptedReadingId, startedAt: Date.now() };
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: ["read", sessionId, "current", deviceId],
    queryFn: () => api!.current(deviceId),
    enabled: Boolean(api && sessionId && deviceId),
    retry: false,
    gcTime: 0,
    refetchInterval: 30000,
  });
  const accepted = useQuery({
    queryKey: ["read", sessionId, "accepted", acceptedReadingId],
    queryFn: () => api!.reading(acceptedReadingId),
    enabled: Boolean(api && sessionId && deviceId && acceptedReadingId),
    retry: false,
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data?.projectedAt ||
      Date.now() - tracking.current.startedAt > 60_000
        ? false
        : 2000,
  });
  useEffect(() => {
    if (!api || !sessionId || !deviceId) return;
    return api.subscribeDevice?.(deviceId, () => {
      void queryClient.invalidateQueries({
        queryKey: ["read", sessionId, "current", deviceId],
      });
      if (acceptedReadingId)
        void queryClient.invalidateQueries({
          queryKey: ["read", sessionId, "accepted", acceptedReadingId],
        });
    });
  }, [api, sessionId, deviceId, acceptedReadingId, queryClient]);
  let accessMessage = "";
  if (!api || !sessionId) accessMessage = "Sign in to view device readings.";
  else if (!deviceId) accessMessage = "Choose a device from search.";
  return (
    <section className="read-view" aria-labelledby="current-title">
      <PageHeader id="current-title" title="Current device reading" />
      {accessMessage ? (
        <EmptyState title={accessMessage} />
      ) : (
        <>
          <BackLink to="/devices">Device search</BackLink>
          {current.isPending && (
            <Loading label="Loading current reading…" rows={2} />
          )}
          {current.isError && (
            <ErrorState
              message={message(current.error)}
              onRetry={() => void current.refetch()}
            />
          )}
          {acceptedReadingId && accepted.isError && (
            <ErrorState message={message(accepted.error)} />
          )}
          {acceptedReadingId &&
            !accepted.isError &&
            accepted.data?.deviceId &&
            accepted.data.deviceId !== deviceId && (
              <ErrorState message="That reading belongs to a different device." />
            )}
          {acceptedReadingId &&
            !accepted.isError &&
            (!accepted.data || accepted.isPending) && (
              <output className="loading-label">
                Stored; updating dashboard…
              </output>
            )}
          {acceptedReadingId &&
            accepted.data?.deviceId === deviceId &&
            accepted.data.projectedAt && (
              <output className="loading-label">
                Reading processed at{" "}
                <time dateTime={accepted.data.projectedAt}>
                  {accepted.data.projectedAt}
                </time>
                .
                {current.data?.latestReading?.readingId !== acceptedReadingId &&
                  " This historical reading did not replace the latest reading."}
              </output>
            )}
          {current.isSuccess && (
            <CurrentResult {...current.data} deviceId={deviceId} />
          )}
        </>
      )}
    </section>
  );
}

function defaultRange() {
  const now = new Date();
  const asLocalInput = (date: Date) =>
    new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  return {
    from: asLocalInput(new Date(now.getTime() - 12 * 60 * 60 * 1000)),
    to: asLocalInput(now),
  };
}

function validIsoRange(from: string, to: string) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    return null;
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
  };
}

export function DeviceHistory({
  api,
  sessionId,
}: Readonly<{
  api: ReadApi | null;
  sessionId?: string;
}>) {
  const { deviceId = "" } = useParams();
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [validation, setValidation] = useState("");
  const history = useQuery({
    queryKey: ["read", sessionId, "history", deviceId, range?.from, range?.to],
    queryFn: () => api!.history(deviceId, range!.from, range!.to, 100),
    enabled: Boolean(api && sessionId && deviceId && range),
    retry: false,
    gcTime: 0,
  });
  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextRange = validIsoRange(from, to);
    if (!nextRange) {
      setValidation("Choose a valid start time before the end time.");
      return;
    }
    setValidation("");
    setRange(nextRange);
  }
  let accessMessage = "";
  if (!api || !sessionId) accessMessage = "Sign in to view reading history.";
  else if (!deviceId) accessMessage = "Choose a device from search.";
  return (
    <section className="read-view" aria-labelledby="history-title">
      <PageHeader id="history-title" title="Reading history">
        Up to 100 readings in a time range, newest first.
      </PageHeader>
      {accessMessage ? (
        <EmptyState title={accessMessage} />
      ) : (
        <>
          <BackLink to={`/devices/${encodeURIComponent(deviceId)}`}>
            Current reading
          </BackLink>
          <form className="form" onSubmit={submit}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="history-from">From</label>
                <input
                  id="history-from"
                  className="input"
                  type="datetime-local"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="history-to">To</label>
                <input
                  id="history-to"
                  className="input"
                  type="datetime-local"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  required
                />
              </div>
            </div>
            {validation && (
              <FieldError id="history-range-error">{validation}</FieldError>
            )}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                Load history
              </button>
            </div>
          </form>
          <div className="section">
            {!range && (
              <EmptyState title="Select a time range to load up to 100 readings." />
            )}
            {history.isPending && range && (
              <Loading label="Loading reading history…" />
            )}
            {history.isError && (
              <ErrorState
                message={message(history.error)}
                onRetry={() => void history.refetch()}
              />
            )}
            {history.isSuccess &&
              (history.data.length ? (
                <>
                  <p className="meta table-note">
                    Showing up to 100 readings, newest first.
                  </p>
                  <ReadingTable readings={history.data} />
                </>
              ) : (
                <EmptyState title="No readings in this time range." />
              ))}
          </div>
        </>
      )}
    </section>
  );
}

function RollupTable({ rollups }: Readonly<{ rollups: RollupView[] }>) {
  return (
    <div
      className="table-wrap"
      role="region"
      aria-label="Averages"
      tabIndex={0}
    >
      <table className="read-table" role="table">
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              Bucket start
            </th>
            <th scope="col" role="columnheader">
              Samples
            </th>
            <th scope="col" role="columnheader">
              Average temperature
            </th>
            <th scope="col" role="columnheader">
              Average humidity
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rollups.map((item) => (
            <tr key={item.bucketStart} role="row">
              <td role="cell" data-label="Bucket start">
                <Moment iso={item.bucketStart} />
              </td>
              <td role="cell" data-label="Samples">
                {item.sampleCount}
              </td>
              <td role="cell" data-label="Average temperature">
                {value(item.avgTemperatureC, "°C")}
              </td>
              <td role="cell" data-label="Average humidity">
                {value(item.avgRelativeHumidityPercent, "%")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DeviceRollups({
  api,
  sessionId,
}: Readonly<{ api: ReadApi | null; sessionId?: string }>) {
  const { deviceId = "" } = useParams();
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [bucket, setBucket] = useState<"hour" | "day">("hour");
  const [range, setRange] = useState<{
    from: string;
    to: string;
    bucket: "hour" | "day";
  } | null>(null);
  const [validation, setValidation] = useState("");
  const rollups = useQuery({
    queryKey: ["read", sessionId, "rollups", deviceId, range],
    queryFn: () =>
      api!.rollups(deviceId, range!.from, range!.to, range!.bucket),
    enabled: Boolean(api && sessionId && deviceId && range),
    retry: false,
    gcTime: 0,
  });
  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextRange = validIsoRange(from, to);
    if (!nextRange) {
      setValidation("Choose a valid start time before the end time.");
      return;
    }
    setValidation("");
    setRange({
      ...nextRange,
      bucket,
    });
  }
  return (
    <section className="read-view" aria-labelledby="rollups-title">
      <PageHeader id="rollups-title" title="Reading averages">
        Average temperature and humidity for each hour or day.
      </PageHeader>
      {!api || !sessionId ? (
        <EmptyState title="Sign in to view reading averages." />
      ) : (
        <>
          <BackLink to={`/devices/${encodeURIComponent(deviceId)}`}>
            Current reading
          </BackLink>
          <form className="form" onSubmit={submit}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="rollup-from">From</label>
                <input
                  id="rollup-from"
                  className="input"
                  type="datetime-local"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="rollup-to">To</label>
                <input
                  id="rollup-to"
                  className="input"
                  type="datetime-local"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="rollup-bucket">Group by</label>
                <select
                  id="rollup-bucket"
                  className="select"
                  value={bucket}
                  onChange={(event) =>
                    setBucket(event.target.value as "hour" | "day")
                  }
                >
                  <option value="hour">Hour</option>
                  <option value="day">Day</option>
                </select>
              </div>
            </div>
            {validation && (
              <FieldError id="rollup-range-error">{validation}</FieldError>
            )}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                Load averages
              </button>
            </div>
          </form>
          <div className="section">
            {rollups.isPending && range && (
              <Loading label="Loading averages…" />
            )}
            {rollups.isError && (
              <ErrorState
                message={message(rollups.error)}
                onRetry={() => void rollups.refetch()}
              />
            )}
            {rollups.isSuccess &&
              (rollups.data.length ? (
                <RollupTable rollups={rollups.data} />
              ) : (
                <EmptyState title="No averages in this time range." />
              ))}
          </div>
        </>
      )}
    </section>
  );
}
