import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ProvisioningApi, type ProvisioningStatus } from "./provisioning";
import { ProvisioningStateBadge } from "./ProvisioningStateBadge";
import { formatTimestamp } from "./format";
import { EmptyState, FieldError, Glyph, PageHeader } from "./ui";

const finished = new Set(["active", "compensated", "repair_required"]);
const startSchema = z.object({ deviceId: z.uuid(), assetId: z.uuid() });
type StartValues = z.infer<typeof startSchema>;

// Durable UI state survives a reload (tokens do not, ADR-0014): the tracked saga
// ID and the idempotency key per device/asset are scoped to the signed-in identity.
function identityOf(sessionId: string) {
  const cut = sessionId.lastIndexOf(":");
  return cut > 0 ? sessionId.slice(0, cut) : sessionId;
}
function readStored(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string): boolean {
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
export function idempotencyKeyFor(
  identity: string,
  deviceId: string,
  assetId: string,
): string {
  const name = `gg.provisioning.key:${identity}:${deviceId}:${assetId}`;
  const existing = readStored(name);
  if (existing) return existing;
  const created = crypto.randomUUID();
  writeStored(name, created);
  return created;
}
function initialSaga(identity: string, ignoreUrl: boolean): string {
  const fromUrl = ignoreUrl
    ? null
    : new URLSearchParams(window.location.search).get("saga");
  return (
    fromUrl?.trim() || readStored(`gg.provisioning.saga:${identity}`) || ""
  );
}
function rememberSaga(identity: string, sagaId: string) {
  writeStored(`gg.provisioning.saga:${identity}`, sagaId);
  const url = new URL(window.location.href);
  if (sagaId) url.searchParams.set("saga", sagaId);
  else url.searchParams.delete("saga");
  window.history.replaceState(window.history.state, "", url);
}
function useRoles(api: ProvisioningApi, sessionId: string) {
  const session = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.session(),
    retry: false,
    staleTime: 60_000,
  });
  const roles = session.data?.roles;
  // Unknown roles (older BFF) fall back to showing actions; the API enforces RBAC.
  const unknown = !roles && !session.isPending;
  return {
    pending: session.isPending,
    canStart:
      unknown || Boolean(roles?.some((r) => r === "operator" || r === "admin")),
    canRedrive: unknown || Boolean(roles?.includes("admin")),
  };
}

export function Provisioning({
  api,
  sessionId,
}: Readonly<{
  api: ProvisioningApi | null;
  sessionId?: string;
}>) {
  const identity = sessionId ? identityOf(sessionId) : undefined;
  const previousIdentity = useRef(identity);
  const switchedIdentity = Boolean(
    previousIdentity.current &&
    identity &&
    previousIdentity.current !== identity,
  );
  useEffect(() => {
    if (switchedIdentity) {
      const url = new URL(window.location.href);
      url.searchParams.delete("saga");
      window.history.replaceState(window.history.state, "", url);
    }
    previousIdentity.current = identity;
  }, [identity, switchedIdentity]);
  if (!api || !sessionId)
    return (
      <section className="provisioning" aria-labelledby="provisioning-title">
        <PageHeader id="provisioning-title" title="Sensor provisioning" />
        <EmptyState title="Sign-in integration is required to start or view provisioning." />
      </section>
    );
  return (
    <ProvisioningSession
      key={sessionId}
      api={api}
      sessionId={sessionId}
      ignoreUrl={switchedIdentity}
    />
  );
}

function ProvisioningSession({
  api,
  sessionId,
  ignoreUrl,
}: Readonly<{
  api: ProvisioningApi;
  sessionId: string;
  ignoreUrl: boolean;
}>) {
  const {
    register,
    handleSubmit,
    formState: { errors: formErrors },
  } = useForm<StartValues>({
    resolver: zodResolver(startSchema),
    defaultValues: (() => {
      if (ignoreUrl) return {};
      const params = new URLSearchParams(window.location.search);
      const values = {
        deviceId: params.get("deviceId"),
        assetId: params.get("assetId"),
      };
      const parsed = startSchema.safeParse(values);
      return parsed.success ? parsed.data : {};
    })(),
  });
  const identity = identityOf(sessionId);
  const roles = useRoles(api, sessionId);
  const [sagaId, setSagaId] = useState(() => initialSaga(identity, ignoreUrl));
  const trackSaga = (next: string) => {
    setSagaId(next);
    rememberSaga(identity, next);
  };
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{
    deviceId: string;
    assetId: string;
    key: string;
  } | null>(null);
  const queryClient = useQueryClient();
  const queryKey = ["provisioning", sessionId, sagaId] as const;
  const statusQuery = useQuery<ProvisioningStatus>({
    queryKey,
    queryFn: async () => {
      const next = await api.status(sagaId);
      const current = queryClient.getQueryData<ProvisioningStatus>(queryKey);
      if (!current) return next;
      return current.saga.version > next.saga.version ? current : next;
    },
    enabled: Boolean(sagaId),
    refetchInterval: 5000,
    retry: false,
    gcTime: 0,
  });
  const status = statusQuery.data ?? null;
  const displayError =
    error ||
    (statusQuery.error instanceof Error ? statusQuery.error.message : "");

  async function start(values: StartValues) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const device = values.deviceId;
      const asset = values.assetId;
      if (
        request.current?.deviceId !== device ||
        request.current?.assetId !== asset
      ) {
        request.current = {
          deviceId: device,
          assetId: asset,
          key: idempotencyKeyFor(identity, device, asset),
        };
      }
      const saga = await api.start(device, asset, request.current.key);
      trackSaga(saga.sagaId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start provisioning.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function redrive(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api || !sagaId || !reason.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const saga = await api.redrive(sagaId, reason.trim());
      queryClient.setQueryData<ProvisioningStatus>(queryKey, (current) =>
        current ? { ...current, saga } : current,
      );
      setReason("");
      try {
        await statusQuery.refetch({ throwOnError: true });
      } catch {
        setError(
          "Redrive succeeded; current status is temporarily unavailable.",
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not redrive provisioning.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="provisioning" aria-labelledby="provisioning-title">
      <PageHeader id="provisioning-title" title="Sensor provisioning">
        Link a physical sensor to a device, then follow each step until it is
        active.
      </PageHeader>
      {!roles.canStart && !roles.pending && (
        <p className="lede">
          Your role can view provisioning status. An operator or administrator
          must start provisioning.
        </p>
      )}
      {roles.canStart && (
        <section className="section" aria-labelledby="start-title">
          <h2 id="start-title">Start provisioning</h2>
          <form
            onSubmit={(event) => void handleSubmit(start)(event)}
            className="form"
            noValidate
          >
            <div className="form-grid">
              <div className="field">
                <label htmlFor="device-id">Device ID</label>
                <input
                  {...register("deviceId")}
                  id="device-id"
                  className="input"
                  required
                  autoComplete="off"
                  aria-invalid={formErrors.deviceId ? true : undefined}
                  aria-describedby={
                    formErrors.deviceId ? "device-id-error" : undefined
                  }
                />
                {formErrors.deviceId && (
                  <FieldError id="device-id-error">
                    Enter a valid device ID.
                  </FieldError>
                )}
              </div>
              <div className="field">
                <label htmlFor="asset-id">Physical sensor asset ID</label>
                <input
                  {...register("assetId")}
                  id="asset-id"
                  className="input"
                  required
                  autoComplete="off"
                  aria-invalid={formErrors.assetId ? true : undefined}
                  aria-describedby={
                    formErrors.assetId ? "asset-id-error" : undefined
                  }
                />
                {formErrors.assetId && (
                  <FieldError id="asset-id-error">
                    Enter a valid physical sensor ID.
                  </FieldError>
                )}
              </div>
            </div>
            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy}
                aria-busy={busy}
              >
                Start provisioning
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="section" aria-labelledby="track-title">
        <h2 id="track-title">Follow a provisioning</h2>
        <div className="field provisioning-lookup">
          <label htmlFor="saga-id">Track provisioning ID</label>
          <input
            id="saga-id"
            className="input"
            value={sagaId}
            onChange={(event) => {
              trackSaga(event.target.value.trim());
            }}
            autoComplete="off"
          />
        </div>
      </section>
      {displayError && (
        <p role="alert" className="field-error inline-error provisioning-error">
          <Glyph name="critical" />
          <span>{displayError}</span>
        </p>
      )}
      {status && (
        <section
          className="section provisioning-status"
          aria-live="polite"
          aria-label="Provisioning status"
        >
          <div className="status-card">
            <p className="state-line">
              <strong>State:</strong>
              <ProvisioningStateBadge state={status.saga.state} />
            </p>
            <dl className="kv">
              <dt>Device</dt>
              <dd className="mono">{status.saga.deviceId}</dd>
              <dt>Sensor</dt>
              <dd className="mono">{status.saga.assetId}</dd>
            </dl>
            {!finished.has(status.saga.state) && (
              <p className="meta">
                Waiting for the next step. Status refreshes every 5 seconds.
              </p>
            )}
            {status.saga.state === "repair_required" && (
              <>
                <p>
                  Automatic recovery stopped. An administrator must inspect and
                  redrive this workflow.
                </p>
                {roles.canRedrive && (
                  <form
                    onSubmit={(event) => void redrive(event)}
                    className="form-grid"
                  >
                    <div className="field">
                      <label htmlFor="redrive-reason">Redrive reason</label>
                      <input
                        id="redrive-reason"
                        className="input"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        required
                      />
                    </div>
                    <div className="form-actions">
                      <button
                        type="submit"
                        className="btn btn-danger"
                        disabled={busy}
                      >
                        Administrator redrive
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </div>
          <h3 className="history-title">History</h3>
          <ol className="timeline">
            {status.history.map((entry) => (
              <li key={`${entry.version}-${entry.action}-${entry.recordedAt}`}>
                <span className="action">{entry.action}</span>
                {" · "}
                <span className="when">
                  {formatTimestamp(entry.recordedAt)}
                  {entry.reason ? ` · ${entry.reason}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
