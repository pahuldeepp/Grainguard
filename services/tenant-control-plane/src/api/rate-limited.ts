export class RateLimitedError extends Error {
  constructor(readonly retryAfter: number) {
    super("too many requests");
  }
}
