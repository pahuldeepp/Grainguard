import "reflect-metadata";
import {
  InternalPlacementController,
  OrganizationPlacementController,
} from "./api/placement.controller.js";
import {
  Controller,
  Get,
  Inject,
  Module,
  type OnApplicationShutdown,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { httpTracingMiddleware, type Tracing } from "@greenguard/otel";
import {
  CONTROL_DB,
  LookupController,
  OrganizationsController,
} from "./api/controllers.js";
import {
  IDENTITY_VERIFIER,
  IdentityGuard,
  LOOKUP_TOKEN,
  LookupGuard,
} from "./api/guards.js";
import { type AuthOptions, createIdentityVerifier } from "./api/identity.js";
import {
  API_KEY_ENV,
  MACHINE_ISSUERS,
  API_KEY_PEPPER,
  CredentialLookupController,
  CredentialsController,
} from "./api/api-keys.controller.js";
import { M2M_VERIFIER } from "./api/api-keys.controller.js";
import {
  createClientCredentialsVerifier,
  type ClientCredentialsOptions,
} from "@greenguard/tenant-auth/service-principals";
import { lookupOAuthClient } from "./domain/api-keys.js";
import { ProblemFilter } from "./api/problem.js";
import {
  AuditController,
  AUDIT_OPTIONS,
  type AuditOptions,
} from "./audit/controller.js";
import { AuditSources } from "./audit/owners.js";
import {
  DOMAIN_VERIFIER,
  IdentityConnectionsController,
  IdentityDiscoveryController,
} from "./api/identity-connections.controller.js";
import {
  verifyDnsDomain,
  type VerifyDomain,
} from "./domain/identity-connections.js";
import { FlagsController } from "./flags/controller.js";
import { FlagSnapshotsController } from "./flags/snapshot.controller.js";
import {
  FLAG_ADMIN_ACTOR_ID,
  FLAG_ADMIN_TOKEN,
  GlobalFlagGuard,
  GlobalFlagsController,
} from "./flags/global.controller.js";
import type { Db } from "./db/client.js";
import {
  InternalNotificationContactsController,
  NotificationContactsController,
} from "./notifications/controller.js";

const SERVICE = "tenant-control-plane";

export interface ControlPlaneOptions {
  db: Db;
  lookupToken: string;
  auth?: AuthOptions;
  tracing?: Tracing;
  apiKeyPepper?: string;
  apiKeyEnvironment?: string;
  m2m?: Omit<ClientCredentialsOptions, "lookup">;
  /** Issuers allowed for machine-client registration; defaults to the m2m issuer (ADR-0020). */
  machineIssuers?: string[];
  flagAdmin?: { token: string; actorId: string };
  verifyDomain?: VerifyDomain;
  audit?: AuditOptions;
}

@Controller()
class ProbeController {
  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}

  @Get("healthz") live() {
    return { service: SERVICE, status: "ok" };
  }

  @Get("readyz") async ready() {
    try {
      await this.db.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException();
    }
    return { service: SERVICE, status: "ready" };
  }
}

class Shutdown implements OnApplicationShutdown {
  constructor(
    @Inject(CONTROL_DB) private readonly db: Db,
    @Inject("TRACING") private readonly tracing: Tracing | null,
    @Inject("AUDIT_SOURCES") private readonly auditSources: AuditSources | null,
  ) {}

  async onApplicationShutdown() {
    await this.db.$disconnect();
    await this.auditSources?.close();
    await this.tracing?.shutdown();
  }
}

@Module({})
class ControlPlaneModule {}

// The user API needs a token verifier; without AUTH_* only probes and the service
// lookup are mounted.
export async function createControlPlaneApp(options: ControlPlaneOptions) {
  const controllers: (new (...args: never[]) => unknown)[] = [
    ProbeController,
    LookupController,
    FlagSnapshotsController,
    IdentityDiscoveryController,
    InternalNotificationContactsController,
    InternalPlacementController,
  ];
  if (options.auth)
    controllers.push(
      OrganizationsController,
      FlagsController,
      IdentityConnectionsController,
      NotificationContactsController,
      OrganizationPlacementController,
    );
  if (options.auth && options.audit) controllers.push(AuditController);
  if (options.flagAdmin) controllers.push(GlobalFlagsController);
  if (options.apiKeyPepper || options.m2m) {
    controllers.push(CredentialLookupController);
    if (options.auth && options.apiKeyPepper)
      controllers.push(CredentialsController);
  }
  const app = await NestFactory.create(
    {
      module: ControlPlaneModule,
      controllers,
      providers: [
        { provide: CONTROL_DB, useValue: options.db },
        { provide: LOOKUP_TOKEN, useValue: options.lookupToken },
        { provide: FLAG_ADMIN_TOKEN, useValue: options.flagAdmin?.token ?? "" },
        {
          provide: FLAG_ADMIN_ACTOR_ID,
          useValue: options.flagAdmin?.actorId ?? "",
        },
        {
          provide: DOMAIN_VERIFIER,
          useValue: options.verifyDomain ?? verifyDnsDomain,
        },
        { provide: AUDIT_OPTIONS, useValue: options.audit ?? null },
        { provide: "AUDIT_SOURCES", useValue: options.audit?.sources ?? null },
        { provide: API_KEY_PEPPER, useValue: options.apiKeyPepper ?? "" },
        { provide: API_KEY_ENV, useValue: options.apiKeyEnvironment ?? "dev" },
        {
          provide: MACHINE_ISSUERS,
          useValue:
            options.machineIssuers ?? (options.m2m ? [options.m2m.issuer] : []),
        },
        {
          provide: M2M_VERIFIER,
          useValue: options.m2m
            ? createClientCredentialsVerifier({
                ...options.m2m,
                tenantClaim: options.m2m.tenantClaim ?? "gg_tenant",
                lookup: (issuer, clientId, tenantHint) =>
                  lookupOAuthClient(options.db, issuer, clientId, tenantHint),
              })
            : null,
        },
        {
          provide: IDENTITY_VERIFIER,
          useValue: options.auth ? createIdentityVerifier(options.auth) : null,
        },
        { provide: "TRACING", useValue: options.tracing ?? null },
        IdentityGuard,
        LookupGuard,
        GlobalFlagGuard,
        Shutdown,
      ],
    },
    { logger: ["error", "warn"] },
  );
  if (options.tracing) app.use(httpTracingMiddleware(options.tracing.tracer));
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
  return app;
}
