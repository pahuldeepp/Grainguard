import { afterEach, expect, test, vi } from "vitest";
import { operations } from "../../../services/bff/src/query-policy";
import { ReadApi, readOperations } from "./read-api";
import { operationHash } from "./graphql-client";

afterEach(() => vi.unstubAllGlobals());

test("dashboard read operations match the BFF persisted-query allowlist", () => {
  for (const [name, query] of Object.entries(readOperations))
    expect(query).toBe(operations[name as keyof typeof operations]);
});

test("bin latest and trend requests use the byte-identical BFF operations", async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({
          data: { binReadingsLatest: null, binReadingsTrend: { buckets: [] } },
        }),
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = new ReadApi(async () => "token");
  await api.binLatest("bin-a");
  await api.binTrend("bin-a", "H6");
  const bodies = fetchMock.mock.calls.map(([, init]) =>
    JSON.parse(init?.body as string),
  );
  expect(
    bodies.map((body) => body.extensions.persistedQuery.sha256Hash),
  ).toEqual(
    await Promise.all(
      [operations.binReadingsLatest, operations.binReadingsTrend].map(
        operationHash,
      ),
    ),
  );
  expect(bodies.map((body) => body.variables)).toEqual([
    { binId: "bin-a" },
    { binId: "bin-a", window: "H6", resolution: "AUTO" },
  ]);
});

test("read queries use the scoped GraphQL BFF with a fresh token and no tenant variable", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { searchDevices: [] } }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = new ReadApi(async () => "session-token");
  expect(await api.search("grain", 25)).toEqual([]);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("/graphql");
  expect(init.headers).toMatchObject({ Authorization: "Bearer session-token" });
  const body = JSON.parse(init.body as string);
  expect(body.variables).toEqual({ query: "grain", limit: 25 });
  expect(body.variables).not.toHaveProperty("tenantId");
  expect(body).not.toHaveProperty("query");
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(readOperations.deviceSearch),
  );
  expect(body.extensions.persistedQuery.sha256Hash).toBe(
    Array.from(new Uint8Array(bytes), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join(""),
  );
});

test("missing token prevents a network request", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    new ReadApi(async () => null).current("device-1"),
  ).rejects.toThrow("Sign in");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("GraphQL authorization failures surface without displaying another tenant's data", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [
              { message: "forbidden", extensions: { code: "FORBIDDEN" } },
            ],
          }),
          { status: 200 },
        ),
    ),
  );
  await expect(
    new ReadApi(async () => "token").history(
      "device-1",
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      100,
    ),
  ).rejects.toThrow("FORBIDDEN");
});

const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const token = (
  sequence = "9",
  placementEpoch = "1",
  shardIncarnation = "11111111-1111-4111-8111-111111111111",
) =>
  JSON.stringify({
    v: 1,
    tenantId: tenant,
    shardIncarnation,
    placementEpoch,
    sequence,
  });

test("observed minima survive refresh, avoid cross-store claims and clear with session context", async () => {
  const bodies: { variables: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        data: {
          latestReading: { readingId: "r", consistencyToken: token() },
          searchDevices: [],
          readingHistory: { items: [], nextCursor: null, sources: [] },
        },
      });
    }),
  );
  const api = new ReadApi(async () => "token");
  await api.current("d");
  await api.current("d");
  await api.search("grain");
  await api.history("d", "from", "to", 1);
  expect(bodies.map((body) => body.variables.minimumConsistency)).toEqual([
    undefined,
    token(),
    undefined,
    undefined,
  ]);
  const otherSession = new ReadApi(async () => "other-token");
  await otherSession.current("d");
  expect(bodies[4].variables.minimumConsistency).toBeUndefined();
  api.clearConsistency();
  await api.current("d");
  expect(bodies[5].variables.minimumConsistency).toBeUndefined();
});

test("history sends opaque cursors and returns page source metadata", async () => {
  const fetchMock = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      data: {
        readingHistory: {
          items: [],
          nextCursor: body.variables.after ? null : "opaque-cursor",
          sources: body.variables.after
            ? { postgres: false, cassandra: true }
            : { postgres: true, cassandra: true },
        },
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const api = new ReadApi(async () => "token");
  const first = await api.history("d1", "from", "to", 2);
  expect(first).toEqual({
    items: [],
    nextCursor: "opaque-cursor",
    sources: { postgres: true, cassandra: true },
  });
  await api.history("d1", "from", "to", 2, first.nextCursor!);
  expect(
    fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)).variables,
    ),
  ).toEqual([
    { id: "d1", from: "from", to: "to", limit: 2 },
    { id: "d1", from: "from", to: "to", limit: 2, after: "opaque-cursor" },
  ]);
});

test("out of order responses never lower the observed minimum and epoch changes surface controlled error", async () => {
  const responses = [token("10"), token("9"), token("11", "2")];
  const bodies: { variables: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        data: { latestReading: { consistencyToken: responses.shift() } },
      });
    }),
  );
  const api = new ReadApi(async () => "token");
  await api.current("d");
  await api.current("d");
  await expect(api.current("d")).rejects.toThrow(
    "consistency_identity_mismatch",
  );
  expect(
    bodies.slice(1).map((body) => body.variables.minimumConsistency),
  ).toEqual([token("10"), token("10")]);
});

test("live device watermark is retained before the refresh reads durable state", async () => {
  let socket: FakeSocket;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor() {
      capture(this);
    }
    send() {}
    close() {}
  }
  const capture = (value: FakeSocket) => {
    socket = value;
  };
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("window", {
    location: { href: "https://dashboard.test/devices" },
  });
  let readToken = token("12");
  const bodies: { variables: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (url === "/api/v1/subscription-ticket")
        return Response.json({ ticket: "ticket" });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        data: { latestReading: { consistencyToken: readToken } },
      });
    }),
  );
  const api = new ReadApi(async () => "token");
  const refresh = vi.fn();
  const close = api.subscribeDevice("d", refresh);
  await vi.waitFor(() => expect(socket).toBeDefined());
  socket!.onmessage?.({
    data: JSON.stringify({
      type: "next",
      payload: { data: { deviceChanged: { consistencyToken: token("12") } } },
    }),
  });
  expect(refresh).toHaveBeenCalledOnce();
  await api.current("d");
  expect(bodies[0].variables.minimumConsistency).toBe(token("12"));
  readToken = token("1", "2");
  socket!.onmessage?.({
    data: JSON.stringify({
      type: "next",
      payload: { data: { deviceChanged: { consistencyToken: readToken } } },
    }),
  });
  socket!.onmessage?.({
    data: JSON.stringify({
      type: "next",
      payload: {
        data: { deviceChanged: { consistencyToken: token("999", "1") } },
      },
    }),
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  await api.current("d");
  expect(bodies[1].variables.minimumConsistency).toBe(readToken);
  socket!.onmessage?.({
    data: JSON.stringify({
      type: "next",
      payload: { data: { deviceChanged: { consistencyToken: "bad-json" } } },
    }),
  });
  expect(refresh).toHaveBeenCalledTimes(3);
  await api.current("d");
  expect(bodies[2].variables.minimumConsistency).toBe(readToken);
  api.clearConsistency();
  socket!.onmessage?.({
    data: JSON.stringify({
      type: "next",
      payload: { data: { deviceChanged: { consistencyToken: token("13") } } },
    }),
  });
  expect(refresh).toHaveBeenCalledTimes(3);
  await api.current("d");
  expect(bodies[3].variables.minimumConsistency).toBeUndefined();
  close();
});

test("cleared client context rejects an old in-flight response before it restores a minimum", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => pending),
  );
  const api = new ReadApi(async () => "token");
  const request = api.current("d");
  api.clearConsistency();
  release(
    Response.json({ data: { latestReading: { consistencyToken: token() } } }),
  );
  await expect(request).rejects.toThrow("session_changed");
  const bodies: { variables: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ data: {} });
    }),
  );
  await api.current("d");
  expect(bodies[0].variables.minimumConsistency).toBeUndefined();
});

test("foreground identity error permits one authoritative reset for move or same-epoch restore", async () => {
  for (const fresh of [
    token("1", "2"),
    token("1", "1", "22222222-2222-4222-8222-222222222222"),
  ]) {
    const responses = [
      Response.json({
        data: { latestReading: { consistencyToken: token("90") } },
      }),
      Response.json({
        errors: [
          {
            message: "identity changed",
            extensions: {
              code: "consistency_identity_mismatch",
              httpStatus: 409,
            },
          },
        ],
      }),
      Response.json({ data: { latestReading: { consistencyToken: fresh } } }),
      Response.json({ data: { latestReading: { consistencyToken: fresh } } }),
    ];
    const bodies: { variables: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responses.shift()!;
      }),
    );
    const api = new ReadApi(async () => "token");
    await api.current("d");
    await api.current("d");
    await api.current("d");
    expect(bodies.map((body) => body.variables.minimumConsistency)).toEqual([
      undefined,
      token("90"),
      undefined,
      fresh,
    ]);
  }
});

test("authoritative reset rejects unchanged/lower/foreign identities and cannot loop or reset on outage", async () => {
  for (const fresh of [
    token("1"),
    token("1", "0"),
    JSON.stringify({
      ...JSON.parse(token("1", "2")),
      tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }),
    undefined,
  ]) {
    const bodies: { variables: Record<string, unknown> }[] = [];
    const responses = [
      Response.json({
        data: { latestReading: { consistencyToken: token("90") } },
      }),
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
      Response.json({ data: { latestReading: { consistencyToken: fresh } } }),
      Response.json({
        errors: [
          {
            message: "down",
            extensions: { code: "read_freshness_unavailable", httpStatus: 503 },
          },
        ],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responses.shift()!;
      }),
    );
    const api = new ReadApi(async () => "token");
    await api.current("d");
    await expect(api.current("d")).rejects.toThrow();
    expect(bodies).toHaveLength(3);
    await expect(api.current("d")).rejects.toThrow(
      "read_freshness_unavailable",
    );
    expect(bodies).toHaveLength(4);
    expect(bodies[3].variables.minimumConsistency).toBe(token("90"));
  }
});

test("fresh reset error propagates once and retains the old minimum", async () => {
  const bodies: { variables: Record<string, unknown> }[] = [];
  const failure = () =>
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
    });
  const responses = [
    Response.json({
      data: { latestReading: { consistencyToken: token("90") } },
    }),
    failure(),
    failure(),
    Response.json({
      data: { latestReading: { consistencyToken: token("90") } },
    }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    }),
  );
  const api = new ReadApi(async () => "token");
  await api.current("d");
  await expect(api.current("d")).rejects.toThrow(
    "consistency_identity_mismatch",
  );
  expect(bodies).toHaveLength(3);
  await api.current("d");
  expect(bodies[3].variables.minimumConsistency).toBe(token("90"));
});

test("a valid lower epoch cannot become an authoritative reset", async () => {
  const bodies: { variables: Record<string, unknown> }[] = [];
  const old = token("90", "3");
  const responses = [
    Response.json({ data: { latestReading: { consistencyToken: old } } }),
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
    Response.json({
      data: { latestReading: { consistencyToken: token("1", "2") } },
    }),
    Response.json({ data: { latestReading: { consistencyToken: old } } }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    }),
  );
  const api = new ReadApi(async () => "token");
  await api.current("d");
  await expect(api.current("d")).rejects.toThrow(
    "consistency_identity_mismatch",
  );
  await api.current("d");
  expect(bodies.at(-1)!.variables.minimumConsistency).toBe(old);
});

test("empty foreground snapshot resets from the tenant-bound GraphQL response certificate", async () => {
  const bodies: { variables: Record<string, unknown> }[] = [];
  const actual = token("1", "2", "22222222-2222-4222-8222-222222222222");
  let count = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      count++;
      if (count === 2)
        return Response.json({
          errors: [
            {
              message: "consistency_identity_mismatch",
              extensions: {
                code: "consistency_identity_mismatch",
                httpStatus: 409,
              },
            },
          ],
        });
      return Response.json({
        data: { device: null, latestReading: null },
        extensions: { consistencyToken: count === 1 ? token() : actual },
      });
    }),
  );
  const api = new ReadApi(async () => "session");
  await api.current("d");
  expect(await api.current("d")).toEqual({ device: null, latestReading: null });
  await api.current("d");
  expect(bodies.map((b) => b.variables.minimumConsistency)).toEqual([
    undefined,
    token(),
    undefined,
    actual,
  ]);
});

test("foreground identity reset consumes the original deadline and cannot start after expiry", async () => {
  let now = 1000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const bodies: { variables: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 2) {
        now += 8001;
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
    }),
  );
  try {
    const api = new ReadApi(async () => "session");
    await api.current("d");
    await expect(api.current("d")).rejects.toThrow("read_timeout");
    expect(bodies).toHaveLength(2);
    await api.current("d");
    expect(bodies[2].variables.minimumConsistency).toBe(token());
  } finally {
    clock.mockRestore();
  }
});

test("an older response certificate does not hide higher or conflicting nested tokens", async () => {
  const bodies: { variables: Record<string, unknown> }[] = [];
  const values = [
    { data: { latestReading: { consistencyToken: token("9") } } },
    {
      data: { latestReading: { consistencyToken: token("12") } },
      extensions: { consistencyToken: token("8") },
    },
    { data: { latestReading: { consistencyToken: token("13") } } },
    {
      data: { latestReading: { consistencyToken: token("1", "2") } },
      extensions: { consistencyToken: token("8") },
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(values.shift());
    }),
  );
  const api = new ReadApi(async () => "access");
  await api.current("d");
  await api.current("d");
  await api.current("d");
  expect(bodies[2].variables.minimumConsistency).toBe(token("12"));
  await expect(api.current("d")).rejects.toThrow(
    "consistency_identity_mismatch",
  );
});

test("a cleared session cannot start a recovery request after the old request returns409", async () => {
  let calls = 0;
  const api = new ReadApi(async () => "access");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls++;
      if (calls === 2) {
        api.clearConsistency();
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
    }),
  );
  await api.current("d");
  await expect(api.current("d")).rejects.toThrow("session_changed");
  expect(calls).toBe(2);
});

test("search cancellation reaches the GraphQL request without changing authorization", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal as AbortSignal;
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token",
    );
    return new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener(
        "abort",
        () => reject(requestSignal!.reason),
        { once: true },
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const api = new ReadApi(async () => "access-token");
  const request = api.search("s", 25, undefined, controller.signal);
  const rejection = expect(request).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  controller.abort();
  await rejection;
  expect(requestSignal?.aborted).toBe(true);
});

test("historical rollups omit automatic hot-store minima but preserve explicit requirements", async () => {
  const bodies: { variables: Record<string, unknown> }[] = [];
  const responses = [
    Response.json({
      data: {
        latestReading: { readingId: "r", consistencyToken: token("90") },
      },
    }),
    Response.json({ data: { readingRollups: [] } }),
    Response.json({
      errors: [
        {
          message: "unsupported",
          extensions: {
            code: "consistency_store_unsupported",
            httpStatus: 409,
          },
        },
      ],
    }),
    Response.json({
      data: {
        latestReading: { readingId: "r", consistencyToken: token("90") },
      },
    }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    }),
  );
  const api = new ReadApi(async () => "token");
  await api.current("d");
  await api.rollups("d", "2026-09-20T00:00:00Z", "2026-09-24T00:00:00Z", "day");
  expect(bodies[1].variables.minimumConsistency).toBeUndefined();
  await expect(
    api.rollups(
      "d",
      "2026-09-20T00:00:00Z",
      "2026-09-24T00:00:00Z",
      "day",
      token("90"),
    ),
  ).rejects.toThrow("consistency_store_unsupported");
  expect(bodies).toHaveLength(3);
  expect(bodies[2].variables.minimumConsistency).toBe(token("90"));
  await api.current("d");
  expect(bodies[3].variables.minimumConsistency).toBe(token("90"));
});
