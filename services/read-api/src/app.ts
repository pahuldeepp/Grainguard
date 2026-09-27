import express, { type ErrorRequestHandler } from "express";
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
}
export function createApp(options: AppOptions) {
  const margin = options.hotBoundaryMarginMs ?? 300_000;
  if (!Number.isFinite(margin) || margin < 0)
    throw new Error("invalid hot boundary margin");
  const safeHotStart = (now: Date) =>
    now.getTime() - (options.hotWindowMs ?? 86_400_000) + margin;
  const app = express();
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
    try {
      const principal = await options.verify(req.header("Authorization"));
      if (principal.principalType === "service") {
        if (!principal.scopes?.includes("read:telemetry"))
          throw new AuthError(403, "insufficient_role");
      } else requireRole(principal, "viewer", "operator", "admin");
      res.locals.tenantId = principal.tenantId;
      next();
    } catch (error) {
      next(error);
    }
  });
  router.get("/devices/:deviceId", async (req, res) => {
    const data = await options.backends.device(
      res.locals.tenantId,
      uuid(req.params.deviceId as string),
    );
    res.json({ data });
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
      res.json({ data });
    },
  );
  router.get("/readings/:readingId", async (req, res) => {
    const data = await options.backends.reading(
      res.locals.tenantId,
      uuid(req.params.readingId as string),
    );
    res.json({ data, source: "postgres" });
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
    res.json({
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
    res.json({ data });
  });
  router.get("/devices/:deviceId/readings", async (req, res) => {
    const now = (options.now ?? (() => new Date()))();
    const { from, to } = range(req.query.from, req.query.to, now);
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
    const source =
      from.getTime() >= safeHotStart(now) ? "postgres" : "cassandra";
    const data =
      source === "postgres"
        ? await options.backends.hotReadings(q)
        : await options.backends.history.list(q);
    res.json({ data, source, truncated: data.length === q.limit });
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
    res.json({ data, source: "postgres" });
  });
  router.get("/search", async (req, res) => {
    const q = req.query.q;
    if (typeof q !== "string" || !q.trim() || q.length > 200)
      throw new InputError("invalid_query");
    const data = await options.backends.search.search(
      res.locals.tenantId,
      q.trim(),
      limit(req.query.limit),
    );
    res.json({ data, source: "elasticsearch" });
  });
  app.use("/api/v1/read", router);
  // Express recognises an error handler only by its four declared parameters.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
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
