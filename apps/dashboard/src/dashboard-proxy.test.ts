import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const config = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8");
test("authenticated RAG operations preserve the request URI through the BFF", () => {
  expect(config).toMatch(
    /location \^~ \/v1\/rag\/ \{\s*proxy_pass http:\/\/gateway:4002;/,
  );
});
test("assistant reverse proxy exceeds the bounded complete-summary client deadline", () => {
  const assistant =
    config.match(/location \^~ \/v1\/assistant\/ \{([^}]+)\}/)?.[1] ?? "";
  expect(assistant).toContain("proxy_pass http://gateway:4002;");
  expect(
    Number(assistant.match(/proxy_read_timeout (\d+)s;/)?.[1]),
  ).toBeGreaterThan(320);
});
