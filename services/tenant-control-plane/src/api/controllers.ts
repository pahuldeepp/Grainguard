import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import type { Db } from "../db/client.js";
import { InvalidInputError, NotFoundError } from "../domain/errors.js";
import {
  acceptInvitation,
  changeRole,
  createOrganization,
  inviteMember,
  listMembersPage,
  lookupMembership,
  lookupDelegatedMembership,
  revokeMember,
  type Actor,
  type HumanRole,
  type Result,
} from "../domain/store.js";
import { IdentityGuard, LookupGuard } from "./guards.js";
import {
  type ControlRequest,
  commandFrom,
  email,
  humanRole,
  ifMatch,
  type RoleBody,
  strictBody,
  text,
} from "./http.js";

export const CONTROL_DB = "CONTROL_DB";
const MEMBER_PATH = "organizations/:tenantId/members/:identityId";

type Reply = ServerResponse & { status(code: number): unknown };

function send(res: Reply, result: Result): Record<string, unknown> {
  res.status(result.status);
  if (typeof result.body.version === "string")
    res.setHeader("ETag", `"${result.body.version}"`);
  return result.body;
}

const actorOf = (req: ControlRequest) => req.actor as Actor;

@Controller("v1")
@UseGuards(IdentityGuard)
export class OrganizationsController {
  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}

  @Post("organizations")
  async create(
    @Req() req: ControlRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const cmd = commandFrom(req);
    const input = strictBody<{ name: string }>(body, { name: text(200) });
    return send(
      res,
      await createOrganization(
        this.db,
        actorOf(req),
        { name: input.name.trim() },
        cmd,
      ),
    );
  }

  @Get("organizations/:tenantId/members")
  async list(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    if (limit !== undefined && !/^[1-9]\d*$/.test(limit))
      throw new InvalidInputError("invalid member limit");
    return listMembersPage(this.db, actorOf(req), tenantId, {
      limit: limit === undefined ? undefined : Number(limit),
      cursor,
    });
  }

  @Post("organizations/:tenantId/invitations")
  async invite(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const cmd = commandFrom(req);
    const input = strictBody<{ email: string; role: HumanRole }>(body, {
      email,
      role: humanRole,
    });
    return send(
      res,
      await inviteMember(this.db, actorOf(req), tenantId, input, cmd),
    );
  }

  @Post("invitations/accept")
  async accept(
    @Req() req: ControlRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const cmd = commandFrom(req);
    const input = strictBody<{ token: string }>(body, { token: text(512) });
    return send(res, await acceptInvitation(this.db, actorOf(req), input, cmd));
  }

  @Patch(MEMBER_PATH)
  async change(
    @Req() req: ControlRequest,
    @Param() p: Record<string, string>,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const cmd = commandFrom(req);
    const expected = ifMatch(req);
    const input = strictBody<RoleBody>(body, { role: humanRole });
    return send(
      res,
      await changeRole(
        this.db,
        actorOf(req),
        p.tenantId!,
        p.identityId!,
        input,
        expected,
        cmd,
      ),
    );
  }

  @Post(`${MEMBER_PATH}/revoke`)
  async revoke(
    @Req() req: ControlRequest,
    @Param() p: Record<string, string>,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const cmd = commandFrom(req);
    const expected = ifMatch(req);
    return send(
      res,
      await revokeMember(
        this.db,
        actorOf(req),
        p.tenantId!,
        p.identityId!,
        expected,
        cmd,
      ),
    );
  }
}

@Controller("v1/internal")
@UseGuards(LookupGuard)
export class LookupController {
  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}

  @Get("delegated-memberships")
  @HttpCode(200)
  async delegatedLookup(
    @Query("tenantId") tenantId?: string,
    @Query("identityId") identityId?: string,
  ) {
    if (!tenantId || !identityId)
      throw new InvalidInputError("tenant and identity required");
    const membership = await lookupDelegatedMembership(
      this.db,
      tenantId,
      identityId,
    );
    if (!membership) throw new NotFoundError("membership");
    return membership;
  }

  @Get("memberships")
  @HttpCode(200)
  async lookup(
    @Query("issuer") issuer?: string,
    @Query("subject") subject?: string,
  ) {
    if (!issuer || !subject)
      throw new InvalidInputError("issuer and subject are required");
    const membership = await lookupMembership(this.db, issuer, subject);
    if (!membership) throw new NotFoundError("membership");
    return membership;
  }
}
