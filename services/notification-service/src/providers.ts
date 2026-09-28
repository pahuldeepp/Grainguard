import type {
  ProviderAdapter,
  SendRequest,
  SendResult,
  ReconcileResult,
} from "./adapters.js";
import type { Task } from "./task.js";
import { isUuid } from "./tenant.js";

export interface NotificationContacts {
  email: string | null;
  sms: string | null;
  version: string;
}

/** Implementations must resolve the tenant's trusted control-plane contacts. */
export interface ContactResolver {
  lookup(tenantId: string): Promise<NotificationContacts>;
}

export interface NotificationProviderConfig {
  timeoutMs: number;
  controlPlane?: { url: string; token: string; allowInsecureHttp?: boolean };
  sendgrid?: { apiKey: string; fromEmail: string };
  twilio?: { accountSid: string; authToken: string; fromNumber: string };
}

export interface ProviderDependencies {
  resolver?: ContactResolver;
  fetch?: typeof fetch;
}
export type ProviderName = "sendgrid" | "twilio";
export type ProviderSelector = (
  severity: string,
  channel: string,
) => ProviderAdapter;

/** Deliberately contains no provider error, response, credential, or recipient. */
export class UnknownProviderOutcomeError extends Error {
  constructor(provider: ProviderName) {
    super(`${provider} acceptance is unknown`);
    this.name = "UnknownProviderOutcomeError";
  }
}
export class ContactLookupError extends Error {
  constructor() {
    super("trusted notification contacts unavailable");
    this.name = "ContactLookupError";
  }
}

function checkTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error(
      "notification request timeout must be between 1 and 120000 ms",
    );
}

/** A hard deadline applies even when an injected client ignores cancellation. */
async function bounded<T>(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort();
      reject(new Error("notification request aborted"));
    };
    if (parent?.aborted) abort();
    else parent?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, timeoutMs);
  });
  try {
    // Do not start a provider request if its caller already cancelled.
    if (controller.signal.aborted) return await deadline;
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    if (abort) parent?.removeEventListener("abort", abort);
  }
}

const EMAIL = /^[^\s@<>;,"]+@[^\s@<>;,"]+\.[^\s@<>;,"]+$/;
const SMS = /^\+[1-9][0-9]{7,14}$/;
function validEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 320 &&
    [...value].every(
      (char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127,
    ) &&
    EMAIL.test(value)
  );
}
function validSms(value: unknown): value is string {
  return typeof value === "string" && SMS.test(value);
}
function contactsOf(value: unknown): NotificationContacts {
  if (!value || typeof value !== "object") throw new ContactLookupError();
  const contacts = value as NotificationContacts;
  if (
    !(contacts.email === null || validEmail(contacts.email)) ||
    !(contacts.sms === null || validSms(contacts.sms)) ||
    typeof contacts.version !== "string" ||
    !/^[0-9]{1,20}$/.test(contacts.version)
  )
    throw new ContactLookupError();
  return {
    email: contacts.email,
    sms: contacts.sms,
    version: contacts.version,
  };
}

/** Reads PostgreSQL-backed trusted contacts through the authenticated internal API. */
export class HttpContactResolver implements ContactResolver {
  private readonly baseUrl: string;
  constructor(
    private readonly config: {
      url: string;
      token: string;
      allowInsecureHttp?: boolean;
    },
    private readonly timeoutMs = 5000,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    checkTimeout(timeoutMs);
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error("invalid notification contact lookup configuration");
    }
    if (
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && config.allowInsecureHttp === true)
      ) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !config.token ||
      /[\r\n]/.test(config.token)
    )
      throw new Error("invalid notification contact lookup configuration");
    this.baseUrl = url.toString().replace(/\/$/, "");
  }

  async lookup(tenantId: string): Promise<NotificationContacts> {
    if (!isUuid(tenantId)) throw new ContactLookupError();
    try {
      return await bounded(this.timeoutMs, undefined, async (signal) => {
        const response = await this.fetcher(
          `${this.baseUrl}/v1/internal/notification-contacts/${encodeURIComponent(tenantId)}`,
          {
            method: "GET",
            redirect: "error",
            signal,
            headers: { authorization: `Bearer ${this.config.token}` },
          },
        );
        if (response.status === 404)
          return { email: null, sms: null, version: "0" };
        if (response.status !== 200) throw new ContactLookupError();
        return contactsOf(await response.json());
      });
    } catch {
      // Do not expose API response bodies, contacts, or bearer credentials to the ledger.
      throw new ContactLookupError();
    }
  }
}

/** Only bounded, validated identifiers and ASCII event labels enter plain-text content. */
export function plainTextTemplate(task: Task): {
  subject: string;
  body: string;
} {
  if (
    !task ||
    ![
      task.intent_id,
      task.tenant_id,
      task.alert_id,
      task.episode_id,
      task.correlation_id,
    ].every(isUuid) ||
    !["email", "sms"].includes(task.channel) ||
    typeof task.severity !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(task.severity) ||
    typeof task.transition !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(task.transition) ||
    !Number.isSafeInteger(task.transition_version) ||
    task.transition_version < 1 ||
    !Number.isSafeInteger(task.delivery_generation) ||
    task.delivery_generation < 0
  )
    throw new Error("invalid notification template fields");
  return {
    subject: `GreenGuard ${task.severity} alert`,
    body: `GreenGuard ${task.severity} alert\nAlert: ${task.alert_id}\nTransition: ${task.transition}\nVersion: ${task.transition_version}\nOpen your GreenGuard dashboard to review this alert.`,
  };
}

function httpNonAcceptance(
  status: number,
  provider: ProviderName,
): SendResult | undefined {
  if (status === 429)
    return { kind: "transient", reason: `${provider} throttled` };
  if ([400, 401, 403, 404, 405, 413, 415, 422].includes(status))
    return { kind: "rejected", reason: `${provider} request rejected` };
  // 408/5xx/redirects/unexpected success may follow acceptance. Never infer failure.
  return undefined;
}

function safeReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value);
}

class LiveProviderAdapter implements ProviderAdapter {
  constructor(
    readonly provider: ProviderName,
    private readonly channel: "email" | "sms",
    private readonly config: NotificationProviderConfig,
    private readonly deps: Required<
      Pick<ProviderDependencies, "resolver" | "fetch">
    >,
  ) {}

  async send(request: SendRequest, signal: AbortSignal): Promise<SendResult> {
    let template: ReturnType<typeof plainTextTemplate>;
    try {
      template = plainTextTemplate(request.task);
      if (
        request.idempotencyKey !== request.task.intent_id ||
        request.task.channel !== this.channel ||
        request.task.severity === "critical"
      )
        throw new Error("notification selector mismatch");
    } catch {
      return { kind: "rejected", reason: "invalid notification task" };
    }
    let providerStarted = false;
    try {
      return await bounded(
        this.config.timeoutMs,
        signal,
        async (providerSignal) => {
          // Resolve before the worker's overall deadline, so a lookup outage is
          // known-not-sent and remains retryable rather than entering reconciliation.
          const contacts = await bounded(
            Math.max(1, Math.floor(this.config.timeoutMs / 2)),
            providerSignal,
            async () =>
              contactsOf(
                await this.deps.resolver.lookup(request.task.tenant_id),
              ),
          );
          providerSignal.throwIfAborted();
          const recipient = contacts[this.channel];
          if (recipient === null)
            return {
              kind: "rejected",
              reason: `trusted ${this.channel} contact missing`,
            };
          return this.dispatch(
            request,
            recipient,
            template,
            providerSignal,
            () => {
              providerStarted = true;
            },
          );
        },
      );
    } catch {
      if (!providerStarted)
        return {
          kind: "transient",
          reason: "trusted notification contacts unavailable",
        };
      // Only the provider request can create an uncertain send. Never expose its error.
      throw new UnknownProviderOutcomeError(this.provider);
    }
  }

  async reconcile(): Promise<ReconcileResult> {
    return {
      kind: "unknown",
      reason: `${this.provider} cannot prove non-delivery by intent ID`,
    };
  }

  private async dispatch(
    request: SendRequest,
    recipient: string,
    template: { subject: string; body: string },
    signal: AbortSignal,
    onRequestStarted: () => void,
  ): Promise<SendResult> {
    if (this.provider === "sendgrid") {
      const settings = this.config.sendgrid;
      if (!settings?.apiKey || !validEmail(settings.fromEmail))
        return {
          kind: "transient",
          reason: "sendgrid provider not configured",
        };
      onRequestStarted();
      const response = await this.deps.fetch(
        "https://api.sendgrid.com/v3/mail/send",
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: recipient }] }],
            from: { email: settings.fromEmail },
            subject: template.subject,
            content: [{ type: "text/plain", value: template.body }],
            custom_args: { intent_id: request.idempotencyKey },
          }),
        },
      );
      if (response.status === 202) {
        const ref = response.headers.get("x-message-id");
        // 202 confirms acceptance even if the optional tracking header is absent.
        return {
          kind: "sent",
          providerRef: safeReference(ref)
            ? ref
            : `sendgrid-accepted:${request.task.intent_id}`,
        };
      }
      const known = httpNonAcceptance(response.status, this.provider);
      if (known) return known;
      throw new UnknownProviderOutcomeError(this.provider);
    }
    const settings = this.config.twilio;
    if (
      !settings ||
      !/^AC[0-9a-fA-F]{32}$/.test(settings.accountSid) ||
      !settings.authToken ||
      !validSms(settings.fromNumber)
    )
      return { kind: "transient", reason: "twilio provider not configured" };
    // Twilio's Message create API has no arbitrary intent metadata or native dedupe key.
    // The ledger retains the stable intent ID; no unsupported API field is invented.
    onRequestStarted();
    const response = await this.deps.fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`,
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: recipient,
          From: settings.fromNumber,
          Body: template.body,
        }).toString(),
      },
    );
    const known = httpNonAcceptance(response.status, this.provider);
    if (known) return known;
    if (response.status !== 201)
      throw new UnknownProviderOutcomeError(this.provider);
    const result = (await response.json()) as {
      sid?: unknown;
      status?: unknown;
    } | null;
    if (
      !result ||
      typeof result.sid !== "string" ||
      !/^SM[0-9a-fA-F]{32}$/.test(result.sid) ||
      typeof result.status !== "string"
    )
      throw new UnknownProviderOutcomeError(this.provider);
    if (["failed", "undelivered", "canceled"].includes(result.status))
      return { kind: "rejected", reason: "twilio message rejected" };
    if (
      !["accepted", "queued", "sending", "sent", "delivered"].includes(
        result.status,
      )
    )
      throw new UnknownProviderOutcomeError(this.provider);
    return { kind: "sent", providerRef: result.sid };
  }
}

/** Intent metadata is correlation only. The ledger must never resend an uncertain send. */
export function createProviderSelector(
  config: NotificationProviderConfig,
  dependencies: ProviderDependencies = {},
): ProviderSelector {
  checkTimeout(config.timeoutMs);
  const fetcher = dependencies.fetch ?? fetch;
  const resolver =
    dependencies.resolver ??
    (config.controlPlane
      ? new HttpContactResolver(config.controlPlane, config.timeoutMs, fetcher)
      : undefined);
  if (!resolver)
    throw new Error("trusted notification contact resolver is required");
  const deps = { resolver, fetch: fetcher };
  const adapters = {
    sendgrid: new LiveProviderAdapter("sendgrid", "email", config, deps),
    twilio: new LiveProviderAdapter("twilio", "sms", config, deps),
  };
  return (severity, channel) => {
    if (channel !== "email" && channel !== "sms")
      throw new Error("unsupported notification provider channel");
    if (severity !== "warning")
      throw new Error(
        "only warning notifications are owned by the RabbitMQ provider worker",
      );
    return channel === "email" ? adapters.sendgrid : adapters.twilio;
  };
}
