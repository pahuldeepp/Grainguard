/** Returns a projected bin label, or a stable short identifier while projection is absent. */
export function binLabel(binId: string, projectedName?: string | null): string {
  const name = projectedName?.trim();
  if (name) return name;

  const numericSuffix = /(?:^|\D)(\d+)$/.exec(binId)?.[1];
  if (numericSuffix) return `Bin ${numericSuffix.slice(-4).padStart(4, "0")}`;

  // UUIDs have no human name yet; keep only a stable four-character suffix.
  const suffix = binId
    .replace(/[^a-z\d]/gi, "")
    .slice(-4)
    .toUpperCase();
  return `Bin ${suffix.padStart(4, "0")}`;
}
