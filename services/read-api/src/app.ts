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
import { BulkheadFull } from "./bulkhead.js";
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
}
export function createApp(options: AppOptions) {
  const margin = options.hotBoundaryMarginMs ?? 300_000;
  if (!Number.isFinite(margin) || margin < 0)
    throw new Error("invalid hot boundary margin");
  const safeHotStart = (now: Date) =>
    now.getTime() - (options.hotWindowMs ?? 86_400_000) + margin;
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
    const source =
      from.getTime() >= safeHotStart(now) ? "postgres" : "cassandra";
    if (source === "cassandra") requireEventualStore();
    await assertHistoryRange(
      options.entitlements ?? defaultHistoryEntitlements,
      res.locals.tenantId,
      from,
      to,
    );
    const q = {
      tenantId: res.locals.tenantId as string,
      deviceId: uuid(req.params.deviceId as string),
      from,
      to,
      limit: limit(req.query.limit),
    };
    // Neither postgres listReadings nor Cassandra HistoryQuery supports a tuple cursor.
    // Until both support (observed_at, reading_id), report full pages as truncated;
    // never ignore a cursor or invent a continuation that skips equal timestamps.
    if (req.query.cursor !== undefined) throw new InputError("invalid_cursor");
    // Pruning is not aligned to now - window. The margin also sends crossing ranges
    // to Cassandra, which retains the full requested range.
    const data =
      source === "postgres"
        ? await options.backends.hotReadings(q)
        : await options.backends.history.list(q);
    await sendJson(res, { data, source, truncated: data.length === q.limit });
  });
  router.get("/devices/:deviceId/rollups", async (req, res) => {
    const now = (options.now ?? (() => new Date()))();
    const { from, to } = range(req.query.from, req.query.to, now);
    await assertHistoryRange(
      options.entitlements ?? defaultHistoryEntitlements,
      res.locals.tenantId,
      from,
      to,
    );
    if (from.getTime() < safeHotStart(now))
      throw new InputError("rollup_outside_hot_window");
    const bucket = req.query.bucket;
    if (bucket !== "hour" && bucket !== "day")
      throw new InputError("invalid_bucket");
    const data = await options.backends.rollup(
      {
        tenantId: res.locals.tenantId,
        deviceId: uuid(req.params.deviceId as string),
        from,
        to,
        limit: limit(req.query.limit),
      },
      bucket,
    );
    await sendJson(res, { data, source: "postgres" });
  });
  router.get("/search", async (req, res) => {
    requireEventualStore();
    const q = req.query.q;
    if (typeof q !== "string" || !q.trim() || q.length > 200)
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
