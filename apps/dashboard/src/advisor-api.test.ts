import { afterEach, expect, test, vi } from "vitest";
import {
  AdvisorApi,
  AdvisorRequestError,
  type AdvisorProposal,
} from "./advisor-api";
afterEach(() => {
  vi.unstubAllGlobals();
});
const approved: AdvisorProposal = {
  proposal_id: "12345678-abcd-4000-8000-000000000001",
  action_hash: "a".repeat(64),
  status: "approved",
  version: 2,
  expires_at: "2020-01-01T00:00:00Z",
  execution_status: "retryable",
  execution_attempts: 1,
  execution_receipt: null,
  action: {
    action: "acknowledge_alert",
    target: "12345678-abcd-4000-8000-000000000002",
    params: { note: "Reviewed" },
    preconditions: { etag: '"1"' },
  },
};
test("status and execution use fresh access tokens and only the existing exact version/hash contract", async () => {
  const tokens = vi
    .fn()
    .mockResolvedValueOnce("fresh-read-token")
    .mockResolvedValueOnce("fresh-mutation-token");
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(approved))
    .mockResolvedValueOnce(
      Response.json({
        execution_status: "succeeded",
        execution_receipt: { status: 200 },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const api = new AdvisorApi(tokens);
  const current = await api.get(approved.proposal_id);
  await api.execute(current);
  expect(tokens).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toBe(
    `/v1/advisor/proposals/${approved.proposal_id}`,
  );
  expect(fetcher.mock.calls[1][0]).toBe(
    `/v1/advisor/proposals/${approved.proposal_id}/execution`,
  );
  const read = fetcher.mock.calls[0][1];
  const post = fetcher.mock.calls[1][1];
  expect(read.headers.Authorization).toBe("Bearer fresh-read-token");
  expect(post.headers.Authorization).toBe("Bearer fresh-mutation-token");
  expect(read.cache).toBe("no-store");
  expect(post.cache).toBe("no-store");
  expect(post.headers["If-Match"]).toBe('"2"');
  expect(post.headers["Idempotency-Key"]).toBeUndefined();
  expect(JSON.parse(post.body)).toEqual({
    action_hash: approved.action_hash,
    version: 2,
  });
});
test("an expired undecided proposal cannot create a new approval", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new AdvisorApi(async () => "token").decide(
      { ...approved, status: "pending", version: 1 },
      "approved",
    ),
  ).rejects.toThrow("unexpired");
  expect(fetcher).not.toHaveBeenCalled();
});
test("terminal, exhausted, missing-attempt and malformed proposals cannot issue an execution request", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const api = new AdvisorApi(async () => "token");
  for (const bad of [
    { ...approved, status: "pending" as const },
    { ...approved, status: "rejected" as const },
    { ...approved, execution_status: "succeeded" as const },
    { ...approved, execution_status: "failed" as const },
    { ...approved, execution_attempts: 8 },
    { ...approved, execution_attempts: undefined },
    { ...approved, execution_attempts: -1 },
    { ...approved, action_hash: "not-a-hash" },
    { ...approved, version: 1 },
  ])
    await expect(api.execute(bad)).rejects.toThrow("cannot be retried");
  expect(fetcher).not.toHaveBeenCalled();
});
test("malformed or substituted status responses fail closed", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        ...approved,
        proposal_id: "12345678-abcd-4000-8000-000000000003",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ ...approved, expires_at: "not-a-date" }),
    );
  vi.stubGlobal("fetch", fetcher);
  const api = new AdvisorApi(async () => "token");
  await expect(api.get(approved.proposal_id)).rejects.toThrow(
    "different proposal",
  );
  await expect(api.get(approved.proposal_id)).rejects.toThrow(
    "invalid proposal",
  );
});
test("decision sends a new human idempotency key, not arbitrary action fields", async () => {
  const pending = {
    ...approved,
    status: "pending" as const,
    version: 1,
    expires_at: new Date(Date.now() + 600000).toISOString(),
  };
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      proposal_id: approved.proposal_id,
      action_hash: approved.action_hash,
      version: 2,
      status: "approved",
      execution_status: "pending",
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  await new AdvisorApi(async () => "token").decide(pending, "approved");
  const req = fetcher.mock.calls[0][1];
  expect(req.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(req.headers["If-Match"]).toBe('"1"');
  expect(JSON.parse(req.body)).toEqual({
    decision: "approved",
    action_hash: approved.action_hash,
    version: 1,
  });
});
test("a session abort before token retrieval finishes prevents dispatch", async () => {
  let resolve!: (token: string) => void;
  const tokens = vi.fn().mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const request = new AdvisorApi(tokens).execute(approved, controller.signal);
  controller.abort();
  resolve("late-old-session-token");
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});
test("server throttling carries a bounded retry hint without echoing backend details", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: "private_backend_detail" },
          { status: 429, headers: { "Retry-After": "12" } },
        ),
      ),
  );
  const api = new AdvisorApi(async () => "token");
  await expect(api.execute(approved)).rejects.toMatchObject({
    status: 429,
    retryAfter: 12,
    message: "Action requests are temporarily rate limited.",
  });
  expect(new AdvisorRequestError(403, 1).message).not.toContain(
    "private_backend_detail",
  );
});

test.each([
  [401, "Your session expired. Sign in again to review this action."],
  [403, "You no longer have permission to review this action."],
  [404, "This proposal is no longer available in your account."],
  [409, "This proposal changed. Refresh its status before continuing."],
  [410, "This proposal has expired."],
  [429, "Action requests are temporarily rate limited."],
  [
    503,
    "Advisor is temporarily unavailable. Refresh the action status before retrying.",
  ],
])(
  "preserves safe Advisor failure guidance for HTTP %s",
  async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ code: "PRIVATE DETAIL" }, { status }),
        ),
    );
    await expect(
      new AdvisorApi(async () => "token").get(approved.proposal_id),
    ).rejects.toMatchObject({
      status,
      retryAfter: 1,
      message,
    });
  },
);
