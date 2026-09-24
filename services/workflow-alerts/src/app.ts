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
import { httpTracingMiddleware, type Tracing } from "@greenguard/otel";
import { ALERTS_DB, AlertsController } from "./api/alerts.controller.js";
import { TenantGuard, VERIFIER, type Verifier } from "./api/auth.js";
import { ProblemJsonFilter } from "./api/problem.js";
import type { Db } from "./db/client.js";

export interface AlertsAppOptions {
  db: Db;
  verifier?: Verifier;
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
  ) {}
  async onApplicationShutdown() {
    await this.consumer.close?.();
    await this.db.$disconnect();
    await this.tracing?.shutdown();
  }
}

@Module({})
class AlertsModule {}

// The /v1 API is mounted only with a token verifier; without one the service runs
// health probes only (the risk consumer does not need HTTP).
export async function createAlertsApp(options: AlertsAppOptions) {
  const api = options.verifier !== undefined;
  const app = await NestFactory.create(
    {
      module: AlertsModule,
      controllers: api
        ? [ProbeController, AlertsController]
        : [ProbeController],
      providers: [
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
  if (options.tracing) app.use(httpTracingMiddleware(options.tracing.tracer));
  app.useGlobalFilters(new ProblemJsonFilter());
  app.enableShutdownHooks();
  return app;
}
