import express, { type ErrorRequestHandler, type Response } from "express";
import {
  parseWatermark,
  serializeWatermark,
  WatermarkError,
  PlacementError,
  READ_BUDGET_HEADER,
  WATERMARK_REQUEST_HEADER,
  WATERMARK_RESPONSE_HEADER,
  type ReadLeaseAuthority,
} from "@greenguard/membership-client";
import {
  readContext,
  assertReadActive,
  readWithinBudget,
  requireEventualStore,
  ConsistencyStoreUnsupported,
  type ReadContext,
} from "./consistency.js";
import {
  FreshnessUnavailable,
  ReadPoolBusy,
  ConsistencyIdentityMismatch,
} from "./replicas.js";
import {
  AuthError,
  requireRole,
  type Principal,
} from "@greenguard/tenant-auth";
import type { ReadBackends } from "./backends.js";
import { historyRollups, RollupScanLimit } from "./history-rollup.js";
import { BulkheadFull } from "./bulkhead.js";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  type HistoryCursor,
  requireHistoryCursorSecret,
} from "./history-cursor.js";
import {
  assertHistoryRange,
  defaultHistoryEntitlements,
  HistoryEntitlementError,
  type HistoryEntitlements,
} from "./entitlements/history.js";

class ResponseTooLarge extends Error {
  constructor() {
    super("response_too_large");
  }
}
export class InputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
function uuid(value: string): string {
  if (!UUID.test(value)) throw new InputError("invalid_id");
  return value;
}
function limit(value: unknown): number {
  const n = value === undefined ? 100 : Number(value);
  if (
    (typeof value !== "string" && value !== undefined) ||
    !Number.isInteger(n) ||
    n < 1 ||
    n > 100
  )
    throw new InputError("invalid_limit");
  return n;
}
function historyOrder(a: Record<string, unknown>, b: Record<string, unknown>) {
  const timeA = new Date(a.observed_at as string | number | Date).getTime();
  const timeB = new Date(b.observed_at as string | number | Date).getTime();
  const idA = String(a.reading_id);
  const idB = String(b.reading_id);
  return timeB - timeA || (idA < idB ? -1 : idA > idB ? 1 : 0);
}
function mergeHistoryRows(
  postgres: Record<string, unknown>[],
  cassandra: Record<string, unknown>[],
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of cassandra) {
    if (typeof row.reading_id !== "string")
      throw new Error("invalid_cassandra_history_row");
    byId.set(row.reading_id, row);
  }
  for (const row of postgres) {
    if (typeof row.reading_id !== "string")
      throw new Error("invalid_postgres_history_row");
    // PostgreSQL wins if the stores overlap at the retention seam.
    byId.set(row.reading_id, row);
  }
  return [...byId.values()].sort(historyOrder);
}
const ZONED_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
function range(from: unknown, to: unknown, now: Date) {
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    !ZONED_TIMESTAMP.test(from) ||
    !ZONED_TIMESTAMP.test(to)
  )
    throw new InputError("invalid_range");
  const start = new Date(from),
    end = new Date(to);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start >= end ||
    end > now ||
    end.getTime() - start.getTime() > 31 * 86_400_000
  )
    throw new InputError("invalid_range");
  return { from: start, to: end };
}
export interface AppOptions {
  verify(authorization: string | undefined): Promise<Principal>;
  backends: ReadBackends;
  now?: () => Date;
  hotWindowMs?: number;
  hotBoundaryMarginMs?: number;
  ready?: () => Promise<boolean>;
  entitlements?: HistoryEntitlements;
  readAuthority?: ReadLeaseAuthority;
  historyCursorSecret?: string;
}
export function createApp(options: AppOptions) {
  const margin = options.hotBoundaryMarginMs ?? 300_000;
  if (!Number.isFinite(margin) || margin < 0)
    throw new Error("invalid hot boundary margin");
  const safeHotStart = (now: Date) =>
    now.getTime() - (options.hotWindowMs ?? 86_400_000) + margin;
  const historyCursorSecret = requireHistoryCursorSecret(
    options.historyCursorSecret ?? process.env.READ_HISTORY_CURSOR_SECRET,
  );
  const app = express();
  const sendJson = async (res: Response, value: unknown) => {
    const ctx = readContext.getStore();
    if (!ctx) throw new FreshnessUnavailable();
    assertReadActive(ctx);
    if (ctx.minimum && !ctx.watermark) throw new FreshnessUnavailable();
    if (
      ctx.minimum &&
      ctx.watermark &&
      (ctx.minimum.tenantId !== ctx.watermark.tenantId ||
        ctx.minimum.shardIncarnation !== ctx.watermark.shardIncarnation ||
        ctx.minimum.placementEpoch !== ctx.watermark.placementEpoch ||
        BigInt(ctx.watermark.sequence) < BigInt(ctx.minimum.sequence))
    )
      throw new FreshnessUnavailable();
    if (ctx.lease)
      await readWithinBudget(
        () =>
          options.readAuthority!.admit(ctx.lease!, {
            deadline: ctx.deadline,
            signal: ctx.signal,
          }),
        ctx.signal,
      );
    assertReadActive(ctx);
    if (ctx.watermark)
      res.setHeader(
        WATERMARK_RESPONSE_HEADER,
        serializeWatermark(ctx.watermark),
      );
    res.json(value);
  };
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => {
    res.status(204).end();
  });
  app.get("/readyz", async (_req, res) => {
    try {
      res.status(!options.ready || (await options.ready()) ? 204 : 503).end();
    } catch {
      res.status(503).end();
    }
  });
  const router = express.Router();
  router.use(async (req, res, next) => {
    let cleanup: (() => void) | undefined;
    try {
      const rawBudget = req.header(READ_BUDGET_HEADER);
      if (rawBudget !== undefined && !/^[1-9][0-9]{0,9}$/.test(rawBudget))
        throw new InputError("invalid_read_budget");
      // Relative budgets avoid trusting a caller's clock. They can only shorten
      // the server cap and include authentication and authority admission time.
      const deadline =
        Date.now() +
        Math.min(4000, rawBudget === undefined ? 4000 : Number(rawBudget));
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
      const disconnect = () => {
        if (!res.writableFinished) abort();
      };
      req.once("aborted", abort);
      res.once("close", disconnect);
      cleanup = () => {
        clearTimeout(timer);
        req.off("aborted", abort);
        res.off("close", disconnect);
      };
      res.once("finish", cleanup);
      res.once("close", cleanup);
      const active = () => {
        if (
          controller.signal.aborted ||
          req.aborted ||
          res.destroyed ||
          deadline <= Date.now()
        )
          throw new FreshnessUnavailable();
      };
      active();
      const principal = await readWithinBudget(
        () => options.verify(req.header("Authorization")),
        controller.signal,
      );
      active();
      if (
        "actor" in principal &&
        principal.actor === "greenguard-mcp" &&
        (req.method !== "GET" ||
          !/^\/devices\/[0-9a-f-]{36}\/(?:latest|current|readings|rollups|risk)$/i.test(
            req.path,
          ))
      )
        throw new AuthError(403, "insufficient_role");
      if (principal.principalType === "service") {
        if (!principal.scopes?.includes("read:telemetry"))
          throw new AuthError(403, "insufficient_role");
      } else requireRole(principal, "viewer", "operator", "admin");
      res.locals.tenantId = principal.tenantId;
      res.setHeader("Cache-Control", "no-store");
      const raw = req.header(WATERMARK_REQUEST_HEADER);
      const minimum =
        raw === undefined ? undefined : parseWatermark(raw, principal.tenantId);
      const lease = options.readAuthority
        ? await readWithinBudget(
            () =>
              options.readAuthority!.acquire(principal.tenantId, {
                deadline,
                signal: controller.signal,
              }),
            controller.signal,
            (late) => {
              void options.readAuthority!.release(late).catch(() => {});
            },
          )
        : undefined;
      let released = false;
      const release = () => {
        if (!lease || released) return;
        released = true;
        void options.readAuthority!.release(lease).catch(() => {});
      };
      res.once("finish", release);
      res.once("close", release);
      // A client can disconnect while acquisition is in flight. The late lease
      // is released here instead of waiting for an already-emitted close event.
      try {
        active();
      } catch (error) {
        release();
        throw error;
      }
      if (
        minimum &&
        lease &&
        (minimum.shardIncarnation !== lease.route.shardIncarnation ||
          minimum.placementEpoch !== lease.route.placementEpoch)
      ) {
        release();
        throw new ConsistencyIdentityMismatch();
      }
      const context: ReadContext = {
        tenantId: principal.tenantId,
        minimum,
        lease,
        signal: controller.signal,
        deadline: Math.min(
          deadline,
          lease ? Date.parse(lease.expiresAt) : Infinity,
        ),
      };
      readContext.run(context, next);
    } catch (error) {
      cleanup?.();
      next(error);
    }
  });
  router.get("/devices/:deviceId", async (req, res) => {
    const data = await options.backends.device(
      res.locals.tenantId,
      uuid(req.params.deviceId as string),
    );
    await sendJson(res, { data });
  });
  router.get("/devices/:deviceId/current", async (req, res) => {
    const data = await options.backends.deviceCurrent(
      res.locals.tenantId,
      uuid(req.params.deviceId as string),
    );
    // Singular device + reading only; never turn the aggregate into an unbounded export.
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > 256 * 1024)
      throw new ResponseTooLarge();
    await sendJson(res, { data, source: "postgres" });
  });
  router.post(
    "/devices/batch",
    express.json({ limit: "8kb" }),
    async (req, res) => {
      const ids = (req.body as { deviceIds?: unknown })?.deviceIds;
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 100 ||
        ids.some((id) => typeof id !== "string")
      )
        throw new InputError("invalid_ids");
      const unique = [...new Set(ids.map((id) => uuid(id as string)))];
      const data = await options.backends.devices(res.locals.tenantId, unique);
      await sendJson(res, { data });
    },
  );
  for (const [kind, method] of [
    ["sites", options.backends.sites],
    ["bins", options.backends.bins],
  ] as const) {
    router.post(
      `/${kind}/batch`,
      express.json({ limit: "8kb" }),
      async (req, res) => {
        const field = kind === "sites" ? "siteIds" : "binIds";
        const ids = (req.body as Record<string, unknown> | undefined)?.[field];
        if (
          !Array.isArray(ids) ||
          ids.length < 1 ||
          ids.length > 100 ||
          ids.some((id) => typeof id !== "string")
        )
          throw new InputError("invalid_ids");
        const data = await method.call(options.backends, res.locals.tenantId, [
          ...new Set(ids.map((id) => uuid(id as string))),
        ]);
        await sendJson(res, { data });
      },
    );
  }
  router.get("/readings/:readingId", async (req, res) => {
    const data = await options.backends.reading(
      res.locals.tenantId,
      uuid(req.params.readingId as string),
    );
    await sendJson(res, { data, source: "postgres" });
  });
  router.get("/sites/:siteId/devices", async (req, res) => {
    const after = req.query.after;
    if (after !== undefined && typeof after !== "string")
      throw new InputError("invalid_cursor");
    const size = limit(req.query.limit);
    const rows = await options.backends.devicesBySite(
      res.locals.tenantId,
      uuid(req.params.siteId as string),
      size + 1,
      after === undefined ? undefined : uuid(after),
    );
    const data = rows.slice(0, size);
    await sendJson(res, {
      data,
      nextCursor:
        rows.length > size
          ? ((data.at(-1) as { device_id?: string })?.device_id ?? null)
          : null,
    });
  });
  router.get("/devices/:deviceId/latest", async (req, res) => {
    const data = await options.backends.latest(
      res.locals.tenantId,
      uuid(req.params.deviceId as string),
    );
    await sendJson(res, { data });
  });
  router.get("/bins/:binId/readings/latest", async (req, res) => {
    const asOf = (options.now ?? (() => new Date()))();
    const data = await options.backends.binReadings(
      res.locals.tenantId,
      uuid(req.params.binId as string),
      asOf,
    );
    if (data && typeof data === "object") {
      const result = data as Record<string, unknown>;
      const readings = Array.isArray(result.readings) ? result.readings : [];
      result.readings = readings.map((sample) => {
        if (!sample || typeof sample !== "object") return sample;
        const value = sample as Record<string, unknown>;
        const observed = new Date(String(value.observed_at)).getTime();
        return {
          ...value,
          age_seconds: Number.isFinite(observed)
            ? Math.max(0, (asOf.getTime() - observed) / 1000)
            : null,
          stale: null,
          stale_after_seconds: null,
        };
      });
    }
    await sendJson(res, {
      data,
      source: "postgres",
      freshness: "not_configured",
    });
  });
  router.get("/bins/:binId/readings/trend", async (req, res) => {
    const window = req.query.window;
    if (window !== "H1" && window !== "H6" && window !== "H24")
      throw new InputError("invalid_window");
    const requested = req.query.resolution ?? "AUTO";
    if (
      requested !== "AUTO" &&
      requested !== "M1" &&
      requested !== "M5" &&
      requested !== "M15" &&
      requested !== "H1"
    )
      throw new InputError("invalid_resolution");
    const seconds: Record<string, number> = {
      M1: 60,
      M5: 300,
      M15: 900,
      H1: 3600,
    };
    const bucketSeconds =
      requested === "AUTO"
        ? window === "H1"
          ? 60
          : window === "H6"
            ? 300
            : 900
        : seconds[requested];
    const width = ({ H1: 3600, H6: 21600, H24: 86400 } as const)[window];
    const bucketCount = Math.ceil(width / bucketSeconds);
    if (bucketCount > 288) throw new InputError("resolution_too_fine");
    const now = (options.now ?? (() => new Date()))();
    const to = new Date(
      Math.floor(now.getTime() / (bucketSeconds * 1000)) * bucketSeconds * 1000,
    );
    const from = new Date(to.getTime() - width * 1000);
    const data = await options.backends.binTrend({
      tenantId: res.locals.tenantId,
      binId: uuid(req.params.binId as string),
      window,
      resolution:
        requested === "AUTO"
          ? bucketSeconds === 60
            ? "M1"
            : bucketSeconds === 300
              ? "M5"
              : "M15"
          : requested,
      from,
      to,
      bucketSeconds,
    });
    await sendJson(res, {
      data: { ...data, window, resolution: requested, bucketSeconds, from, to },
      source: "postgres",
    });
  });
  router.get("/devices/:deviceId/readings", async (req, res) => {
    const now = (options.now ?? (() => new Date()))();
    const { from, to } = range(req.query.from, req.query.to, now);
    const tenantId = res.locals.tenantId as string;
    const deviceId = uuid(req.params.deviceId as string);
    const pageSize = limit(req.query.limit);
    const context = readContext.getStore();
    const placement = context?.lease
      ? {
          shardId: context.lease.route.shardId,
          shardIncarnation: context.lease.route.shardIncarnation,
          placementEpoch: context.lease.route.placementEpoch,
        }
      : undefined;
    if (req.query.after !== undefined && typeof req.query.after !== "string")
      throw new InputError("invalid_cursor");
    if (req.query.cursor !== undefined) throw new InputError("invalid_cursor");
    const expectedCursorContext = {
      tenantId,
      deviceId,
      from,
      to,
      limit: pageSize,
      placement,
    };
    let cursor: HistoryCursor | undefined;
    try {
      cursor = req.query.after
        ? decodeHistoryCursor(
            req.query.after,
            expectedCursorContext,
            historyCursorSecret,
            now.getTime(),
          )
        : undefined;
    } catch {
      throw new InputError("invalid_cursor");
    }
    // Retention may prune PostgreSQL between pages. Move the seam forward with
    // time so Cassandra serves that interval while the signed keyset stays fixed.
    const hotStart = new Date(
      Math.max(cursor?.hotStart.getTime() ?? -Infinity, safeHotStart(now)),
    );
    const after = cursor?.after;
    const postgresFrom = new Date(Math.max(from.getTime(), hotStart.getTime()));
    const cassandraTo = new Date(Math.min(to.getTime(), hotStart.getTime()));
    const usePostgres = postgresFrom < to;
    const useCassandra = from < cassandraTo;
    if (useCassandra) requireEventualStore();
    await assertHistoryRange(
      options.entitlements ?? defaultHistoryEntitlements,
      tenantId,
      from,
      to,
    );
    // Each source is asked for a bounded lookahead page. The whole request fails
    // if either selected source fails; partial history must never look complete.
    const [postgresRows, cassandraRows] = await Promise.all([
      usePostgres
        ? options.backends.hotReadings({
            tenantId,
            deviceId,
            from: postgresFrom,
            to,
            limit: pageSize + 1,
            ...(after ? { after } : {}),
          })
        : Promise.resolve([]),
      useCassandra
        ? options.backends.history.list({
            tenantId,
            deviceId,
            from,
            to: cassandraTo,
            limit: pageSize + 1,
            ...(after ? { after } : {}),
          })
        : Promise.resolve([]),
    ]);
    const merged = mergeHistoryRows(
      postgresRows as unknown as Record<string, unknown>[],
      cassandraRows as Record<string, unknown>[],
    );
    const items = merged.slice(0, pageSize);
    const last = items.at(-1);
    const nextCursor =
      merged.length > pageSize && last
        ? encodeHistoryCursor(
            { ...expectedCursorContext, hotStart },
            {
              observedAt: new Date(last.observed_at as string | number | Date),
              readingId: String(last.reading_id),
            },
            historyCursorSecret,
            now.getTime(),
          )
        : null;
    await sendJson(res, {
      data: items,
      nextCursor,
      sources: { postgres: usePostgres, cassandra: useCassandra },
    });
  });
  router.get("/devices/:deviceId/rollups", async (req, res) => {
    const now = (options.now ?? (() => new Date()))();
    const { from, to } = range(req.query.from, req.query.to, now);
    const hotStart = new Date(safeHotStart(now));
    const useCassandra = from < hotStart;
    if (useCassandra) requireEventualStore();
    await assertHistoryRange(
      options.entitlements ?? defaultHistoryEntitlements,
      res.locals.tenantId,
      from,
      to,
    );
    const bucket = req.query.bucket;
    if (bucket !== "hour" && bucket !== "day")
      throw new InputError("invalid_bucket");
    const query = {
      tenantId: res.locals.tenantId,
      deviceId: uuid(req.params.deviceId as string),
      from,
      to,
      limit: limit(req.query.limit),
    };
    const data = useCassandra
      ? await historyRollups(options.backends, query, bucket, hotStart)
      : await options.backends.rollup(query, bucket);
    const source = useCassandra
      ? to > hotStart
        ? "hybrid"
        : "cassandra"
      : "postgres";
    await sendJson(res, { data, source });
  });
  router.get("/devices/:deviceId/risk", async (req, res) => {
    const now = (options.now ?? (() => new Date()))();
    const { from, to } = range(req.query.from, req.query.to, now);
    const tenantId = res.locals.tenantId as string;
    if (
      Object.keys(req.query).some(
        (key) => !["from", "to", "limit"].includes(key),
      )
    )
      throw new InputError("invalid_query");
    const size = limit(req.query.limit);
    await assertHistoryRange(
      options.entitlements ?? defaultHistoryEntitlements,
      tenantId,
      from,
      to,
    );
    const data = await options.backends.deviceRisk({
      tenantId,
      deviceId: uuid(req.params.deviceId as string),
      from,
      to,
      limit: size,
    });
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > 256 * 1024)
      throw new ResponseTooLarge();
    await sendJson(res, { data, source: "postgres", from, to });
  });
  router.get("/search", async (req, res) => {
    requireEventualStore();
    const q = req.query.q;
    if (typeof q !== "string" || q.length > 200)
      throw new InputError("invalid_query");
    const data = await options.backends.search.search(
      res.locals.tenantId,
      q.trim(),
      limit(req.query.limit),
    );
    await sendJson(res, { data, source: "elasticsearch" });
  });
  app.use("/api/v1/read", router);
  // Express recognises an error handler only by its four declared parameters.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof RollupScanLimit) {
      res.status(422).json({ code: error.message });
      return;
    }
    if (error instanceof ResponseTooLarge) {
      res.status(422).json({ code: error.message });
      return;
    }
    if (error instanceof ConsistencyIdentityMismatch) {
      res.status(409).json({ code: error.message });
      return;
    }
    if (error instanceof WatermarkError) {
      res.status(400).json({ code: error.code });
      return;
    }
    if (error instanceof ConsistencyStoreUnsupported) {
      res.status(409).json({ code: error.message });
      return;
    }
    if (error instanceof ReadPoolBusy) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({ code: "read_busy" });
      return;
    }
    if (
      error instanceof FreshnessUnavailable ||
      error instanceof PlacementError
    ) {
      res.status(503).json({ code: "read_freshness_unavailable" });
      return;
    }
    if (error instanceof AuthError) {
      res.status(error.status).json({ code: error.code });
      return;
    }
    if (error instanceof HistoryEntitlementError) {
      res
        .status(403)
        .json({ code: "entitlement_exceeded", planVersion: error.planVersion });
      return;
    }
    if (error instanceof InputError) {
      res.status(400).json({ code: error.code });
      return;
    }
    if (error instanceof BulkheadFull) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({ code: "read_busy" });
      return;
    }
    console.error("read-api request failed", error);
    res.status(503).json({ code: "read_unavailable" });
  };
  app.use(errors);
  return app;
}
