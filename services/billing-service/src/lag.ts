// Tracks how far the reading consumer is behind the topic head, in milliseconds of event
// time. The usage-period close waits until the lag is small so readings received in a
// month are counted in it. Not caught up means the lag keeps growing until the next batch.
export class ConsumerLag {
  private behindSince: number | undefined;

  // The first behind observation starts the clock; subsequent observations preserve it.
  markBehind(now = Date.now()): void {
    this.behindSince ??= now;
  }

  markCaughtUp(): void {
    this.behindSince = undefined;
  }

  lagMs(now = Date.now()): number {
    return this.behindSince === undefined
      ? 0
      : Math.max(0, now - this.behindSince);
  }
}
