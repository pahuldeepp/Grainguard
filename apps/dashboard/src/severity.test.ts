import { expect, test } from "vitest";
import {
  alertStateMarker,
  deviceStatusMarker,
  severityMarker,
} from "./severity";

test("maps every severity to a fixed glyph and word", () => {
  expect(severityMarker("critical")).toEqual({
    kind: "critical",
    word: "Critical",
  });
  expect(severityMarker("High")).toEqual({ kind: "high", word: "High" });
  expect(severityMarker("warning")).toEqual({
    kind: "warning",
    word: "Warning",
  });
  expect(severityMarker("medium")).toEqual({
    kind: "warning",
    word: "Warning",
  });
  expect(severityMarker("notice")).toEqual({ kind: "notice", word: "Notice" });
});

test("unknown severities stay visible as a notice with their own word", () => {
  expect(severityMarker("sev-9")).toEqual({ kind: "notice", word: "sev-9" });
});

test("alert state and device status use shared markers", () => {
  expect(alertStateMarker("open")).toEqual({ kind: "notice", word: "Open" });
  expect(alertStateMarker("acknowledged")).toEqual({
    kind: "ok",
    word: "Acknowledged",
  });
  expect(alertStateMarker("resolved")).toEqual({
    kind: "ok",
    word: "Resolved",
  });
  expect(deviceStatusMarker("active")).toEqual({ kind: "ok", word: "Active" });
  expect(deviceStatusMarker("offline")).toEqual({
    kind: "offline",
    word: "Offline",
  });
  expect(deviceStatusMarker("")).toEqual({
    kind: "notice",
    word: "Status unavailable",
  });
});

import { nextOpenAlert, sortAlerts } from "./severity";

const alert = (
  id: string,
  severity: string,
  state: string,
  openedAt: string,
) => ({
  alertId: id,
  severity,
  state,
  openedAt,
});

test("sorts open alerts first, then by severity, then oldest first", () => {
  const sorted = sortAlerts([
    alert("ack", "critical", "acknowledged", "2026-09-25T08:00:00Z"),
    alert("warn-old", "warning", "open", "2026-09-25T07:00:00Z"),
    alert("crit-new", "critical", "open", "2026-09-25T09:00:00Z"),
    alert("crit-old", "critical", "open", "2026-09-25T06:00:00Z"),
    alert("odd", "sev-9", "open", "2026-09-25T05:00:00Z"),
  ]).map((a) => a.alertId);
  expect(sorted).toEqual(["crit-old", "crit-new", "warn-old", "odd", "ack"]);
});

test("picks the next open alert after the current one, skipping it", () => {
  const items = sortAlerts([
    alert("a", "critical", "open", "2026-09-25T06:00:00Z"),
    alert("b", "high", "open", "2026-09-25T06:00:00Z"),
    alert("c", "warning", "open", "2026-09-25T06:00:00Z"),
  ]);
  expect(nextOpenAlert(items, "a")?.alertId).toBe("b");
  expect(nextOpenAlert(items, "b")?.alertId).toBe("c");
  expect(nextOpenAlert(items, "c")?.alertId).toBe("a");
  expect(nextOpenAlert(items.slice(0, 1), "a")).toBeNull();
});
