const durationUnitsMs: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

const minimumWindowMs = 60 * 60_000;
const maximumWindowMs = 2_160 * 60 * 60_000;

/** Parse Go-style durations used by projection maintenance (for example, 24h). */
export function readHistoryHotWindowMs(
  raw = process.env.READ_HISTORY_HOT_WINDOW,
): number {
  if (raw === undefined) return 24 * 60 * 60_000;
  const value = raw.trim();
  const part = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/y;
  let position = 0;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = part.exec(value)) !== null) {
    if (match.index !== position)
      throw new Error("invalid READ_HISTORY_HOT_WINDOW");
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || !unit)
      throw new Error("invalid READ_HISTORY_HOT_WINDOW");
    total += amount * durationUnitsMs[unit];
    position = part.lastIndex;
  }
  if (
    position !== value.length ||
    !Number.isFinite(total) ||
    total < minimumWindowMs ||
    total > maximumWindowMs
  )
    throw new Error("READ_HISTORY_HOT_WINDOW must be between 1h and 2160h");
  return total;
}
