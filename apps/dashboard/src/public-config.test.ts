import { afterEach, expect, test, vi } from "vitest";
import {
  deployedOidcConfig,
  loadPublicOidcConfig,
  validatePublicOidcConfig,
} from "./public-config";

afterEach(() => vi.restoreAllMocks());

const valid = {
  authority: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
  clientId: "web-client",
  tokenMode: "cognito-access",
} as const;

test("loads a same-origin public config with no cache before auth starts", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => valid });
  await loadPublicOidcConfig(fetcher as unknown as typeof fetch);
  expect(fetcher).toHaveBeenCalledWith("/config.json", { cache: "no-store" });
  expect(deployedOidcConfig()).toEqual(valid);
});

test("rejects secret-looking fields, placeholders and incomplete modes", () => {
  for (const bad of [
    { ...valid, clientSecret: "secret" },
    { ...valid, authority: "http://localhost:5556" },
    { ...valid, authority: "https://id.example.com" },
    { ...valid, audience: "legacy" },
    { ...valid, resource: "http://api.example.test" },
    { ...valid, tokenMode: "audience" },
  ])
    expect(() => validatePublicOidcConfig(bad)).toThrow();
});

test("allows HTTP only for loopback OIDC in an explicit e2e build", () => {
  const local = {
    authority: "http://127.0.0.1:5556/dex",
    clientId: "greenguard-dashboard",
    audience: "greenguard-dashboard",
    tokenMode: "audience",
  } as const;

  expect(() => validatePublicOidcConfig(local)).toThrow();
  expect(validatePublicOidcConfig(local, { allowLoopbackHttp: true })).toEqual(
    local,
  );
  expect(() =>
    validatePublicOidcConfig(
      { ...local, authority: "http://idp.example.test" },
      { allowLoopbackHttp: true },
    ),
  ).toThrow();
});
