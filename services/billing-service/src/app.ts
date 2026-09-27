import "reflect-metadata";
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject,
  HttpCode, Module, NotFoundException, Param, Post, Req, ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Principal } from "@greenguard/tenant-auth";
import { AuthError } from "@greenguard/tenant-auth";
import type { Db } from "./db.js";
import { withTenant } from "./db.js";
import { BillingCommands } from "./commands.js";
import { BillingWebhooks, InvalidWebhook } from "./webhooks.js";
import { UUID } from "./ids.js";

type Verifier = { verify(authorization: string | undefined): Promise<Principal>; close?(): void };
interface HttpRequest { headers: Record<string, string | undefined>; rawBody?: Buffer }
const DB = "BILLING_DB";
const COMMANDS = "BILLING_COMMANDS";
const WEBHOOKS = "BILLING_WEBHOOKS";
const VERIFIER = "BILLING_VERIFIER";

async function authorize(req: HttpRequest, verifier: Verifier): Promise<Principal> {
  let principal: Principal;
  try { principal = await verifier.verify(req.headers.authorization); }
  catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 503) throw new ServiceUnavailableException("identity unavailable");
      throw new UnauthorizedException("invalid identity");
    }
    throw new ServiceUnavailableException("identity unavailable");
  }
  if (!principal.roles.includes("admin")) throw new ForbiddenException("admin role required");
  return principal;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048)
    throw new BadRequestException(`${name} is required`);
  return value;
}

@Controller()
class BillingController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(COMMANDS) private readonly commands: BillingCommands,
    @Inject(WEBHOOKS) private readonly webhooks: BillingWebhooks,
    @Inject(VERIFIER) private readonly verifier: Verifier,
  ) {}

  @Get("healthz") health() { return { service: "billing-service", status: "ok" }; }

  @Get("readyz") async ready() {
    try { await this.db.$queryRaw`SELECT 1`; }
    catch { throw new ServiceUnavailableException("billing database unavailable"); }
    return { service: "billing-service", status: "ready" };
  }

  @Post("webhooks/stripe") async stripeWebhook(@Req() req: HttpRequest) {
    const signature = req.headers["stripe-signature"];
    if (!req.rawBody || !signature) throw new BadRequestException("invalid Stripe webhook");
    try { return await this.webhooks.receive(req.rawBody, signature); }
    catch (error) {
      if (error instanceof InvalidWebhook) throw new BadRequestException("invalid Stripe webhook");
      throw error; // No 2xx until inbox commit succeeds.
    }
  }

  @Post("v1/billing/checkout") @HttpCode(202) async checkout(@Req() req: HttpRequest,
    @Body() body: Record<string, unknown>) {
    const actor = await authorize(req, this.verifier);
    try {
      return await this.commands.requestCheckout(actor.tenantId,
        text(body?.plan, "plan"), text(body?.successUrl, "successUrl"),
        text(body?.cancelUrl, "cancelUrl"),
        text(req.headers["idempotency-key"], "Idempotency-Key"), actor.subject);
    } catch (error) {
      if (error instanceof Error && /^(paid plan|invalid return URL|return URL|Idempotency-Key|active subscription|checkout already)/.test(error.message))
        throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Post("v1/billing/portal") @HttpCode(202) async portal(@Req() req: HttpRequest,
    @Body() body: Record<string, unknown>) {
    const actor = await authorize(req, this.verifier);
    try {
      return await this.commands.requestPortal(actor.tenantId,
        text(body?.returnUrl, "returnUrl"),
        text(req.headers["idempotency-key"], "Idempotency-Key"), actor.subject);
    } catch (error) {
      if (error instanceof Error && /^(invalid return URL|return URL|Idempotency-Key)/.test(error.message))
        throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get("v1/billing/commands/:id") async command(@Req() req: HttpRequest,
    @Param("id") commandId: string) {
    const actor = await authorize(req, this.verifier);
    if (!UUID.test(commandId)) throw new BadRequestException("invalid command ID");
    const receipt = await this.commands.get(actor.tenantId, commandId);
    if (!receipt) throw new NotFoundException("billing command not found");
    return receipt;
  }

  @Get("v1/billing/subscription") async subscription(@Req() req: HttpRequest) {
    const actor = await authorize(req, this.verifier);
    const rows = await withTenant(this.db, actor.tenantId, (tx) => tx.$queryRaw<
      { status: string; plan_key: string; entitlement_plan_key: string;
        current_period_end: Date; cancel_at_period_end: boolean; version: bigint }[]>`
      SELECT status, plan_key, entitlement_plan_key, current_period_end,
        cancel_at_period_end, version FROM subscriptions
      WHERE tenant_id=${actor.tenantId}::uuid`);
    const row = rows[0];
    if (!row) return { status: "free", planKey: "free", entitlementPlanKey: "free" };
    return { status: row.status, planKey: row.plan_key,
      entitlementPlanKey: row.entitlement_plan_key,
      currentPeriodEnd: row.current_period_end.toISOString(),
      cancelAtPeriodEnd: row.cancel_at_period_end, version: row.version.toString() };
  }

  @Get("v1/billing/usage") async usage(@Req() req: HttpRequest) {
    const actor = await authorize(req, this.verifier);
    const rows = await withTenant(this.db, actor.tenantId, (tx) => tx.$queryRaw<
      { meter: string; period_start: Date; period_end: Date;
        state: string; total: bigint }[]>`
      SELECT meter, period_start, period_end, state, total FROM usage_periods
      WHERE tenant_id=${actor.tenantId}::uuid ORDER BY period_start DESC, meter LIMIT 24`);
    return rows.map((row) => ({ meter: row.meter,
      periodStart: row.period_start.toISOString(), periodEnd: row.period_end.toISOString(),
      state: row.state, total: row.total.toString() }));
  }
}

@Module({}) class BillingModule {}

export async function createBillingApp(options: { db: Db; commands: BillingCommands;
  webhooks: BillingWebhooks; verifier: Verifier }) {
  const app = await NestFactory.create({ module: BillingModule,
    controllers: [BillingController],
    providers: [
      { provide: DB, useValue: options.db },
      { provide: COMMANDS, useValue: options.commands },
      { provide: WEBHOOKS, useValue: options.webhooks },
      { provide: VERIFIER, useValue: options.verifier },
    ] }, { rawBody: true, logger: ["error", "warn"] });
  app.enableShutdownHooks();
  return app;
}
