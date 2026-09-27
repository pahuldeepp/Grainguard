import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { ProvisioningApi } from "./provisioning";

afterEach(() => vi.unstubAllGlobals());

test("does not send a request without an access token", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new ProvisioningApi(async () => null).status("s1"),
  ).rejects.toThrow("Sign in");
  expect(fetcher).not.toHaveBeenCalled();
});

test("sends GraphQL calls with the current token and no tenant argument", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: { startProvisioning: { sagaId: "s1" } } }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const api = new ProvisioningApi(async () => "fresh-token");
  expect((await api.start("device1", "asset1")).sagaId).toBe("s1");
  const [path, init] = fetcher.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(path).toBe("/graphql");
  expect((init.headers as Record<string, string>).Authorization).toBe(
    "Bearer fresh-token",
  );
  const body = JSON.parse(init.body as string);
  expect(body.variables).toMatchObject({
    deviceId: "device1",
    assetId: "asset1",
  });
  expect(body.variables).not.toHaveProperty("tenantId");
  expect(body.variables.idempotencyKey).toBeTruthy();
  expect(body.query).toBeUndefined();
  const expectedOperation = `mutation StartProvisioning($deviceId: ID!, $assetId: ID!, $idempotencyKey: String!) { startProvisioning(deviceId: $deviceId, assetId: $assetId, idempotencyKey: $idempotencyKey) { tenantId sagaId deviceId assetId state version fencingToken deadlineAt } }`;
  expect(body.extensions.persistedQuery).toEqual({
    version: 1,
    sha256Hash: createHash("sha256").update(expectedOperation).digest("hex"),
  });
});

test("surfaces GraphQL authorization failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: "denied", extensions: { code: "forbidden" } }],
          }),
          { status: 200 },
        ),
    ),
  );
  await expect(
    new ProvisioningApi(async () => "token").redrive("s1", "operator check"),
  ).rejects.toThrow("forbidden");
});

test("session uses the persisted Session operation", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: { session: { subject: "u", tenantId: "t", roles: ["viewer"] } },
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const session = await new ProvisioningApi(async () => "token").session();
  expect(session.roles).toEqual(["viewer"]);
  const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(init.body as string).extensions.persistedQuery).toEqual({
    version: 1,
    sha256Hash: createHash("sha256")
      .update(`query Session { session { subject tenantId roles } }`)
      .digest("hex"),
  });
});
