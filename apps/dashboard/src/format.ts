// Presentation helpers only: the API values stay ISO strings in `dateTime`.
export function formatTimestamp(
  iso: string,
  locale?: string,
  timeZone?: string,
): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone,
  }).format(time);
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const elapsed = now - time;
  if (elapsed < 60_000) return "just now";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  for (const [unit, size] of units) {
    if (elapsed >= size)
      return formatter.format(-Math.floor(elapsed / size), unit);
  }
  return "just now";
}
