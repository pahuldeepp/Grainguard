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
import pg from "pg";
import { httpTracingMiddleware, type Tracing } from "@greenguard/otel";
import type { Db } from "./db/client.js";
import {
  AuthGuard,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from "./api/auth.guard.js";
import { correlationMiddleware } from "./api/context.js";
import { DB, InventoryController } from "./api/inventory.controller.js";
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
    this.pool = new pg.Pool({
      connectionString: url,
      max: 5,
      connectionTimeoutMillis: 1000,
      query_timeout: 1000,
      idleTimeoutMillis: 10000,
    });
    this.pool.on("error", () =>
      console.error("device-service: idle database connection failed"),
    );
  }
  async ping() {
    await this.pool.query("SELECT 1");
  }
  async onModuleDestroy() {
    await this.pool.end();
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
    await this.db.$disconnect();
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
            ...(api.importVerifier ? [ImportController] : []),
          ]
        : [HealthController],
      providers: [
        { provide: "DATABASE_PROBE", useValue: probe },
        ...(api
          ? [
              { provide: DB, useValue: api.db },
              { provide: TOKEN_VERIFIER, useValue: api.verifier },
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
