import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Db } from "../db/client.js";
import {
  createIdentityConnection,
  discoverIdentityConnection,
  jitMembership,
  releaseIdentityDomain,
  reverifyIdentityDomain,
  setConnectionJit,
  type ConnectionInput,
  type VerifyDomain,
} from "../domain/identity-connections.js";
import type { Actor } from "../domain/store.js";
import { CONTROL_DB } from "./controllers.js";
import { IdentityGuard } from "./guards.js";
import { IpTokenBucket, discoverBucket } from "./rate-limit.js";
import { RateLimitedError } from "./rate-limited.js";
import {
  commandFrom,
  email,
  ifMatch,
  strictBody,
  text,
  type ControlRequest,
} from "./http.js";

export const DOMAIN_VERIFIER = "DOMAIN_VERIFIER";

@Controller("v1/identity")
export class IdentityDiscoveryController {
  private readonly bucket: IpTokenBucket = discoverBucket();

  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}

  // Unauthenticated and therefore enumerable: unknown, expired and released domains
  // all answer null. The per-IP bucket is a backstop; production still needs an edge
  // limit (the socket address is the proxy's when deployed behind one).
  @Get("discover")
  discover(@Req() req: ControlRequest, @Query("email") address?: string) {
    const wait = this.bucket.take(
      req.socket.remoteAddress ?? "unknown",
      Date.now(),
    );
    if (wait > 0) throw new RateLimitedError(wait);
    if (!email(address)) return null;
    return discoverIdentityConnection(this.db, address!);
  }
}

@Controller("v1/identity")
@UseGuards(IdentityGuard)
export class IdentityConnectionsController {
  constructor(
    @Inject(CONTROL_DB) private readonly db: Db,
    @Inject(DOMAIN_VERIFIER) private readonly verifyDomain: VerifyDomain,
  ) {}

  @Post("organizations/:tenantId/connections")
  create(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody<ConnectionInput>(body, {
      issuer: text(512),
      type: (v) => v === "oidc" || v === "saml",
      domains: (v) =>
        Array.isArray(v) &&
        v.length > 0 &&
        v.length <= 20 &&
        v.every((d) => text(253)(d)),
      jitEnabled: (v) => typeof v === "boolean",
    });
    return createIdentityConnection(
      this.db,
      req.actor as Actor,
      tenantId,
      input,
      this.verifyDomain,
      commandFrom(req),
    );
  }

  @Post("jit")
  jit(@Req() req: ControlRequest) {
    return jitMembership(this.db, req.actor as Actor, commandFrom(req));
  }

  @Patch("organizations/:tenantId/connections/:connectionId/jit")
  setJit(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody<{ enabled: boolean }>(body, {
      enabled: (v) => typeof v === "boolean",
    });
    return setConnectionJit(
      this.db,
      req.actor as Actor,
      tenantId,
      connectionId,
      input.enabled,
      ifMatch(req),
      commandFrom(req),
    );
  }

  @Post(
    "organizations/:tenantId/connections/:connectionId/domains/:domain/reverify",
  )
  reverify(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Param("connectionId") connectionId: string,
    @Param("domain") domain: string,
  ) {
    return reverifyIdentityDomain(
      this.db,
      req.actor as Actor,
      tenantId,
      connectionId,
      domain,
      this.verifyDomain,
    );
  }

  @Post(
    "organizations/:tenantId/connections/:connectionId/domains/:domain/release",
  )
  release(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Param("connectionId") connectionId: string,
    @Param("domain") domain: string,
  ) {
    return releaseIdentityDomain(
      this.db,
      req.actor as Actor,
      tenantId,
      connectionId,
      domain,
      commandFrom(req),
    );
  }
}
