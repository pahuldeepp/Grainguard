import {
  contextFromVerifiedPrincipal,
  createFlagEvaluator,
  type FlagChange,
  type VersionedFlagStore,
} from "@greenguard/feature-flags";

export const OPTIONAL_SEND_FLAG = "notifications.optional_sends";
export const GLOBAL_FLAG_TENANT = "00000000-0000-4000-8000-000000000001";

function validateFlagSnapshot(
  value: unknown,
  requestedTenantId: string,
): FlagChange {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid flag snapshot response");
  const snapshot = value as Partial<FlagChange>;
  const globalRequest = requestedTenantId === GLOBAL_FLAG_TENANT;
  if (
    snapshot.scope !== (globalRequest ? "global" : "tenant") ||
    (!globalRequest && snapshot.tenantId !== requestedTenantId) ||
    !Number.isSafeInteger(snapshot.version) ||
    (snapshot.version ?? 0) < 1 ||
    !snapshot.flags ||
    typeof snapshot.flags !== "object" ||
    Array.isArray(snapshot.flags)
  )
    throw new Error("invalid flag snapshot response");
  return snapshot as FlagChange;
}

/** The broker task's tenant ID comes from the validated first-party outbox envelope. */
export function optionalSendGate(
  store: VersionedFlagStore,
  fetchSnapshot?: (tenantId: string) => Promise<FlagChange>,
  now: () => number = Date.now,
  maxTracked = 10_000,
) {
  const evaluator = createFlagEvaluator({ [OPTIONAL_SEND_FLAG]: false }, store);
  const nextRefresh = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  // Refresh bookkeeping is LRU-bounded; an evicted tenant simply refetches.
  const remember = (id: string, at: number) => {
    nextRefresh.delete(id);
    nextRefresh.set(id, at);
    for (const oldest of nextRefresh.keys()) {
      if (nextRefresh.size <= maxTracked) break;
      nextRefresh.delete(oldest);
    }
  };
  async function renew(id: string): Promise<void> {
    if (fetchSnapshot && (nextRefresh.get(id) ?? 0) <= now()) {
      let current = pending.get(id);
      if (!current) {
        current = fetchSnapshot(id)
          .then((snapshot) => {
            store.refresh(snapshot);
            remember(id, now() + 30_000);
          })
          .catch(() => {
            remember(id, now() + 5_000);
          })
          .finally(() => {
            pending.delete(id);
          });
        pending.set(id, current);
      }
      await current;
    }
  }
  const gate = async (tenantId: string): Promise<boolean> => {
    await renew(GLOBAL_FLAG_TENANT);
    await renew(tenantId);
    const context = contextFromVerifiedPrincipal({
      tenantId,
      subject: "notification-outbox",
      roles: ["device"],
    });
    return (await evaluator.evaluate(OPTIONAL_SEND_FLAG, context)).value;
  };
  return Object.assign(gate, { trackedTenants: () => nextRefresh.size });
}

export function controlPlaneFlagSnapshot(
  baseUrl: string,
  token: string,
  options: { allowInsecureHttp?: boolean; fetch?: typeof fetch } = {},
) {
  let validatedUrl: URL;
  try {
    validatedUrl = new URL(baseUrl);
  } catch {
    throw new Error("invalid flag snapshot configuration");
  }
  if (
    !(
      validatedUrl.protocol === "https:" ||
      (validatedUrl.protocol === "http:" && options.allowInsecureHttp === true)
    ) ||
    validatedUrl.username ||
    validatedUrl.password ||
    validatedUrl.search ||
    validatedUrl.hash ||
    !token.trim() ||
    /[\r\n]/.test(token)
  )
    throw new Error("invalid flag snapshot configuration");
  let pathname = validatedUrl.pathname;
  while (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  validatedUrl.pathname = `${pathname}/`;
  const fetcher = options.fetch ?? fetch;
  return async (tenantId: string): Promise<FlagChange> => {
    const url = new URL(
      `v1/internal/flags/${encodeURIComponent(tenantId)}`,
      validatedUrl,
    );
    const response = await fetcher(url, {
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`flag snapshot HTTP ${response.status}`);
    return validateFlagSnapshot(await response.json(), tenantId);
  };
}
