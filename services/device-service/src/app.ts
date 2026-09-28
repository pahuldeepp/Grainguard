import {
  createOwnerDatabase,
  closeOwnerDatabase,
  ownerDatabases,
} from "@greenguard/membership-client/owner-db";
import "reflect-metadata";
import {
  Controller,
  Get,
  Inject,
  Module,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import type { Request, Response } from "express";
import pg from "pg";
import {
  httpTracingMiddleware,
  renderPostgresPoolMetrics,
  type Tracing,
} from "@greenguard/otel";
import type { Db } from "./db/client.js";
import {
  AuthGuard,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from "./api/auth.guard.js";
import { correlationMiddleware } from "./api/context.js";
import { DB, InventoryController } from "./api/inventory.controller.js";
import { CablesController } from "./api/cables.controller.js";
import { IMPORT_SOURCE_ID, ImportController } from "./import/controller.js";
import {
  IMPORT_VERIFIER,
  ImportGuard,
  type ImportVerifier,
} from "./import/auth.js";
import { ProblemFilter } from "./api/problem.js";
import {
  createApiVersionMiddleware,
  DEFAULT_REGISTRY,
  type VersionRegistry,
} from "./api/versioning/index.js";
export interface Probe {
  ping(): Promise<void>;
  onModuleDestroy?(): Promise<void>;
}
export class DatabaseProbe implements Probe, OnModuleDestroy {
  private readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = createOwnerDatabase({
      legacyUrl: url,
      service: "device-service",
      database: "greenguard_inventory",
      roles: ["inventory_app"],
      create: (connectionString) => {
        const pool = new pg.Pool({
          connectionString,
          max: 1,
          connectionTimeoutMillis: 1000,
          query_timeout: 1000,
          idleTimeoutMillis: 10000,
        });
        pool.on("error", () =>
          console.error("device-service: idle database connection failed"),
        );
        return pool;
      },
      close: (pool) => pool.end(),
    });
  }
  async ping() {
    await Promise.all(
      ownerDatabases(this.pool).map((pool) => pool.query("SELECT 1")),
    );
  }
  async onModuleDestroy() {
    await closeOwnerDatabase(this.pool, 5000, (pool) => pool.end());
  }
}
@Controller()
class HealthController {
  constructor(@Inject("DATABASE_PROBE") private readonly probe: Probe) {}
  @Get("healthz") live() {
    return { service: "device-service", status: "ok" };
  }
  @Get("readyz") async ready() {
    try {
      await this.probe.ping();
    } catch {
      throw new ServiceUnavailableException({
        service: "device-service",
        status: "not_ready",
      });
    }
    return { service: "device-service", status: "ready" };
  }
}
const TRACING = "TRACING";

type RequestCounter = {
  method: string;
  route: string;
  status: number;
  count: number;
  duration: number;
  bucketCounts: number[];
};
const requestCounters = new Map<string, RequestCounter>();
const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const label = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
function recordRequest(req: Request, res: Response, duration: number) {
  const route = requestRoute(req);
  const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(req.method)
    ? req.method
    : "OTHER";
  const status = res.statusCode;
  const key = `${method}\0${route}\0${status}`;
  const current = requestCounters.get(key) ?? {
    method,
    route,
    status,
    count: 0,
    duration: 0,
    bucketCounts: buckets.map(() => 0),
  };
  current.count += 1;
  current.duration += duration;
  current.bucketCounts = current.bucketCounts.map(
    (count, index) => count + (duration <= buckets[index] ? 1 : 0),
  );
  requestCounters.set(key, current);
}
function requestRoute(req: Request) {
  const path = req.route?.path;
  if (typeof path !== "string") return "unmatched";
  const base = req.baseUrl || "";
  const joined = `${base}/${path}`.replace(/\/+$/, "") || "/";
  return joined.startsWith("/") ? joined : `/${joined}`;
}
function renderHttpMetrics() {
  const lines = [
    "# HELP http_server_requests_total Completed HTTP requests.",
    "# TYPE http_server_requests_total counter",
    "# HELP http_server_duration_seconds HTTP request duration in seconds.",
    "# TYPE http_server_duration_seconds histogram",
  ];
  for (const row of requestCounters.values()) {
    if (
      row.route === "/metrics" ||
      row.route === "/healthz" ||
      row.route === "/readyz"
    )
      continue;
    const labels = `method="${label(row.method)}",route="${label(row.route)}",status_code="${row.status}"`;
    lines.push(`http_server_requests_total{${labels}} ${row.count}`);
    buckets.forEach((bound, index) =>
      lines.push(
        `http_server_duration_seconds_bucket{${labels},le="${bound}"} ${row.bucketCounts[index]}`,
      ),
    );
    lines.push(
      `http_server_duration_seconds_bucket{${labels},le="+Inf"} ${row.count}`,
    );
    lines.push(`http_server_duration_seconds_sum{${labels}} ${row.duration}`);
    lines.push(`http_server_duration_seconds_count{${labels}} ${row.count}`);
  }
  return `${lines.join("\n")}\n`;
}
function redMiddleware(req: Request, res: Response, next: () => void) {
  if (["/metrics", "/healthz", "/readyz"].includes(req.path)) return next();
  const start = process.hrtime.bigint();
  res.once("finish", () =>
    recordRequest(req, res, Number(process.hrtime.bigint() - start) / 1e9),
  );
  next();
}

export interface ApiOptions {
  db: Db;
  verifier: TokenVerifier;
  importVerifier?: ImportVerifier;
  importSourceId?: string;
  versions?: VersionRegistry;
  now?: () => Date;
  tracing?: Tracing;
}

class DbLifecycle implements OnModuleDestroy {
  constructor(@Inject(DB) private readonly db: Db) {}
  async onModuleDestroy() {
    await closeOwnerDatabase(this.db, 5000, (db) => db.$disconnect());
  }
}

class VerifierLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}
  async onModuleDestroy() {
    await this.verifier.close?.();
  }
}

class TracingLifecycle implements OnModuleDestroy {
  constructor(@Inject(TRACING) private readonly tracing: Tracing) {}
  async onModuleDestroy() {
    await this.tracing.shutdown();
  }
}

@Module({})
class AppModule {}
export async function createApp(probe: Probe, api?: ApiOptions) {
  if (api?.importVerifier && !api.importSourceId)
    throw new Error("importSourceId is required with importVerifier");
  const app = await NestFactory.create(
    {
      module: AppModule,
      controllers: api
        ? [
            HealthController,
            InventoryController,
            CablesController,
            ...(api.importVerifier ? [ImportController] : []),
          ]
        : [HealthController],
      providers: [
        { provide: "DATABASE_PROBE", useValue: probe },
        ...(api
          ? [
              { provide: DB, useValue: api.db },
              { provide: TOKEN_VERIFIER, useValue: api.verifier },
              VerifierLifecycle,
              AuthGuard,
              ...(api.importVerifier
                ? [
                    { provide: IMPORT_VERIFIER, useValue: api.importVerifier },
                    { provide: IMPORT_SOURCE_ID, useValue: api.importSourceId },
                    ImportGuard,
                  ]
                : []),
              DbLifecycle,
              ...(api.tracing
                ? [
                    { provide: TRACING, useValue: api.tracing },
                    TracingLifecycle,
                  ]
                : []),
            ]
          : []),
      ],
    },
    { logger: ["error", "warn"] },
  );
  app.use(redMiddleware);
  app
    .getHttpAdapter()
    .getInstance()
    .get("/metrics", (_req: Request, res: Response) => {
      res
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(`${renderHttpMetrics()}${renderPostgresPoolMetrics()}`);
    });
  if (api) {
    if (api.tracing) app.use(httpTracingMiddleware(api.tracing.tracer));
    app.use(correlationMiddleware);
    app.use(
      "/v1",
      createApiVersionMiddleware(api.versions ?? DEFAULT_REGISTRY, api.now),
    );
    app.useGlobalFilters(
      new ProblemFilter(app.get(HttpAdapterHost).httpAdapter),
    );
  }
  app.enableShutdownHooks();
  return app;
}
