import { requireRole, type Principal } from "@greenguard/tenant-auth";
import { allowedInternalUrl } from "./internal-url.js";

export class NotificationUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

type Wire = Record<string, unknown>;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Calls each notification owner with the caller bearer; BFF owns no notification DB credentials. */
export class NotificationClient {
  constructor(
    private readonly intentsURL: string,
    private readonly deliveryURL?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    for (const value of [intentsURL, deliveryURL].filter(
      (url): url is string => !!url,
    )) {
      const url = new URL(value);
      if (
        !allowedInternalUrl(value) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "notification owner URLs must use HTTPS, loopback HTTP, or explicitly enabled mesh HTTP without credentials",
        );
    }
  }
  private async call<T>(
    url: URL,
    authorization: string,
    init: RequestInit,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: { Authorization: authorization, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(3500),
      });
    } catch {
      throw new NotificationUpstreamError(503, "owner_unavailable");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new NotificationUpstreamError(
        response.status,
        body.includes("not_configured")
          ? "not_configured"
          : response.status === 503
            ? "owner_unavailable"
            : "notification_owner_rejected",
      );
    }
    return (await response.json()) as T;
  }
  async history(
    principal: Principal,
    authorization: string,
    alertId: string,
    limit: number,
    after?: string,
  ) {
    requireRole(principal, "operator", "admin");
    if (
      !UUID.test(alertId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (after !== undefined &&
        (after.length > 2048 || !/^[A-Za-z0-9_.-]+$/.test(after)))
    )
      throw new NotificationUpstreamError(400, "invalid_notification_page");
    const params = new URLSearchParams({ alertId, limit: String(limit) });
    if (after) params.set("after", after);
    let intents: { items: Wire[]; nextCursor: string | null };
    try {
      intents = await this.call<{ items: Wire[]; nextCursor: string | null }>(
        new URL(`/internal/v1/notification-intents?${params}`, this.intentsURL),
        authorization,
        { method: "GET" },
      );
    } catch (error) {
      if (!(error instanceof NotificationUpstreamError) || error.status < 500)
        throw error;
      return {
        items: [],
        nextCursor: null,
        complete: false,
        sources: {
          intents: {
            status:
              error.code === "not_configured"
                ? "not_configured"
                : "unavailable",
            reasonCode: error.code,
          },
          warning: {
            status:
              error.code === "not_configured"
                ? "not_configured"
                : "unavailable",
            reasonCode: error.code,
          },
          critical: {
            status: "not_configured",
            reasonCode: "critical_owner_not_configured",
          },
          transitions: {
            status: "unsupported",
            reasonCode: "not_used_for_notification_history",
          },
        },
      };
    }
    const intentItems = intents.items ?? [];
    const validIntents = intentItems.filter(
      (item): item is Wire & { intentId: string; deliveryGeneration: number } =>
        typeof item.intentId === "string" &&
        Number.isSafeInteger(item.deliveryGeneration) &&
        typeof item.transitionVersion === "string" &&
        typeof item.transition === "string" &&
        typeof item.channel === "string",
    );
    const pairs = validIntents.map((item) => ({
      intentId: item.intentId,
      deliveryGeneration: item.deliveryGeneration,
    }));
    let outcomes: Wire[] = [];
    let warningStatus =
      validIntents.length === intentItems.length ? "ok" : "partial";
    if (pairs.length) {
      if (!this.deliveryURL) warningStatus = "unavailable";
      else {
        try {
          const result = await this.call<{ items: Wire[] }>(
            new URL("/internal/v1/deliveries/lookup", this.deliveryURL),
            authorization,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ pairs }),
            },
          );
          outcomes = result.items ?? [];
        } catch (error) {
          if (
            !(error instanceof NotificationUpstreamError) ||
            error.status < 500
          )
            throw error;
          warningStatus = "partial";
        }
      }
    }
    const byKey = new Map(
      outcomes.map((item) => [
        `${item.intentId}:${item.deliveryGeneration}`,
        item,
      ]),
    );
    const items = validIntents.map((intent) => {
      const outcome = byKey.get(
        `${intent.intentId}:${intent.deliveryGeneration}`,
      );
      return {
        intentId: intent.intentId,
        transitionVersion: intent.transitionVersion,
        transition: intent.transition,
        severity: intent.severity ?? null,
        channel: intent.channel,
        deliveryGeneration: intent.deliveryGeneration,
        redriveCount: intent.deliveryGeneration,
        state: outcome?.state ?? intent.state ?? "unknown",
        reasonCode: outcome?.reasonCode ?? intent.reasonCode ?? null,
        queuedAt: intent.queuedAt ?? null,
        firstAttemptAt:
          outcome?.firstAttemptAt ?? intent.firstAttemptAt ?? null,
        lastAttemptAt: outcome?.lastAttemptAt ?? intent.lastAttemptAt ?? null,
        resolvedAt: outcome?.resolvedAt ?? intent.resolvedAt ?? null,
        dispatchAttempts: intent.dispatchAttempts ?? null,
        providerAttempts: outcome?.providerAttempts ?? null,
        events: outcome?.events ?? [],
        attemptsTruncated: outcome?.attemptsTruncated ?? false,
      };
    });
    return {
      items,
      nextCursor: intents.nextCursor ?? null,
      complete: false,
      sources: {
        intents: { status: "ok", reasonCode: null },
        warning: {
          status: warningStatus,
          reasonCode:
            warningStatus === "ok" ? null : "delivery_source_unavailable",
        },
        critical: {
          status: "not_configured",
          reasonCode: "critical_owner_not_configured",
        },
        transitions: {
          status: "unsupported",
          reasonCode: "not_used_for_notification_history",
        },
      },
    };
  }
}
