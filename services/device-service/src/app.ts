import "reflect-metadata";
import {
  Controller,
  Get,
  Inject,
  Module,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import pg from "pg";
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
@Module({})
class AppModule {}
export async function createApp(probe: Probe) {
  const app = await NestFactory.create(
    {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: "DATABASE_PROBE", useValue: probe }],
    },
    { logger: ["error", "warn"] },
  );
  app.enableShutdownHooks();
  return app;
}
