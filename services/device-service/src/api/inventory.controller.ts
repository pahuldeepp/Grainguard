import { randomUUID } from "node:crypto";
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
import { requireRole, type Principal } from "@greenguard/tenant-auth";
import type { Db } from "../db/client.js";
import { isUuid } from "../db/tenant.js";
import {
  DeviceNotFoundError,
  DeviceLookupAmbiguousError,
  InvalidInputError,
} from "../inventory/errors.js";
import {
  changeDeviceBinding,
  createBin,
  createSite,
  grainLotAt,
  getDevice,
  listDevices,
  lookupDeviceBySerial,
  placeGrainLot,
  registerDevice,
  registerPendingDevice,
  setDeviceStatus,
} from "../inventory/repository.js";
import { AuthGuard } from "./auth.guard.js";
import { commandContext } from "./context.js";
import {
  etag,
  parseBin,
  parseBinding,
  parseIdempotencyKey,
  parseIfMatch,
  parseLotPlacement,
  parseObservedAt,
  parsePage,
  parseRegister,
  parseRegisterPending,
  parseSite,
  parseStatus,
  toDeviceDto,
} from "./dto.js";
import { header, type ApiRequest, type ApiResponse } from "./http.js";

export const DB = "DB";

const READ = ["viewer", "operator", "admin"] as const;
const WRITE = ["operator", "admin"] as const;

function authorized(
  req: ApiRequest,
  ...roles: Parameters<typeof requireRole>[1][]
) {
  const principal = req.principal as Principal;
  requireRole(principal, ...roles);
  return principal;
}

function deviceId(id: string): string {
  if (!isUuid(id)) throw new DeviceNotFoundError();
  return id;
}

@Controller("v1")
@UseGuards(AuthGuard)
export class InventoryController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post("sites")
  async createSite(@Req() req: ApiRequest, @Body() body: unknown) {
    authorized(req, "admin");
    const key = parseIdempotencyKey(header(req, "idempotency-key"));
    const { name } = parseSite(body);
    const siteId = randomUUID();
    return createSite(
      this.db,
      commandContext(req as Required<ApiRequest>, key),
      siteId,
      name,
    );
  }

  @Post("bins")
  async createBin(@Req() req: ApiRequest, @Body() body: unknown) {
    authorized(req, "admin");
    const key = parseIdempotencyKey(header(req, "idempotency-key"));
    const input = parseBin(body);
    const binId = randomUUID();
    return createBin(
      this.db,
      commandContext(req as Required<ApiRequest>, key),
      { binId, ...input },
    );
  }

  @Post("bins/:id/lots")
  async placeLot(
    @Req() req: ApiRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    authorized(req, "admin");
    if (!isUuid(id))
      throw new InvalidInputError("bin id must be a lowercase UUID");
    const key = parseIdempotencyKey(header(req, "idempotency-key"));
    return placeGrainLot(
      this.db,
      commandContext(req as Required<ApiRequest>, key),
      { binId: id, ...parseLotPlacement(body) },
    );
  }

  @Get("bins/:id/lots/at")
  async lotAt(
    @Req() req: ApiRequest,
    @Param("id") id: string,
    @Query("observedAt") observedAt?: string,
  ) {
    const principal = authorized(req, ...READ);
    if (!isUuid(id))
      throw new InvalidInputError("bin id must be a lowercase UUID");
    return {
      placement: await grainLotAt(
        this.db,
        principal.tenantId,
        id,
        parseObservedAt(observedAt),
      ),
    };
  }

  @Post("devices")
  async register(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body() body: unknown,
  ) {
    authorized(req, ...WRITE);
    const key = parseIdempotencyKey(header(req, "idempotency-key"));
    const input = parseRegister(body);
    const result = await registerDevice(
      this.db,
      commandContext(req as Required<ApiRequest>, key),
      input,
    );
    res.setHeader("ETag", etag(result.bindingVersion));
    res.setHeader("Location", `/v1/devices/${result.deviceId}`);
    return result;
  }

  @Post("devices/provisioning")
  async registerPending(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body() body: unknown,
  ) {
    authorized(req, "admin");
    const key = parseIdempotencyKey(header(req, "idempotency-key"));
    const result = await registerPendingDevice(
      this.db,
      commandContext(req as Required<ApiRequest>, key),
      parseRegisterPending(body),
    );
    res.setHeader("Location", `/v1/devices/${result.deviceId}`);
    return result;
  }

  @Get("devices")
  async list(
    @Req() req: ApiRequest,
    @Query("limit") limit?: string,
    @Query("after") after?: string,
  ) {
    const principal = authorized(req, ...READ);
    const page = parsePage(limit, after);
    const items = await listDevices(this.db, principal.tenantId, page);
    return {
      items: items.map(toDeviceDto),
      nextCursor:
        items.length === page.limit
          ? (items.at(-1) as { deviceId: string }).deviceId
          : null,
    };
  }

  @Get("devices/lookup")
  async lookup(
    @Req() req: ApiRequest,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    const principal = authorized(req, ...READ);
    if (
      Object.keys(query).join(",") !== "serial" ||
      typeof query.serial !== "string"
    )
      throw new InvalidInputError("serial is required");
    const matches = await lookupDeviceBySerial(
      this.db,
      principal.tenantId,
      query.serial,
    );
    res.setHeader("Cache-Control", "private, no-store");
    if (!matches.length) throw new DeviceNotFoundError();
    if (matches.length !== 1) throw new DeviceLookupAmbiguousError();
    return matches[0];
  }

  @Get("devices/:id")
  async get(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("id") id: string,
  ) {
    const principal = authorized(req, ...READ);
    const device = await getDevice(this.db, principal.tenantId, deviceId(id));
    if (!device) throw new DeviceNotFoundError();
    res.setHeader("ETag", etag(device.bindingVersion));
    return toDeviceDto(device);
  }

  @Patch("devices/:id")
  @HttpCode(200)
  async rebind(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    authorized(req, ...WRITE);
    const expectedVersion = parseIfMatch(header(req, "if-match"));
    const result = await changeDeviceBinding(
      this.db,
      commandContext(req as Required<ApiRequest>, randomUUID()),
      { deviceId: deviceId(id), expectedVersion, ...parseBinding(body) },
    );
    res.setHeader("ETag", etag(result.bindingVersion));
    return result;
  }

  @Post("devices/:id/status")
  @HttpCode(200)
  async setStatus(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    authorized(req, ...WRITE);
    const result = await setDeviceStatus(
      this.db,
      commandContext(req as Required<ApiRequest>, randomUUID()),
      { deviceId: deviceId(id), status: parseStatus(body) },
    );
    res.setHeader("ETag", etag(result.bindingVersion));
    return result;
  }
}
