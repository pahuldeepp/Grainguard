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
