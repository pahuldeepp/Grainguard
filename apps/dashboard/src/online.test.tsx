// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useOnline } from "./online";

test("follows the browser online and offline events", () => {
  const { result } = renderHook(() => useOnline());
  expect(result.current).toBe(true);
  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });
  act(() => void window.dispatchEvent(new Event("offline")));
  expect(result.current).toBe(false);
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
  act(() => void window.dispatchEvent(new Event("online")));
  expect(result.current).toBe(true);
});
