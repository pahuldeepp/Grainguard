// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("entry point mounts the app into #root", async () => {
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
  expect(root.querySelectorAll("output.service-status")).toHaveLength(2);
  vi.unstubAllGlobals();
});
