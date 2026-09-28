import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthError } from "@greenguard/tenant-auth";
import {
  ServiceAuthError,
  type createClientCredentialsVerifier,
} from "@greenguard/tenant-auth/service-principals";
import type { Db } from "../db/client.js";
import { UUID } from "../db/session.js";
import {
  createApiKey,
  listCredentials,
  lookupOAuthClient,
  registerOAuthClient,
  revokeCredential,
  rotateApiKey,
  verifyApiKey,
} from "../domain/api-keys.js";
import { IdentityGuard, LookupGuard } from "./guards.js";
import { CONTROL_DB } from "./controllers.js";
import { type ControlRequest, commandFrom, strictBody } from "./http.js";

export const API_KEY_PEPPER = "CONTROL_API_KEY_PEPPER";
export const API_KEY_ENV = "CONTROL_API_KEY_ENV";
export const MACHINE_ISSUERS = "CONTROL_MACHINE_ISSUERS";
export const M2M_VERIFIER = "CONTROL_M2M_VERIFIER";
const scopes = (v: unknown) =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const string = (v: unknown) => typeof v === "string" && v.length > 0;

@Controller("v1/organizations/:tenantId/credentials")
@UseGuards(IdentityGuard)
export class CredentialsController {
  constructor(
    @Inject(CONTROL_DB) private readonly db: Db,
    @Inject(API_KEY_PEPPER) private readonly pepper: string,
    @Inject(API_KEY_ENV) private readonly env: string,
    @Inject(MACHINE_ISSUERS) private readonly machineIssuers: string[],
  ) {}
  @Get()
  async list(@Req() req: ControlRequest, @Param("tenantId") tenantId: string) {
    return { items: await listCredentials(this.db, req.actor!, tenantId) };
  }
  @Post("api-keys")
  async create(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody<{
      name: string;
      kind: "usr" | "dev";
      deviceId?: string;
      scopes: string[];
      expiresAt: string;
    }>(body, {
      name: string,
      kind: (v) => v === "usr" || v === "dev",
      deviceId: (v) => v === undefined || typeof v === "string",
      scopes,
      expiresAt: string,
    });
    return createApiKey(
      this.db,
      this.pepper,
      req.actor!,
      tenantId,
      input,
      commandFrom(req),
      this.env,
    );
  }
  @Post("oauth-clients")
  async oauth(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody<{
      name: string;
      issuer: string;
      clientId: string;
      scopes: string[];
    }>(body, { name: string, issuer: string, clientId: string, scopes });
    return registerOAuthClient(
      this.db,
      req.actor!,
      tenantId,
      input,
      commandFrom(req),
      this.machineIssuers,
    );
  }
  @Post(":principalId/revoke")
  async revoke(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Param("principalId") principalId: string,
  ) {
    await revokeCredential(
      this.db,
      req.actor!,
      tenantId,
      principalId,
      commandFrom(req),
    );
    return { state: "revoked" };
  }
  @Post("api-keys/:keyId/rotate")
  async rotate(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Param("keyId") keyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody<{ overlapHours: number }>(body, {
      overlapHours: (v) =>
        typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 168,
    });
    return rotateApiKey(
      this.db,
      this.pepper,
      req.actor!,
      tenantId,
      keyId,
      commandFrom(req),
      input.overlapHours,
      this.env,
    );
  }
}

@Controller("v1/internal/credentials")
@UseGuards(LookupGuard)
export class CredentialLookupController {
  constructor(
    @Inject(CONTROL_DB) private readonly db: Db,
    @Inject(API_KEY_PEPPER) private readonly pepper: string,
    @Inject(M2M_VERIFIER)
    private readonly m2m: ReturnType<
      typeof createClientCredentialsVerifier
    > | null,
  ) {}
  @Post("api-key/verify")
  @HttpCode(200)
  async verify(@Body() body: unknown) {
    const input = strictBody<{ key: string }>(body, { key: string });
    try {
      return await verifyApiKey(this.db, this.pepper, input.key);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_key")
        throw new AuthError(401, "invalid_token");
      throw new AuthError(503, "auth_unavailable");
    }
  }
  @Post("oauth-client/lookup")
  @HttpCode(200)
  async lookup(@Body() body: unknown) {
    const input = strictBody<{
      issuer: string;
      clientId: string;
      tenantId?: string;
    }>(body, {
      issuer: string,
      clientId: string,
      tenantId: (v) => v === undefined || typeof v === "string",
    });
    const result = await lookupOAuthClient(
      this.db,
      input.issuer,
      input.clientId,
      input.tenantId,
    );
    if (!result || !UUID.test(result.tenant_id))
      throw new AuthError(401, "invalid_token");
    return result;
  }
  @Post("oauth-token/verify")
  @HttpCode(200)
  async verifyOAuth(@Body() body: unknown) {
    if (!this.m2m) throw new AuthError(503, "auth_unavailable");
    const input = strictBody<{ token: string; requiredScope: string }>(body, {
      token: string,
      requiredScope: string,
    });
    try {
      return await this.m2m.verify(`Bearer ${input.token}`, [
        input.requiredScope,
      ]);
    } catch (error) {
      if (error instanceof ServiceAuthError)
        throw new AuthError(
          error.status,
          error.code === "insufficient_scope"
            ? "insufficient_role"
            : error.code === "auth_unavailable"
              ? "auth_unavailable"
              : "invalid_token",
        );
      throw new AuthError(503, "auth_unavailable");
    }
  }
}
