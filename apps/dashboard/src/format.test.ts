import { expect, test } from "vitest";
import { formatTimestamp, relativeTime } from "./format";

test("formats an ISO instant for people and leaves unparseable input untouched", () => {
  const text = formatTimestamp("2026-09-20T12:00:00Z", "en-US", "UTC");
  expect(text).toBe("Sep 20, 2026, 12:00:00 PM");
  expect(formatTimestamp("not a time")).toBe("not a time");
});

test("describes elapsed time in the largest sensible unit", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  expect(relativeTime("2026-09-20T11:59:40Z", now)).toBe("just now");
  expect(relativeTime("2026-09-20T11:48:00Z", now)).toBe("12 minutes ago");
  expect(relativeTime("2026-09-20T09:00:00Z", now)).toBe("3 hours ago");
  expect(relativeTime("2026-09-18T12:00:00Z", now)).toBe("2 days ago");
  expect(relativeTime("2026-09-20T12:05:00Z", now)).toBe("just now");
  expect(relativeTime("bad", now)).toBe("");
});
