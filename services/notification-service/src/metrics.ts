/** Process-wide counters with no tenant, device or intent labels. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private lagSeconds = 0;
  private heldAgeSeconds = 0;

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  observeLag(timestampSeconds: number | undefined, nowMs = Date.now()): void {
    if (timestampSeconds !== undefined)
      this.lagSeconds = Math.max(0, nowMs / 1000 - timestampSeconds);
  }

  /** Last observed held task's age; deliberately carries no tenant/task labels. */
  observeHeld(firstHeldMs: number, nowMs = Date.now()): void {
    this.heldAgeSeconds = Math.max(0, (nowMs - firstHeldMs) / 1000);
  }

  resetHeld(): void {
    this.heldAgeSeconds = 0;
  }

  render(gauges: Record<string, number> = {}): string {
    const lines = [...this.counters].map(
      ([k, v]) => `notifications_${k}_total ${v}`,
    );
    lines.push(
      `notifications_task_lag_seconds ${this.lagSeconds}`,
      `notifications_optional_held_age_seconds ${this.heldAgeSeconds}`,
    );
    for (const [k, v] of Object.entries(gauges))
      lines.push(`notifications_${k} ${v}`);
    return lines.toSorted((a, b) => a.localeCompare(b)).join("\n") + "\n";
  }
}
