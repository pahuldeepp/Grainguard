// Tracks how far the reading consumer is behind the topic head, in milliseconds of event
// time. The usage-period close waits until the lag is small so readings received in a
// month are counted in it. Not caught up means the lag keeps growing until the next batch.
export class ConsumerLag {
  private behindSince: number | undefined;

  // `caughtUp` is true when the batch's last offset reached the partition high watermark.
  // The first not-caught-up observation starts the clock; catching up clears it.
  observe(caughtUp: boolean, now = Date.now()): void {
    if (caughtUp) this.behindSince = undefined;
    else this.behindSince ??= now;
  }

  lagMs(now = Date.now()): number {
    return this.behindSince === undefined ? 0 : Math.max(0, now - this.behindSince);
  }
}
