import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readEpisode } from "../alerts/store.js";
import { isUuid, withTenant } from "../db/tenant.js";
import type { Db } from "../db/client.js";
import { ALERTS_DB } from "./alerts.controller.js";
import { etag } from "./parse.js";

export interface OwnershipConfig {
  serviceToken: string;
  membershipUrl: string;
  membershipToken: string;
}
export const OWNERSHIP = "ALERTS_OWNERSHIP";
export function validateOwnership(config: OwnershipConfig): OwnershipConfig {
  const url = new URL(config.membershipUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname) ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    [config.serviceToken, config.membershipToken].some(
      (token) => !/^[\x21-\x7e]{32,512}$/.test(token),
    )
  )
    throw new Error("unsafe Alerts ownership configuration");
  return config;
}

@Controller("v1/internal/alert-authorization")
export class OwnershipController {
  constructor(
    @Inject(ALERTS_DB) private readonly db: Db,
    @Inject(OWNERSHIP) private readonly config: OwnershipConfig,
  ) {}
  @Get()
  async authorize(
    @Req() req: IncomingMessage,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    const expected = Buffer.from("Bearer " + this.config.serviceToken);
    const actual = Buffer.from(req.headers.authorization ?? "");
    if (
      req.rawHeaders.filter(
        (_, index) =>
          index % 2 === 0 &&
          req.rawHeaders[index].toLowerCase() === "authorization",
      ).length !== 1 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new UnauthorizedException();
    res.setHeader("Cache-Control", "no-store");
    const { tenantId, userId, alertId, etag: version } = query;
    if (
      Object.keys(query)
        .sort((a, b) => (a < b ? -1 : Number(a > b)))
        .join(",") !== "alertId,etag,tenantId,userId" ||
      !isUuid(tenantId) ||
      !isUuid(userId) ||
      !isUuid(alertId) ||
      typeof version !== "string" ||
      !/^"[1-9]\d{0,18}"$/.test(version)
    )
      throw new BadRequestException();
    let roles: string[];
    try {
      const url = new URL(
        "/v1/internal/delegated-memberships",
        this.config.membershipUrl,
      );
      url.search = new URLSearchParams({
        tenantId,
        identityId: userId,
      }).toString();
      const response = await fetch(url, {
        headers: { authorization: "Bearer " + this.config.membershipToken },
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      });
      if (response.status === 404) throw new ForbiddenException();
      if (!response.ok) throw new Error("membership unavailable");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing membership");
      let bytes = 0;
      const blocks: Uint8Array[] = [];
      try {
        for (;;) {
          const block = await reader.read();
          if (block.done) break;
          bytes += block.value.length;
          if (bytes > 8192) throw new Error("membership bounds");
          blocks.push(block.value);
        }
      } finally {
        await reader.cancel();
      }
      const value = JSON.parse(Buffer.concat(blocks).toString("utf8"));
      if (
        value.tenantId !== tenantId ||
        value.identityId !== userId ||
        value.state !== "active" ||
        !Array.isArray(value.roles) ||
        value.roles.some(
          (role: unknown) =>
            !["viewer", "operator", "admin", "device"].includes(role as string),
        )
      )
        throw new Error("invalid membership");
      roles = value.roles;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new ServiceUnavailableException();
    }
    if (!roles.some((role) => role === "operator" || role === "admin"))
      throw new ForbiddenException();
    const episode = await withTenant(this.db, tenantId, (tx) =>
      readEpisode(tx, tenantId, alertId),
    );
    if (
      !episode ||
      episode.state !== "open" ||
      etag(episode.version) !== version
    )
      throw new NotFoundException();
    return { authorized: true, tenantId, userId, alertId, etag: version };
  }
}
