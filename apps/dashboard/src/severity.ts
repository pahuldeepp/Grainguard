export type MarkerKind =
  "critical" | "high" | "warning" | "notice" | "ok" | "offline" | "open";
export interface Marker {
  kind: MarkerKind;
  word: string;
}

const word = (value: string) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1) : value;

const severities: Record<string, Marker> = {
  critical: { kind: "critical", word: "Critical" },
  high: { kind: "high", word: "High" },
  warning: { kind: "warning", word: "Warning" },
  medium: { kind: "warning", word: "Warning" },
  notice: { kind: "notice", word: "Notice" },
  info: { kind: "notice", word: "Notice" },
  low: { kind: "notice", word: "Notice" },
};

export function severityMarker(severity: string): Marker {
  return (
    severities[severity.toLowerCase()] ?? { kind: "notice", word: severity }
  );
}

export function alertStateMarker(state: string): Marker {
  if (state === "acknowledged") return { kind: "ok", word: "Acknowledged" };
  if (state === "resolved") return { kind: "ok", word: "Resolved" };
  if (state === "open") return { kind: "open", word: "Open" };
  return { kind: "notice", word: word(state) };
}

const online = new Set(["active", "online", "ready"]);
const offline = new Set(["offline", "unreachable", "disconnected"]);

export function deviceStatusMarker(status: string): Marker {
  if (!status) return { kind: "notice", word: "Status unavailable" };
  if (online.has(status)) return { kind: "ok", word: word(status) };
  if (offline.has(status)) return { kind: "offline", word: word(status) };
  return { kind: "notice", word: word(status) };
}

const severityRank: Record<string, number> = {
  critical: 0,
  high: 1,
  warning: 2,
  medium: 2,
  notice: 3,
  info: 3,
  low: 3,
};

interface Sortable {
  alertId: string;
  severity: string;
  state: string;
  openedAt: string;
}

// Open alerts first, then most severe, then longest waiting.
export function sortAlerts<T extends Sortable>(items: readonly T[]): T[] {
  const rank = (a: T) => severityRank[a.severity.toLowerCase()] ?? 4;
  return [...items].sort(
    (a, b) =>
      Number(a.state !== "open") - Number(b.state !== "open") ||
      rank(a) - rank(b) ||
      Date.parse(a.openedAt) - Date.parse(b.openedAt) ||
      a.alertId.localeCompare(b.alertId),
  );
}

// The open alert that follows `currentId`, wrapping to the first; null if none other.
export function nextOpenAlert<T extends Sortable>(
  sorted: readonly T[],
  currentId: string,
): T | null {
  const open = sorted.filter((a) => a.state === "open");
  const index = open.findIndex((a) => a.alertId === currentId);
  const others = open.filter((a) => a.alertId !== currentId);
  if (others.length === 0) return null;
  return index < 0 ? others[0] : (open[index + 1] ?? others[0]);
}
