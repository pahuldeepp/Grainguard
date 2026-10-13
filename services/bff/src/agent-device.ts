import { AuthError } from "@greenguard/tenant-auth";
import { allowedInternalUrl } from "./internal-url.js";
export class AgentDeviceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export class AgentDeviceLookup {
  private readonly origin: URL;
  constructor(url: string) {
    if (!allowedInternalUrl(url)) throw new Error("invalid device origin");
    this.origin = new URL(url);
    if (this.origin.username || this.origin.password || this.origin.hash)
      throw new Error("invalid device origin");
  }
  async resolve(
    serial: string,
    authorization: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const url = new URL("/v1/devices/lookup", this.origin);
      url.searchParams.set("serial", serial);
      const response = await fetch(url, {
        headers: { Authorization: authorization },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      });
      if (!response.ok) await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new AuthError(response.status, "invalid_claims");
      if (response.status === 404)
        throw new AgentDeviceError(404, "device_not_found");
      if (response.status === 409)
        throw new AgentDeviceError(409, "device_lookup_ambiguous");
      if (!response.ok || !response.body)
        throw new AgentDeviceError(503, "device_lookup_unavailable");
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8192)
            throw new AgentDeviceError(503, "device_lookup_unavailable");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        body.serialNumber !== serial ||
        typeof body.deviceId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          body.deviceId,
        )
      )
        throw new AgentDeviceError(503, "device_lookup_unavailable");
      return body.deviceId;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof AgentDeviceError) throw error;
      throw new AgentDeviceError(503, "device_lookup_unavailable");
    }
  }
}
