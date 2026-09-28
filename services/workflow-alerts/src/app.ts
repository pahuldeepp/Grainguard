import "reflect-metadata";
import {
  Controller,
  Get,
  Inject,
  Module,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response } from "express";
import {
  httpTracingMiddleware,
  renderPostgresPoolMetrics,
  type Tracing,
} from "@greenguard/otel";
import { ALERTS_DB, AlertsController } from "./api/alerts.controller.js";
import { TenantGuard, VERIFIER, type Verifier } from "./api/auth.js";
import { ProblemJsonFilter } from "./api/problem.js";
import { AlertRulesController } from "./api/rules.controller.js";
import { IDENTITY, IdentityDisplay } from "./api/identity.js";
import { HISTORY_CURSOR, HistoryCursor } from "./api/history.js";
import type { Db } from "./db/client.js";

export interface AlertsAppOptions {
  db: Db;
  verifier?: Verifier;
  actorHmacKey?: string;
  historyCursorKey?: string;
  tracing?: Tracing;
  stopConsumer?: { close?: () => Promise<void> };
  consumerHealth?: { ready: boolean };
}

@Controller()
class ProbeController {
  constructor(
    @Inject(ALERTS_DB) private readonly db: Db,
    @Inject("CONSUMER_HEALTH")
    private readonly consumerHealth: { ready: boolean },
  ) {}

  @Get("healthz") live() {
    return { service: "workflow-alerts", status: "ok" };
  }

  @Get("readyz") async ready() {
    if (!this.consumerHealth.ready) throw new ServiceUnavailableException();
    try {
      await this.db.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException();
    }
    return { service: "workflow-alerts", status: "ready" };
  }
}

class Shutdown implements OnApplicationShutdown {
  constructor(
    @Inject(ALERTS_DB) private readonly db: Db,
    @Inject("TRACING") private readonly tracing: Tracing | null,
    @Inject("CONSUMER")
    private readonly consumer: { close?: () => Promise<void> },
    @Inject(VERIFIER) private readonly verifier: Verifier | null,
  ) {}
  async onApplicationShutdown() {
    const failures: unknown[] = [];
    for (const close of [
      () => this.consumer.close?.(),
      () => this.db.$disconnect(),
      () => this.tracing?.shutdown(),
      () => this.verifier?.close?.(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }
}

@Module({})
class AlertsModule {}

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
function renderHttpMetrics() {
  const lines = [
    "# HELP http_server_requests_total Completed HTTP requests.",
    "# TYPE http_server_requests_total counter",
    "# HELP http_server_duration_seconds HTTP request duration in seconds.",
    "# TYPE http_server_duration_seconds histogram",
  ];
  for (const row of requestCounters.values()) {
    if (["/metrics", "/healthz", "/readyz"].includes(row.route)) continue;
    const labels = `method="${label(row.method)}",route="${label(row.route)}",status_code="${row.status}"`;
    lines.push(`http_server_requests_total{${labels}} ${row.count}`);
    buckets.forEach((bound, index) =>
      lines.push(
        `http_server_duration_seconds_bucket{${labels},le="${bound}"} ${row.bucketCounts[index]}`,
      ),
    );
    lines.push(
      `http_server_duration_seconds_bucket{${labels},le="+Inf"} ${row.count}`,
      `http_server_duration_seconds_sum{${labels}} ${row.duration}`,
      `http_server_duration_seconds_count{${labels}} ${row.count}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
function redMiddleware(req: Request, res: Response, next: () => void) {
  if (["/metrics", "/healthz", "/readyz"].includes(req.path)) return next();
  const start = process.hrtime.bigint();
  res.once("finish", () => {
    const route = requestRoute(req);
    const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(req.method)
      ? req.method
      : "OTHER";
    const status = res.statusCode;
    const key = `${method}\\0${route}\\0${status}`;
    const row = requestCounters.get(key) ?? {
      method,
      route,
      status,
      count: 0,
      duration: 0,
      bucketCounts: buckets.map(() => 0),
    };
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    row.count += 1;
    row.duration += duration;
    row.bucketCounts = row.bucketCounts.map(
      (count, index) => count + (duration <= buckets[index] ? 1 : 0),
    );
    requestCounters.set(key, row);
  });
  next();
}

function requestRoute(req: Request) {
  const path = req.route?.path;
  if (typeof path !== "string") return "unmatched";
  const base = req.baseUrl || "";
  const joined = `${base}/${path}`.replace(/\/+$/, "") || "/";
  return joined.startsWith("/") ? joined : `/${joined}`;
}

// The /v1 API is mounted only with a token verifier; without one the service runs
// health probes only (the risk consumer does not need HTTP).
export async function createAlertsApp(options: AlertsAppOptions) {
  const api = options.verifier !== undefined;
  const identity = api
    ? new IdentityDisplay(options.actorHmacKey as string)
    : null;
  const cursor = api
    ? new HistoryCursor(options.historyCursorKey as string)
    : null;
  const app = await NestFactory.create(
    {
      module: AlertsModule,
      controllers: api
        ? [ProbeController, AlertsController, AlertRulesController]
        : [ProbeController],
      providers: [
        { provide: IDENTITY, useValue: identity },
        { provide: HISTORY_CURSOR, useValue: cursor },
        { provide: ALERTS_DB, useValue: options.db },
        { provide: "TRACING", useValue: options.tracing ?? null },
        { provide: "CONSUMER", useValue: options.stopConsumer ?? {} },
        {
          provide: "CONSUMER_HEALTH",
          useValue: options.consumerHealth ?? { ready: true },
        },
        { provide: VERIFIER, useValue: options.verifier ?? null },
        TenantGuard,
        Shutdown,
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
  if (options.tracing) app.use(httpTracingMiddleware(options.tracing.tracer));
  app.useGlobalFilters(new ProblemJsonFilter());
  app.enableShutdownHooks();
  return app;
}
