import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import {
  createProviderSelector,
  plainTextTemplate,
  UnknownProviderOutcomeError,
  HttpContactResolver,
  ContactLookupError,
  type NotificationProviderConfig,
  type ProviderDependencies,
  type ProviderName,
} from "./providers.js";
import type { SendRequest } from "./adapters.js";
import { makeTask, makeDeps } from "./testing/fixtures.js";
import { attemptSend } from "./worker.js";

const email = "trusted@example.test";
const sms = "+12045550123";
const sid = `SM${"a".repeat(32)}`;
const config: NotificationProviderConfig = {
  timeoutMs: 100,
  controlPlane: {
    url: "https://control-plane.internal:8095",
    token: "lookup-secret",
  },
  sendgrid: { apiKey: "sendgrid-secret", fromEmail: "alerts@example.test" },
  twilio: {
    accountSid: `AC${"b".repeat(32)}`,
    authToken: "twilio-secret",
    fromNumber: "+12045550124",
  },
};
const signal = new AbortController().signal;
const routes = [
  { provider: "sendgrid", severity: "warning", channel: "email" },
  { provider: "twilio", severity: "warning", channel: "sms" },
] as const;
function request(severity: string, channel: "email" | "sms"): SendRequest {
  const task = makeTask({ severity, channel });
  return { task, idempotencyKey: task.intent_id };
}
function success(provider: ProviderName): Response {
  return provider === "sendgrid"
    ? new Response(null, {
        status: 202,
        headers: { "x-message-id": "sendgrid-ref" },
      })
    : Response.json(
        { sid, status: "queued", to: sms, body: "response-PII" },
        { status: 201 },
      );
}
function dependencies(
  overrides: Partial<ProviderDependencies> = {},
): ProviderDependencies {
  return {
    resolver: { lookup: async () => ({ email, sms, version: "3" }) },
    fetch: async (url) =>
      success(String(url).includes("sendgrid") ? "sendgrid" : "twilio"),
    ...overrides,
  };
}
for (const { provider, severity, channel } of routes) {
  test(`${provider} selects expected route, uses trusted contact, and confirms acceptance`, async () => {
    const sent: (RequestInit & { url: string })[] = [];
    const lookups: string[] = [];
    const deps = dependencies({
      resolver: {
        lookup: async (tenantId) => {
          lookups.push(tenantId);
          return { email, sms, version: "3" };
        },
      },
      fetch: async (url, options) => {
        sent.push({ url: String(url), ...options });
        return success(provider);
      },
    });
    const adapter = createProviderSelector(config, deps)(severity, channel);
    const req = request(severity, channel);
    Object.assign(req.task, {
      recipient: "attacker@example.test",
      email: "attacker@example.test",
      sms: "+12045550999",
      body: "<script>evil</script>",
    });
    assert.equal((await adapter.send(req, signal)).kind, "sent");
    assert.deepEqual(lookups, [req.task.tenant_id]);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.url.startsWith("https://"));
    assert.equal(sent[0]!.redirect, "error");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.signal?.aborted, false);
    assert.ok(!JSON.stringify(sent).includes("attacker"));
    assert.ok(!JSON.stringify(sent).includes("<script>"));
    const headers = new Headers(sent[0]!.headers);
    assert.equal(
      headers.get("authorization"),
      provider === "sendgrid"
        ? "Bearer sendgrid-secret"
        : `Basic ${Buffer.from(`${config.twilio!.accountSid}:twilio-secret`).toString("base64")}`,
    );
    if (provider === "sendgrid") {
      assert.equal(sent[0]!.url, "https://api.sendgrid.com/v3/mail/send");
      assert.equal(headers.get("content-type"), "application/json");
      const payload = JSON.parse(sent[0]!.body as string);
      assert.deepEqual(payload.personalizations, [{ to: [{ email }] }]);
      assert.deepEqual(payload.custom_args, { intent_id: req.task.intent_id });
      assert.deepEqual(payload.from, { email: config.sendgrid!.fromEmail });
      assert.equal(payload.content[0].type, "text/plain");
      assert.equal(payload.content[0].value, plainTextTemplate(req.task).body);
    } else {
      assert.equal(
        sent[0]!.url,
        `https://api.twilio.com/2010-04-01/Accounts/${config.twilio!.accountSid}/Messages.json`,
      );
      assert.equal(
        headers.get("content-type"),
        "application/x-www-form-urlencoded",
      );
      const payload = new URLSearchParams(sent[0]!.body as string);
      assert.deepEqual([...payload.keys()], ["To", "From", "Body"]);
      assert.equal(payload.get("To"), sms);
      assert.equal(payload.get("From"), config.twilio!.fromNumber);
      assert.equal(payload.get("Body"), plainTextTemplate(req.task).body);
    }
    assert.deepEqual(await adapter.reconcile(req.task.intent_id, signal), {
      kind: "unknown",
      reason: `${provider} cannot prove non-delivery by intent ID`,
    });
    assert.equal(
      sent.length,
      1,
      "reconcile never sends or queries an unsupported delivery contract",
    );
  });

  test(`${provider} permanently rejects missing selected contact without fallback`, async () => {
    let calls = 0;
    const adapter = createProviderSelector(
      config,
      dependencies({
        resolver: {
          lookup: async () => ({
            email: channel === "email" ? null : email,
            sms: channel === "sms" ? null : sms,
            version: "1",
          }),
        },
        fetch: async () => {
          calls++;
          return success(provider);
        },
      }),
    )(severity, channel);
    assert.deepEqual(await adapter.send(request(severity, channel), signal), {
      kind: "rejected",
      reason: `trusted ${channel} contact missing`,
    });
    assert.equal(calls, 0);
  });

  test(`${provider} preserves network ambiguity and strips sensitive exceptions`, async () => {
    const adapter = createProviderSelector(
      config,
      dependencies({
        fetch: async () => {
          throw new Error(
            `${email} ${sms} sendgrid-secret twilio-secret response-PII`,
          );
        },
      }),
    )(severity, channel);
    await assert.rejects(
      adapter.send(request(severity, channel), signal),
      (error: unknown) => {
        assert.ok(error instanceof UnknownProviderOutcomeError);
        assert.equal(error.message, `${provider} acceptance is unknown`);
        assert.ok(!String(error.stack).includes(email));
        assert.equal((error as Error & { cause?: unknown }).cause, undefined);
        return true;
      },
    );
  });

  test(`${provider} classifies confirmed rejection/throttle and keeps ambiguous responses unknown`, async () => {
    for (const [status, expected] of [
      [400, "rejected"],
      [401, "transient"],
      [403, "transient"],
      [422, "rejected"],
      [429, "transient"],
      [500, "unknown"],
      [503, "unknown"],
      [408, "unknown"],
      [302, "unknown"],
      [409, "unknown"],
    ] as const) {
      let calls = 0;
      const adapter = createProviderSelector(
        config,
        dependencies({
          fetch: async () => {
            calls++;
            return new Response(`response contains ${email} ${sms}`, {
              status,
            });
          },
        }),
      )(severity, channel);
      if (expected === "unknown")
        await assert.rejects(
          adapter.send(request(severity, channel), signal),
          UnknownProviderOutcomeError,
        );
      else {
        const result = await adapter.send(request(severity, channel), signal);
        assert.equal(result.kind, expected);
        assert.ok(!JSON.stringify(result).includes(email));
      }
      assert.equal(
        calls,
        1,
        "no internal retry after ambiguous or rejected response",
      );
    }
  });

  test(`${provider} enforces deadline even when fetch ignores AbortSignal`, async () => {
    let providerSignal: AbortSignal | undefined;
    const adapter = createProviderSelector(
      { ...config, timeoutMs: 10 },
      dependencies({
        fetch: async (_url, options) => {
          providerSignal = options?.signal as AbortSignal;
          return new Promise<never>(() => {});
        },
      }),
    )(severity, channel);
    await assert.rejects(
      adapter.send(request(severity, channel), signal),
      UnknownProviderOutcomeError,
    );
    assert.equal(providerSignal?.aborted, true);
  });

  test(`${provider} propagates caller cancellation without exposing abort reason`, async () => {
    const controller = new AbortController();
    const adapter = createProviderSelector(
      config,
      dependencies({
        fetch: async () => {
          controller.abort(new Error(email));
          return new Promise<never>(() => {});
        },
      }),
    )(severity, channel);
    await assert.rejects(
      adapter.send(request(severity, channel), controller.signal),
      UnknownProviderOutcomeError,
    );
  });
}

test("non-critical selector matrix allows only warning email and SMS", async () => {
  let sends = 0;
  const selector = createProviderSelector(
    config,
    dependencies({
      fetch: async (url) => {
        sends++;
        return success(
          String(url).includes("sendgrid") ? "sendgrid" : "twilio",
        );
      },
    }),
  );
  for (const channel of ["email", "sms"] as const) {
    assert.equal(
      (
        await selector("warning", channel).send(
          request("warning", channel),
          signal,
        )
      ).kind,
      "sent",
    );
  }
  for (const channel of ["push", "fax", "", "EMAIL", "webhook"]) {
    assert.throws(
      () => selector("warning", channel),
      /unsupported notification provider channel/,
    );
  }
  for (const severity of [
    "critical",
    "Critical",
    "critical ",
    "info",
    "resolved",
    "notice",
    "WARNING",
    "warning ",
    "",
  ]) {
    for (const channel of ["email", "sms"]) {
      assert.throws(
        () => selector(severity, channel),
        /only warning notifications/,
      );
    }
  }
  assert.equal(sends, 2);
});

test("HTTP resolver makes an exact authenticated tenant contact GET", async () => {
  const tenantId = makeTask().tenant_id;
  const resolver = new HttpContactResolver(
    config.controlPlane!,
    100,
    async (url, options) => {
      assert.equal(
        url,
        `${config.controlPlane!.url}/v1/internal/notification-contacts/${tenantId}`,
      );
      assert.equal(options!.method, "GET");
      assert.equal(options!.redirect, "error");
      assert.equal(options!.signal!.aborted, false);
      assert.equal(
        new Headers(options!.headers).get("authorization"),
        "Bearer lookup-secret",
      );
      return Response.json({ email, sms, version: "3" });
    },
  );
  assert.deepEqual(await resolver.lookup(tenantId), {
    email,
    sms,
    version: "3",
  });
});

test("HTTP contacts are fetched independently for the task tenant with no shared recipient cache", async () => {
  const tenants = [makeTask().tenant_id, makeTask().tenant_id];
  const seen: string[] = [];
  const resolver = new HttpContactResolver(
    config.controlPlane!,
    100,
    async (url) => {
      const tenantId = String(url).split("/").at(-1)!;
      seen.push(tenantId);
      return Response.json({
        email:
          tenantId === tenants[0]
            ? "first@example.test"
            : "second@example.test",
        sms: null,
        version: "1",
      });
    },
  );
  assert.equal(
    (await resolver.lookup(tenants[0]!)).email,
    "first@example.test",
  );
  assert.equal(
    (await resolver.lookup(tenants[1]!)).email,
    "second@example.test",
  );
  assert.deepEqual(seen, tenants);
});

test("missing trusted API record returns null; selector never falls back or sends", async () => {
  const tenantId = makeTask().tenant_id;
  const missing = new HttpContactResolver(
    config.controlPlane!,
    100,
    async () => new Response("sensitive", { status: 404 }),
  );
  assert.deepEqual(await missing.lookup(tenantId), {
    email: null,
    sms: null,
    version: "0",
  });
  let calls = 0;
  const selector = createProviderSelector(config, {
    fetch: async (url) => {
      calls++;
      assert.ok(String(url).startsWith(config.controlPlane!.url));
      return new Response(null, { status: 404 });
    },
  });
  assert.deepEqual(
    await selector("warning", "email").send(
      request("warning", "email"),
      signal,
    ),
    { kind: "rejected", reason: "trusted email contact missing" },
  );
  assert.equal(calls, 1);
});

test("malformed contacts/statuses and invalid tenant never expose sensitive API errors", async () => {
  const tenantId = makeTask().tenant_id;
  for (const value of [
    null,
    {},
    { email: "injected\r\nBcc: attacker@example.test", sms, version: "1" },
    { email, sms: "whatsapp:+12045550123", version: "1" },
    { email, sms, version: 3 },
    { email, sms, version: "bad" },
  ]) {
    const resolver = new HttpContactResolver(
      config.controlPlane!,
      100,
      async () => Response.json(value),
    );
    await assert.rejects(resolver.lookup(tenantId), {
      name: "ContactLookupError",
      message: "trusted notification contacts unavailable",
    });
  }
  for (const status of [401, 403, 429, 500, 302]) {
    const resolver = new HttpContactResolver(
      config.controlPlane!,
      100,
      async () => new Response(email, { status }),
    );
    await assert.rejects(resolver.lookup(tenantId), ContactLookupError);
  }
  let calls = 0;
  const resolver = new HttpContactResolver(
    config.controlPlane!,
    100,
    async () => {
      calls++;
      return Response.json({ email, sms, version: "1" });
    },
  );
  for (const invalid of ["../../other", "invalid", "", email])
    await assert.rejects(resolver.lookup(invalid), ContactLookupError);
  assert.equal(calls, 0);
  for (const settings of [
    { url: "invalid", token: "token" },
    { url: "file:///etc/passwd", token: "token" },
    { url: "http://user:pass@example.test", token: "token" },
    { url: "http://example.test?token=secret", token: "token" },
    { url: "http://example.test", token: "injected\r\nheader" },
    { url: "http://example.test", token: "" },
  ])
    assert.throws(
      () => new HttpContactResolver(settings),
      /invalid notification contact lookup configuration/,
    );
});

test("contact email validation stays bounded on adversarial input", async () => {
  const tenantId = makeTask().tenant_id;
  const almostEmail = `${"a".repeat(160)}@${"b".repeat(158)}`;
  const resolver = new HttpContactResolver(
    { url: "https://control.test", token: "token" },
    100,
    async () => Response.json({ email: almostEmail, sms, version: "1" }),
  );
  await assert.rejects(resolver.lookup(tenantId), ContactLookupError);
});

test("HTTP lookup network/body failures and timeout are sanitized and bounded", async () => {
  const tenantId = makeTask().tenant_id;
  const fail = new HttpContactResolver(config.controlPlane!, 100, async () => {
    throw new Error(`${email} credentials response-PII`);
  });
  await assert.rejects(fail.lookup(tenantId), {
    name: "ContactLookupError",
    message: "trusted notification contacts unavailable",
  });
  const invalidJson = new HttpContactResolver(
    config.controlPlane!,
    100,
    async () => new Response(email),
  );
  await assert.rejects(invalidJson.lookup(tenantId), ContactLookupError);
  let readSignal: AbortSignal | undefined;
  const hanging = new HttpContactResolver(
    config.controlPlane!,
    10,
    async (_url, options) => {
      readSignal = options!.signal!;
      return new Promise<never>(() => {});
    },
  );
  await assert.rejects(hanging.lookup(tenantId), ContactLookupError);
  assert.equal(readSignal?.aborted, true);
});

test("HTTP-backed selector resolves trusted contact before provider dispatch", async () => {
  const req = request("warning", "email");
  const urls: string[] = [];
  const selector = createProviderSelector(config, {
    fetch: async (url, options) => {
      urls.push(String(url));
      if (String(url).startsWith(config.controlPlane!.url))
        return Response.json({ email, sms, version: "3" });
      assert.equal(
        JSON.parse(options!.body as string).personalizations[0].to[0].email,
        email,
      );
      return success("sendgrid");
    },
  });
  assert.equal(
    (await selector("warning", "email").send(req, signal)).kind,
    "sent",
  );
  assert.deepEqual(urls, [
    `${config.controlPlane!.url}/v1/internal/notification-contacts/${req.task.tenant_id}`,
    "https://api.sendgrid.com/v3/mail/send",
  ]);
});

test("malformed injected contacts, lookup errors and slow lookups never reach provider", async () => {
  const malformed = [
    { email: "injected\r\nBcc: attacker@example.test", sms, version: "1" },
    { email, sms: "not-E164", version: "1" },
    { email, sms, version: "bad\nversion" },
  ];
  const lookups = [
    ...malformed.map((value) => async () => value),
    async () => {
      throw new Error(email);
    },
    async () => new Promise<never>(() => {}),
  ];
  for (const lookup of lookups) {
    let calls = 0;
    const adapter = createProviderSelector(
      { ...config, timeoutMs: 10 },
      dependencies({
        resolver: { lookup },
        fetch: async () => {
          calls++;
          return success("sendgrid");
        },
      }),
    )("warning", "email");
    assert.deepEqual(await adapter.send(request("warning", "email"), signal), {
      kind: "transient",
      reason: "trusted notification contacts unavailable",
    });
    assert.equal(calls, 0);
  }
});

test("late contact lookup cannot start a send after deadline and pre-cancelled calls never lookup", async () => {
  let resolve:
    | ((value: { email: string; sms: string; version: string }) => void)
    | undefined;
  let calls = 0;
  const adapter = createProviderSelector(
    { ...config, timeoutMs: 10 },
    dependencies({
      resolver: {
        lookup: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
      fetch: async () => {
        calls++;
        return success("sendgrid");
      },
    }),
  )("warning", "email");
  assert.deepEqual(await adapter.send(request("warning", "email"), signal), {
    kind: "transient",
    reason: "trusted notification contacts unavailable",
  });
  resolve!({ email, sms, version: "1" });
  await new Promise((done) => setImmediate(done));
  assert.equal(calls, 0);
  const cancelled = createProviderSelector(
    config,
    dependencies({
      resolver: {
        lookup: async () => {
          calls++;
          return { email, sms, version: "1" };
        },
      },
    }),
  )("warning", "email");
  assert.deepEqual(
    await cancelled.send(
      request("warning", "email"),
      AbortSignal.abort(new Error(email)),
    ),
    {
      kind: "transient",
      reason: "trusted notification contacts unavailable",
    },
  );
  assert.equal(calls, 0);
});

test("safe templates reject injection and invalid fields without echoing arbitrary data", async () => {
  const good = request("warning", "email");
  assert.deepEqual(plainTextTemplate(good.task), {
    subject: "GreenGuard warning alert",
    body: `GreenGuard warning alert\nAlert: ${good.task.alert_id}\nTransition: alert.opened\nVersion: 1\nOpen your GreenGuard dashboard to review this alert.`,
  });
  for (const fields of [
    { severity: "critical\r\nBcc: attacker@example.test" },
    { severity: "<script>x</script>" },
    { transition: "x\nrecipient" },
    { transition: "a".repeat(1000) },
    { alert_id: email },
    { transition_version: -1 },
    { transition_version: 1.5 },
    { delivery_generation: -1 },
    { tenant_id: "invalid" },
    { channel: "push" as const },
  ]) {
    const req = { ...good, task: { ...good.task, ...fields } };
    assert.throws(
      () => plainTextTemplate(req.task),
      /invalid notification template fields/,
    );
    const adapter = createProviderSelector(
      config,
      dependencies({
        resolver: {
          lookup: async () => assert.fail("invalid fields must not lookup"),
        },
      }),
    )("warning", "email");
    assert.deepEqual(await adapter.send(req, signal), {
      kind: "rejected",
      reason: "invalid notification task",
    });
  }
});

test("critical tasks, channel mismatch and unstable intent ID reject before lookup", async () => {
  const selector = createProviderSelector(
    config,
    dependencies({
      resolver: { lookup: async () => assert.fail("must not lookup") },
    }),
  );
  const good = request("warning", "email");
  for (const [adapter, req] of [
    [
      selector("warning", "email"),
      { ...good, idempotencyKey: makeTask().intent_id },
    ],
    [selector("warning", "email"), request("critical", "email")],
    [selector("warning", "sms"), good],
  ] as const)
    assert.deepEqual(await adapter.send(req, signal), {
      kind: "rejected",
      reason: "invalid notification task",
    });
});

test("malformed/unexpected acceptance responses remain unknown", async () => {
  for (const response of [
    new Response(null, { status: 200 }),
    new Response(null, { status: 201 }),
    new Response(null, { status: 204 }),
  ]) {
    const adapter = createProviderSelector(
      config,
      dependencies({ fetch: async () => response }),
    )("warning", "email");
    await assert.rejects(
      adapter.send(request("warning", "email"), signal),
      UnknownProviderOutcomeError,
    );
  }
  for (const value of [
    null,
    {},
    { sid, status: "unknown" },
    { sid: email, status: "queued" },
  ]) {
    const adapter = createProviderSelector(
      config,
      dependencies({
        fetch: async () => Response.json(value, { status: 201 }),
      }),
    )("warning", "sms");
    await assert.rejects(
      adapter.send(request("warning", "sms"), signal),
      UnknownProviderOutcomeError,
    );
  }
  const invalidJson = createProviderSelector(
    config,
    dependencies({
      fetch: async () => new Response("not-json", { status: 201 }),
    }),
  )("warning", "sms");
  await assert.rejects(
    invalidJson.send(request("warning", "sms"), signal),
    UnknownProviderOutcomeError,
  );
});

test("SendGrid 202 acceptance survives missing header and unsafe references never enter ledger", async () => {
  for (const header of [undefined, email, "sendgrid-tracking-ref"]) {
    const adapter = createProviderSelector(
      config,
      dependencies({
        fetch: async () =>
          new Response(null, {
            status: 202,
            headers: header ? { "x-message-id": header } : undefined,
          }),
      }),
    )("warning", "email");
    const req = request("warning", "email");
    assert.deepEqual(await adapter.send(req, signal), {
      kind: "sent",
      providerRef:
        header === "sendgrid-tracking-ref"
          ? header
          : `sendgrid-accepted:${req.task.intent_id}`,
    });
  }
});

test("Twilio accepted statuses confirm send, failed statuses reject and unreadable response is unknown", async () => {
  for (const status of ["accepted", "queued", "sending", "sent", "delivered"]) {
    const adapter = createProviderSelector(
      config,
      dependencies({
        fetch: async () => Response.json({ sid, status }, { status: 201 }),
      }),
    )("warning", "sms");
    assert.deepEqual(await adapter.send(request("warning", "sms"), signal), {
      kind: "sent",
      providerRef: sid,
    });
  }
  for (const status of ["failed", "undelivered", "canceled"]) {
    const adapter = createProviderSelector(
      config,
      dependencies({
        fetch: async () =>
          Response.json({ sid, status, error_message: email }, { status: 201 }),
      }),
    )("warning", "sms");
    assert.deepEqual(await adapter.send(request("warning", "sms"), signal), {
      kind: "rejected",
      reason: "twilio message rejected",
    });
  }
  const unreadable = createProviderSelector(
    config,
    dependencies({
      fetch: async () =>
        ({
          status: 201,
          json: async () => {
            throw new Error(email);
          },
        }) as unknown as Response,
    }),
  )("warning", "sms");
  await assert.rejects(
    unreadable.send(request("warning", "sms"), signal),
    UnknownProviderOutcomeError,
  );
});

test("no provider/lookup errors log recipients, bodies, credentials or raw responses", async (t) => {
  const output: unknown[][] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const)
    t.mock.method(console, method, (...args: unknown[]) => {
      output.push(args);
    });
  for (const { provider, severity, channel } of routes) {
    const adapter = createProviderSelector(
      config,
      dependencies({
        fetch: async () => {
          throw new Error(`${email} response-PII sendgrid-secret`);
        },
      }),
    )(severity, channel);
    await assert.rejects(adapter.send(request(severity, channel), signal), {
      message: `${provider} acceptance is unknown`,
    });
  }
  const resolver = new HttpContactResolver(
    config.controlPlane!,
    100,
    async () => {
      throw new Error(email);
    },
  );
  await assert.rejects(
    resolver.lookup(makeTask().tenant_id),
    ContactLookupError,
  );
  assert.deepEqual(output, []);
});

test("missing provider configuration cannot send or fallback", async () => {
  for (const { severity, channel, provider } of routes) {
    let calls = 0;
    const adapter = createProviderSelector(
      { timeoutMs: 100 },
      dependencies({
        fetch: async () => {
          calls++;
          return success(provider);
        },
      }),
    )(severity, channel);
    assert.deepEqual(await adapter.send(request(severity, channel), signal), {
      kind: "transient",
      reason: `${provider} provider not configured`,
    });
    assert.equal(calls, 0);
  }
});

test("live config requires provider secrets and authenticated API; no SES/SNS Node config exists", () => {
  const env: Record<string, string | undefined> = {
    NOTIFICATIONS_DATABASE_URL: "postgres://local",
    RABBITMQ_URL: "amqp://local",
  };
  assert.equal(loadConfig((key) => env[key]).provider, "local");
  assert.equal(
    loadConfig((key) => env[key]).notificationProviders.timeoutMs,
    5000,
  );
  env.NOTIFICATIONS_PROVIDER = "live";
  assert.throws(
    () => loadConfig((key) => env[key]),
    /live notification providers require/,
  );
  Object.assign(env, {
    CONTROL_PLANE_URL: config.controlPlane!.url,
    CONTROL_LOOKUP_TOKEN: config.controlPlane!.token,
    SENDGRID_API_KEY: config.sendgrid!.apiKey,
    SENDGRID_FROM_EMAIL: config.sendgrid!.fromEmail,
    TWILIO_ACCOUNT_SID: config.twilio!.accountSid,
    TWILIO_AUTH_TOKEN: config.twilio!.authToken,
    TWILIO_FROM_NUMBER: config.twilio!.fromNumber,
    NOTIFICATIONS_PROVIDER_TIMEOUT_MS: "100",
  });
  const live = loadConfig((key) => env[key]);
  assert.equal(live.provider, "live");
  assert.deepEqual(live.notificationProviders, config);
  env.NOTIFICATIONS_PROVIDER_TIMEOUT_MS = "120001";
  assert.throws(() => loadConfig((key) => env[key]), /must not exceed 120000/);
  for (const timeoutMs of [0, -1, 1.5, NaN, 120001])
    assert.throws(
      () => createProviderSelector({ ...config, timeoutMs }, dependencies()),
      /notification request timeout/,
    );
  assert.throws(
    () => createProviderSelector({ timeoutMs: 100 }),
    /trusted notification contact resolver is required/,
  );
});

test("live loadConfig rejects plaintext contact URL even with local opt-in; HTTPS passes", () => {
  const env: Record<string, string | undefined> = {
    NOTIFICATIONS_DATABASE_URL: "postgres://local",
    RABBITMQ_URL: "amqp://local",
    NOTIFICATIONS_PROVIDER: "live",
    CONTROL_PLANE_URL: "http://control-plane.internal:8095",
    CONTROL_LOOKUP_TOKEN: "lookup-secret",
    SENDGRID_API_KEY: "sendgrid-secret",
    SENDGRID_FROM_EMAIL: "alerts@example.test",
    TWILIO_ACCOUNT_SID: config.twilio!.accountSid,
    TWILIO_AUTH_TOKEN: "twilio-secret",
    TWILIO_FROM_NUMBER: config.twilio!.fromNumber,
  };
  assert.throws(
    () => loadConfig((key) => env[key]),
    /CONTROL_PLANE_URL must use HTTPS/,
  );
  env.NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP = "true";
  assert.throws(
    () => loadConfig((key) => env[key]),
    /CONTROL_PLANE_URL must use HTTPS/,
  );
  for (const url of ["invalid", "file:///etc/passwd"]) {
    env.CONTROL_PLANE_URL = url;
    assert.throws(
      () => loadConfig((key) => env[key]),
      /CONTROL_PLANE_URL must use HTTPS/,
    );
  }
  env.CONTROL_PLANE_URL = "https://control-plane.internal:8095";
  assert.deepEqual(
    loadConfig((key) => env[key]).notificationProviders.controlPlane,
    {
      url: env.CONTROL_PLANE_URL,
      token: "lookup-secret",
    },
  );
  env.NOTIFICATIONS_PROVIDER = "local";
  env.CONTROL_PLANE_URL = "http://127.0.0.1:8095";
  assert.equal(
    loadConfig((key) => env[key]).notificationProviders.controlPlane!
      .allowInsecureHttp,
    true,
  );
  delete env.NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP;
  assert.equal(
    loadConfig((key) => env[key]).notificationProviders.controlPlane!
      .allowInsecureHttp,
    undefined,
  );
  env.NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP = "yes";
  assert.throws(() => loadConfig((key) => env[key]), /must be true or false/);
});

test("contact resolver requires TLS unless explicitly enabled for local/test HTTP", async () => {
  const local = { url: "http://127.0.0.1:8095", token: "local-only" };
  assert.throws(
    () => new HttpContactResolver(local),
    /invalid notification contact lookup configuration/,
  );
  assert.throws(
    () => createProviderSelector({ ...config, controlPlane: local }),
    /invalid notification contact lookup configuration/,
  );
  const resolver = new HttpContactResolver(
    { ...local, allowInsecureHttp: true },
    100,
    async () => Response.json({ email, sms, version: "1" }),
  );
  assert.deepEqual(await resolver.lookup(makeTask().tenant_id), {
    email,
    sms,
    version: "1",
  });
});

test("503 and resolver timeout map to worker retry and recover with the same intent", async () => {
  for (const failure of ["503", "timeout"] as const) {
    let reads = 0;
    let sends = 0;
    const req = request("warning", "email");
    const adapter = createProviderSelector(
      { ...config, timeoutMs: 40 },
      {
        fetch: async (url) => {
          if (String(url).startsWith(config.controlPlane!.url)) {
            reads++;
            if (reads === 1)
              return failure === "503"
                ? new Response(email, { status: 503 })
                : new Promise<never>(() => {});
            return Response.json({ email, sms, version: "1" });
          }
          sends++;
          return success("sendgrid");
        },
      },
    )("warning", "email");
    const { deps } = makeDeps({} as Parameters<typeof makeDeps>[0]);
    deps.adapter = () => adapter;
    deps.policy = { ...deps.policy, providerTimeoutMs: 40 };
    assert.deepEqual(await attemptSend(deps, req.task, 1), {
      status: "retry",
      kind: "send",
      error: "trusted notification contacts unavailable",
    });
    assert.equal(sends, 0);
    assert.equal((await attemptSend(deps, req.task, 2)).status, "sent");
    assert.equal(sends, 1);
    assert.equal(reads, 2);
  }
});

test("provider network failure and provider timeout remain worker unknown after dispatch", async () => {
  for (const failure of ["network", "timeout"] as const) {
    let sends = 0;
    const adapter = createProviderSelector(
      { ...config, timeoutMs: 40 },
      dependencies({
        fetch: async () => {
          sends++;
          if (failure === "network")
            throw new Error(`${email} sendgrid-secret`);
          return new Promise<never>(() => {});
        },
      }),
    )("warning", "email");
    const { deps } = makeDeps({} as Parameters<typeof makeDeps>[0]);
    deps.adapter = () => adapter;
    deps.policy = { ...deps.policy, providerTimeoutMs: 40 };
    const req = request("warning", "email");
    const result = await attemptSend(deps, req.task, 1);
    assert.equal(result.status, "unknown");
    assert.ok(!result.error?.includes(email));
    assert.equal(sends, 1);
    assert.deepEqual(await adapter.reconcile(req.task.intent_id, signal), {
      kind: "unknown",
      reason: "sendgrid cannot prove non-delivery by intent ID",
    });
    assert.equal(sends, 1);
  }
});

test("provider selector fails closed for critical and malformed severity values", () => {
  const select = createProviderSelector(config, dependencies());
  for (const severity of [
    "critical",
    "Critical",
    "critical ",
    "WARNING",
    "warning ",
    "unknown",
    "",
  ]) {
    assert.throws(
      () => select(severity, "email"),
      /only warning notifications/,
    );
    assert.throws(() => select(severity, "sms"), /only warning notifications/);
  }
});
