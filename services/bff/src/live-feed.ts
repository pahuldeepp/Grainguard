import {
  parseWatermark,
  serializeWatermark,
} from "@greenguard/membership-client";
import { EventEmitter } from "node:events";

export const liveChannel = "gg:read:v1:live";

export type LiveHint =
  | {
      scope: "device";
      tenant: string;
      device: string;
      consistencyToken?: string;
    }
  | { scope: "tenant"; tenant: string; consistencyToken?: string }
  | { scope: "epoch" };

export interface LiveSubscriber {
  subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<unknown>;
  on(
    event:
      "error" | "ready" | "end" | "reconnecting" | "connect" | "disconnect",
    listener: () => void,
  ): unknown;
}

export class LiveFeed {
  private readonly events = new EventEmitter();
  private readonly listeners = new Map<
    string,
    Map<string, Set<(hint: LiveHint) => void>>
  >();
  private ready = false;
  private started = false;
  private readonly onMessage = (message: string) => {
    const hint = parseLiveHint(message);
    if (hint) this.dispatch(hint);
  };

  constructor(
    private readonly redis: LiveSubscriber,
    private readonly clustered = false,
  ) {
    this.events.setMaxListeners(0);
    redis.on("error", () => this.setReady(false));
    if (clustered) {
      redis.on("disconnect", () => this.setReady(false));
      redis.on("connect", () => {
        if (this.started) void this.subscribe();
      });
    } else {
      redis.on("end", () => this.setReady(false));
      redis.on("reconnecting", () => this.setReady(false));
      redis.on("ready", () => {
        if (this.started) void this.subscribe();
      });
    }
  }

  private async subscribe(): Promise<void> {
    try {
      await this.redis.subscribe(liveChannel, this.onMessage);
      this.setReady(true);
    } catch {
      this.setReady(false);
    }
  }

  async start(): Promise<void> {
    this.started = true;
    await this.subscribe();
  }
  isReady(): boolean {
    return this.ready;
  }
  onHint(
    tenant: string,
    device: string,
    listener: (hint: LiveHint) => void,
  ): () => void {
    let devices = this.listeners.get(tenant);
    if (!devices) {
      devices = new Map();
      this.listeners.set(tenant, devices);
    }
    let callbacks = devices.get(device);
    if (!callbacks) {
      callbacks = new Set();
      devices.set(device, callbacks);
    }
    callbacks.add(listener);
    return () => {
      callbacks.delete(listener);
      if (callbacks.size === 0) devices.delete(device);
      if (devices.size === 0) this.listeners.delete(tenant);
    };
  }
  private dispatch(hint: LiveHint): void {
    if (hint.scope === "device") {
      for (const callback of this.listeners
        .get(hint.tenant)
        ?.get(hint.device) ?? [])
        callback(hint);
      return;
    }
    const tenants =
      hint.scope === "epoch"
        ? this.listeners.values()
        : [this.listeners.get(hint.tenant)];
    for (const devices of tenants) {
      if (!devices) continue;
      for (const callbacks of devices.values())
        for (const callback of callbacks) callback(hint);
    }
  }
  onStatus(listener: (ready: boolean) => void): () => void {
    this.events.on("status", listener);
    return () => this.events.off("status", listener);
  }
  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.events.emit("status", ready);
  }
}

export function parseLiveHint(message: string): LiveHint | null {
  try {
    const value: unknown = JSON.parse(message);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const hint = value as Record<string, unknown>;
    if (hint.scope === "epoch") return { scope: "epoch" };
    if (
      typeof hint.tenant !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(hint.tenant)
    )
      return null;
    const hasWatermark = [
      "shard_incarnation",
      "placement_epoch",
      "projection_sequence",
    ].some((key) => key in hint);
    let consistencyToken: string | undefined;
    if (hasWatermark) {
      try {
        consistencyToken = serializeWatermark(
          parseWatermark(
            JSON.stringify({
              v: 1,
              tenantId: hint.tenant,
              shardIncarnation: hint.shard_incarnation,
              placementEpoch: hint.placement_epoch,
              sequence: hint.projection_sequence,
            }),
            hint.tenant,
          ),
        );
      } catch {
        // Invalid optional proof cannot authorize a weaker minimum. Keep the
        // scoped invalidation so listeners refetch under their retained demand.
      }
    }
    if (hint.scope === "tenant")
      return {
        scope: "tenant",
        tenant: hint.tenant,
        ...(consistencyToken ? { consistencyToken } : {}),
      };
    if (
      hint.scope === "device" &&
      typeof hint.device === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(hint.device)
    )
      return {
        scope: "device",
        tenant: hint.tenant,
        device: hint.device,
        ...(consistencyToken ? { consistencyToken } : {}),
      };
    return null;
  } catch {
    return null;
  }
}
