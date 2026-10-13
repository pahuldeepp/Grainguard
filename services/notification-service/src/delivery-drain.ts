/** Tracks deliveries until their RabbitMQ ack/nack has completed. */
export class DeliveryDrain {
  private accepting = true;
  private readonly pending = new Set<Promise<void>>();
  private readonly errors: unknown[] = [];

  get isAccepting(): boolean {
    return this.accepting;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  track(delivery: Promise<void>): void {
    if (!this.accepting)
      throw new Error("cannot track a delivery after shutdown begins");
    const completed = delivery.then(
      () => {
        this.pending.delete(completed);
      },
      (error) => {
        this.pending.delete(completed);
        this.errors.push(error);
      },
    );
    this.pending.add(completed);
  }

  async wait(timeoutMs: number): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("delivery drain timeout must be a positive integer");
    if (this.pending.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...this.pending]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `notification delivery drain timed out with ${this.pending.size} unsettled message(s)`,
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (this.errors.length)
      throw new AggregateError(
        this.errors,
        "notification delivery settlement failed",
      );
  }
}
