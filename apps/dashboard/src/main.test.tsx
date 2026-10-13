// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("entry point mounts the app into #root", async () => {
  // Keep this rendering test independent of a developer's local OIDC config.
  for (const key of [
    "VITE_OIDC_AUTHORITY",
    "VITE_OIDC_CLIENT_ID",
    "VITE_OIDC_AUDIENCE",
    "VITE_OIDC_TOKEN_MODE",
    "VITE_OIDC_RESOURCE",
  ])
    vi.stubEnv(key, "");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline"))),
  );
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("./main");
  });
  const root = document.getElementById("root")!;
  expect(root.querySelector("h1")?.textContent).toContain("Overview");
  expect(root.querySelectorAll("output")).toHaveLength(2);
  vi.unstubAllGlobals();
});
