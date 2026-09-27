import { EventEmitter } from "node:events";

export const liveChannel = "gg:read:v1:live";

export type LiveHint =
  | { scope: "device"; tenant: string; device: string }
  | { scope: "tenant"; tenant: string }
  | { scope: "epoch" };

export interface LiveSubscriber {
  subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<unknown>;
  on(
    event: "error" | "ready" | "end" | "reconnecting",
    listener: () => void,
  ): unknown;
}

export class LiveFeed {
  private readonly events = new EventEmitter();
  private readonly listeners = new Map<string, Map<string, Set<() => void>>>();
  private ready = false;
  private started = false;
  private readonly onMessage = (message: string) => {
    const hint = parseLiveHint(message);
    if (hint) this.dispatch(hint);
  };

  constructor(private readonly redis: LiveSubscriber) {
    this.events.setMaxListeners(0);
    redis.on("error", () => this.setReady(false));
    redis.on("end", () => this.setReady(false));
    redis.on("reconnecting", () => this.setReady(false));
    redis.on("ready", () => {
      if (this.started) void this.subscribe();
    });
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
  onHint(tenant: string, device: string, listener: () => void): () => void {
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
        callback();
      return;
    }
    const tenants =
      hint.scope === "epoch"
        ? this.listeners.values()
        : [this.listeners.get(hint.tenant)];
    for (const devices of tenants) {
      if (!devices) continue;
      for (const callbacks of devices.values())
        for (const callback of callbacks) callback();
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
    if (hint.scope === "tenant")
      return { scope: "tenant", tenant: hint.tenant };
    if (
      hint.scope === "device" &&
      typeof hint.device === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(hint.device)
    )
      return { scope: "device", tenant: hint.tenant, device: hint.device };
    return null;
  } catch {
    return null;
  }
}
