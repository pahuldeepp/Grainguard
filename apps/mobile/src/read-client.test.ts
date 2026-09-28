import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { MobileReadClient, mobileReadOperations } from "./read-client.js";
import { defaultCrypto } from "./pkce.js";
import type { ClearReason } from "./session.js";
import { IdentityChangedError } from "./session.js";

const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherTenant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const token = (
  sequence = "9",
  tenantId = tenant,
  placementEpoch = "1",
  shardIncarnation = "11111111-1111-4111-8111-111111111111",
) =>
  JSON.stringify({
    v: 1,
    tenantId,
    shardIncarnation,
    placementEpoch,
    sequence,
  });

function harness() {
  const grant = { tenantId: tenant, subject: "user", accessToken: "token" };
  let clear: (reason: ClearReason) => void = () => {};
  const bodies: { variables: Record<string, unknown> }[] = [];
  const queue: Response[] = [];
  let forcedTenant: string | undefined;
  const session = {
    onCleared(listener: (reason: ClearReason) => void) {
      clear = listener;
    },
    async getAccessToken(options?: { force?: boolean }) {
      if (options?.force && forcedTenant) grant.tenantId = forcedTenant;
      return { ...grant };
    },
  };
  const client = new MobileReadClient("https://bff.test/graphql", session, {
    crypto: defaultCrypto(),
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return (
        queue.shift() ??
        Response.json({
          data: {
            latestReading: { consistencyToken: token("9", grant.tenantId) },
            readingHistory: [],
            searchDevices: [],
          },
        })
      );
    },
  });
  return {
    client,
    bodies,
    queue,
    grant,
    clear: () => clear("sign-out"),
    forceTenant: (tenantId: string) => {
      forcedTenant = tenantId;
    },
  };
}

test("mobile read operations match persisted allowlist", () => {
  const source = readFileSync(
    resolve("../../services/bff/src/query-policy.ts"),
    "utf8",
  );
  for (const query of Object.values(mobileReadOperations))
    assert.ok(source.includes(query));
});

test("mobile preserves minima for refresh, leaves other store reads eventual, and resets tenant/session state", async () => {
  const h = harness();
  await h.client.current("d");
  await h.client.current("d");
  await h.client.history("d", "from", "to", 1);
  await h.client.search("grain");
  assert.deepEqual(
    h.bodies.map((body) => body.variables.minimumConsistency),
    [undefined, token(), undefined, undefined],
  );
  h.clear();
  await h.client.current("d");
  assert.equal(h.bodies[4].variables.minimumConsistency, undefined);
  h.grant.tenantId = otherTenant;
  await h.client.current("d");
  assert.equal(h.bodies[5].variables.minimumConsistency, undefined);
  await h.client.current("d");
  assert.equal(
    h.bodies[6].variables.minimumConsistency,
    token("9", otherTenant),
  );
});

test("mobile 401 retry preserves the minimum and rejects an identity switch before retry", async () => {
  const h = harness();
  await h.client.current("d");
  h.queue.push(new Response(null, { status: 401 }));
  await h.client.current("d");
  assert.equal(h.bodies[1].variables.minimumConsistency, token());
  assert.deepEqual(h.bodies[1], h.bodies[2]);
  h.queue.push(new Response(null, { status: 401 }));
  h.forceTenant(otherTenant);
  await assert.rejects(h.client.current("d"), IdentityChangedError);
  assert.equal(
    h.bodies.length,
    4,
    "changed identity must not receive the authored request",
  );
});

test("mobile rejects malformed or foreign minima without a request and never accepts a mismatched epoch", async () => {
  const h = harness();
  for (const minimum of ["bad-json", token("9", otherTenant)])
    await assert.rejects(h.client.current("d", minimum));
  assert.equal(h.bodies.length, 0);
  await h.client.current("d");
  h.queue.push(
    Response.json({
      data: { latestReading: { consistencyToken: token("10", tenant, "2") } },
    }),
  );
  await assert.rejects(h.client.current("d"), /consistency_identity_mismatch/);
});

test("mobile live watermark becomes the next refresh minimum and legacy messages retain it", async () => {
  const h = harness();
  await h.client.observeDeviceChange({ consistencyToken: token("12") });
  await h.client.observeDeviceChange({});
  h.queue.push(
    Response.json({
      data: { latestReading: { consistencyToken: token("12") } },
    }),
  );
  await h.client.current("d");
  assert.equal(h.bodies[0].variables.minimumConsistency, token("12"));
  await h.client.observeDeviceChange({
    consistencyToken: token("1", tenant, "2"),
  });
  await h.client.observeDeviceChange({
    consistencyToken: token("999", tenant, "1"),
  });
  h.queue.push(
    Response.json({
      data: { latestReading: { consistencyToken: token("1", tenant, "2") } },
    }),
  );
  await h.client.current("d");
  assert.equal(
    h.bodies.at(-1)!.variables.minimumConsistency,
    token("1", tenant, "2"),
  );
});

test("mobile cleared session prevents old in-flight response from restoring consistency state", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const client = new MobileReadClient(
    "https://bff.test/graphql",
    {
      getAccessToken: async () => ({
        tenantId: tenant,
        subject: "user",
        accessToken: "token",
      }),
    },
    {
      crypto: defaultCrypto(),
      fetch: async () => {
        fetchStarted();
        return pending;
      },
    },
  );
  const request = client.current("d");
  await started;
  client.clearConsistency();
  release(
    Response.json({ data: { latestReading: { consistencyToken: token() } } }),
  );
  await assert.rejects(request, IdentityChangedError);
});

const identityError = () =>
  Response.json({
    errors: [
      {
        message: "identity changed",
        extensions: { code: "consistency_identity_mismatch", httpStatus: 409 },
      },
    ],
  });
test("mobile foreground moves and same-epoch restores reset exactly once from admitted actual token", async () => {
  for (const fresh of [
    token("1", tenant, "2"),
    token("1", tenant, "1", "22222222-2222-4222-8222-222222222222"),
  ]) {
    const h = harness();
    await h.client.current("d");
    h.queue.push(
      identityError(),
      Response.json({ data: { latestReading: { consistencyToken: fresh } } }),
      Response.json({ data: { latestReading: { consistencyToken: fresh } } }),
    );
    await h.client.current("d");
    await h.client.current("d");
    assert.deepEqual(
      h.bodies.map((body) => body.variables.minimumConsistency),
      [undefined, token(), undefined, fresh],
    );
  }
});
test("mobile reset rejects unchanged, lower, foreign or missing actual identities and does not retry outages", async () => {
  for (const fresh of [
    token("1"),
    token("1", tenant, "0"),
    token("1", otherTenant, "2"),
    undefined,
  ]) {
    const h = harness();
    await h.client.current("d");
    h.queue.push(
      identityError(),
      Response.json({ data: { latestReading: { consistencyToken: fresh } } }),
    );
    await assert.rejects(h.client.current("d"));
    assert.equal(h.bodies.length, 3);
    h.queue.push(
      Response.json({
        errors: [
          {
            message: "down",
            extensions: { code: "read_freshness_unavailable", httpStatus: 503 },
          },
        ],
      }),
    );
    await assert.rejects(h.client.current("d"), /down/);
    assert.equal(h.bodies.length, 4);
    assert.equal(h.bodies[3].variables.minimumConsistency, token());
  }
});
test("mobile reset cannot loop and same-epoch hints require an authoritative snapshot", async () => {
  const h = harness();
  await h.client.current("d");
  h.queue.push(identityError(), identityError());
  await assert.rejects(h.client.current("d"), /identity changed/);
  assert.equal(h.bodies.length, 3);
  const restored = token(
    "1",
    tenant,
    "1",
    "22222222-2222-4222-8222-222222222222",
  );
  h.queue.push(
    identityError(),
    Response.json({ data: { latestReading: { consistencyToken: restored } } }),
  );
  await h.client.observeDeviceChange({ consistencyToken: restored });
  assert.equal(h.bodies.length, 5);
  h.queue.push(
    Response.json({ data: { latestReading: { consistencyToken: restored } } }),
  );
  await h.client.current("d");
  assert.equal(h.bodies.at(-1)!.variables.minimumConsistency, restored);
});

test("mobile rejects a valid lower-epoch reset and retains the old minimum", async () => {
  const h = harness();
  const old = token("90", tenant, "3");
  h.queue.push(
    Response.json({ data: { latestReading: { consistencyToken: old } } }),
  );
  await h.client.current("d");
  h.queue.push(
    identityError(),
    Response.json({
      data: { latestReading: { consistencyToken: token("1", tenant, "2") } },
    }),
  );
  await assert.rejects(h.client.current("d"), /consistency_identity_mismatch/);
  h.queue.push(
    Response.json({ data: { latestReading: { consistencyToken: old } } }),
  );
  await h.client.current("d");
  assert.equal(h.bodies.at(-1)!.variables.minimumConsistency, old);
});

test("empty foreground snapshot resets from the tenant-bound GraphQL response certificate", async () => {
  const h = harness();
  const actual = token(
    "1",
    tenant,
    "2",
    "22222222-2222-4222-8222-222222222222",
  );
  h.queue.push(
    Response.json({
      data: { device: null, latestReading: null },
      extensions: { consistencyToken: token() },
    }),
  );
  await h.client.current("d");
  h.queue.push(
    Response.json({
      errors: [
        {
          message: "consistency_identity_mismatch",
          extensions: {
            code: "consistency_identity_mismatch",
            httpStatus: 409,
          },
        },
      ],
    }),
  );
  h.queue.push(
    Response.json({
      data: { device: null, latestReading: null },
      extensions: { consistencyToken: actual },
    }),
  );
  assert.deepEqual(await h.client.current("d"), {
    device: null,
    latestReading: null,
  });
  h.queue.push(
    Response.json({
      data: { device: null, latestReading: null },
      extensions: { consistencyToken: actual },
    }),
  );
  await h.client.current("d");
  assert.deepEqual(
    h.bodies.map((b) => b.variables.minimumConsistency),
    [undefined, token(), undefined, actual],
  );
});

test("a live hint from a prior tenant or subject clears context and cannot update the new session", async () => {
  for (const change of ["tenant", "subject"]) {
    const h = harness();
    await h.client.current("d");
    if (change === "tenant") h.grant.tenantId = otherTenant;
    else h.grant.subject = "another-user";
    await assert.rejects(
      h.client.observeDeviceChange({
        consistencyToken: token(
          "1",
          change === "tenant" ? otherTenant : tenant,
          "2",
        ),
      }),
      IdentityChangedError,
    );
    await h.client.current("d");
    assert.equal(h.bodies[1].variables.minimumConsistency, undefined);
  }
});

test("foreground reset and mobile401retry share the original operation deadline", async () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    for (const failure of ["reset", "401"]) {
      const grant = {
        tenantId: tenant,
        subject: "user",
        accessToken: "access",
      };
      let calls = 0;
      const client = new MobileReadClient(
        "https://bff.test/graphql",
        { getAccessToken: async () => grant },
        {
          crypto: defaultCrypto(),
          timeoutMs: 10,
          fetch: async () => {
            calls++;
            if (calls === 1)
              return Response.json({
                data: { latestReading: { consistencyToken: token() } },
              });
            now += 11;
            if (failure === "401") return new Response(null, { status: 401 });
            return Response.json({
              errors: [
                {
                  message: "identity",
                  extensions: {
                    code: "consistency_identity_mismatch",
                    httpStatus: 409,
                  },
                },
              ],
            });
          },
        },
      );
      await client.current("d");
      await assert.rejects(client.current("d"));
      assert.equal(calls, 2, "expired budget must prevent fresh HTTP request");
    }
  } finally {
    Date.now = originalNow;
  }
});

test("an older response certificate does not hide higher or conflicting nested tokens", async () => {
  const h = harness();
  await h.client.current("d");
  h.queue.push(
    Response.json({
      data: { latestReading: { consistencyToken: token("12") } },
      extensions: { consistencyToken: token("8") },
    }),
  );
  await h.client.current("d");
  h.queue.push(
    Response.json({
      data: { latestReading: { consistencyToken: token("13") } },
    }),
  );
  await h.client.current("d");
  assert.equal(h.bodies[2].variables.minimumConsistency, token("12"));
  h.queue.push(
    Response.json({
      data: { latestReading: { consistencyToken: token("1", tenant, "2") } },
      extensions: { consistencyToken: token("8") },
    }),
  );
  await assert.rejects(h.client.current("d"), /consistency_identity_mismatch/);
});

test("reset certifies the oldest snapshot then preserves the highest observed next-read floor", async () => {
  const h = harness();
  await h.client.current("d");
  const newer = (sequence: string) =>
    token(sequence, tenant, "2", "22222222-2222-4222-8222-222222222222");
  h.queue.push(
    Response.json({
      errors: [
        {
          message: "identity",
          extensions: {
            code: "consistency_identity_mismatch",
            httpStatus: 409,
          },
        },
      ],
    }),
  );
  h.queue.push(
    Response.json({
      data: {
        device: { consistencyToken: newer("2") },
        latestReading: { consistencyToken: newer("5") },
      },
      extensions: { consistencyToken: newer("2") },
    }),
  );
  await h.client.current("d");
  h.queue.push(
    Response.json({
      data: { latestReading: { consistencyToken: newer("5") } },
      extensions: { consistencyToken: newer("5") },
    }),
  );
  await h.client.current("d");
  assert.equal(h.bodies[3].variables.minimumConsistency, newer("5"));
});

test("reset cannot use a newer nested snapshot to hide a snapshot below concurrent new-identity demand", async () => {
  const grant = { tenantId: tenant, subject: "user", accessToken: "access" };
  const newer = (sequence: string) =>
    token(sequence, tenant, "2", "22222222-2222-4222-8222-222222222222");
  let calls = 0,
    started!: () => void,
    release!: (response: Response) => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fresh = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const minima: Array<unknown> = [];
  const client = new MobileReadClient(
    "https://bff.test/graphql",
    { getAccessToken: async () => grant },
    {
      crypto: defaultCrypto(),
      fetch: async (_url, init) => {
        minima.push(
          JSON.parse(String(init?.body)).variables.minimumConsistency,
        );
        calls++;
        if (calls === 2)
          return Response.json({
            errors: [
              {
                message: "identity",
                extensions: {
                  code: "consistency_identity_mismatch",
                  httpStatus: 409,
                },
              },
            ],
          });
        if (calls === 3) {
          started();
          return fresh;
        }
        return Response.json({
          data: {
            latestReading: {
              consistencyToken: calls === 1 ? token() : newer("15"),
            },
          },
        });
      },
    },
  );
  await client.current("d");
  const reset = client.current("d");
  await ready;
  await client.observeDeviceChange({ consistencyToken: newer("15") });
  release(
    Response.json({
      data: {
        device: { consistencyToken: newer("10") },
        latestReading: { consistencyToken: newer("20") },
      },
      extensions: { consistencyToken: newer("10") },
    }),
  );
  await assert.rejects(reset, /consistency_minimum_unsatisfied/);
  await client.current("d");
  assert.equal(minima[3], newer("15"));
});

test("a cleared session cannot start a recovery request after an old409", async () => {
  const grant = { tenantId: tenant, subject: "user", accessToken: "access" };
  let calls = 0;
  const client = new MobileReadClient(
    "https://bff.test/graphql",
    { getAccessToken: async () => grant },
    {
      crypto: defaultCrypto(),
      fetch: async () => {
        calls++;
        if (calls === 2) {
          client.clearConsistency();
          return Response.json({
            errors: [
              {
                message: "identity",
                extensions: {
                  code: "consistency_identity_mismatch",
                  httpStatus: 409,
                },
              },
            ],
          });
        }
        return Response.json({
          data: { latestReading: { consistencyToken: token() } },
        });
      },
    },
  );
  await client.current("d");
  await assert.rejects(client.current("d"), IdentityChangedError);
  assert.equal(calls, 2);
});
