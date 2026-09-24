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
import type { Db } from "./db/client.js";
import {
  AuthGuard,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from "./api/auth.guard.js";
import { correlationMiddleware } from "./api/context.js";
import { DB, InventoryController } from "./api/inventory.controller.js";
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
export interface ApiOptions {
  db: Db;
  verifier: TokenVerifier;
  versions?: VersionRegistry;
  now?: () => Date;
}

class DbLifecycle implements OnModuleDestroy {
  constructor(@Inject(DB) private readonly db: Db) {}
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}

@Module({})
class AppModule {}
export async function createApp(probe: Probe, api?: ApiOptions) {
  const app = await NestFactory.create(
    {
      module: AppModule,
      controllers: api
        ? [HealthController, InventoryController]
        : [HealthController],
      providers: [
        { provide: "DATABASE_PROBE", useValue: probe },
        ...(api
          ? [
              { provide: DB, useValue: api.db },
              { provide: TOKEN_VERIFIER, useValue: api.verifier },
              AuthGuard,
              DbLifecycle,
            ]
          : []),
      ],
    },
    { logger: ["error", "warn"] },
  );
  if (api) {
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
