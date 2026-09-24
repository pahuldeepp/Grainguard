export class PreconditionRequiredError extends Error {
  constructor() {
    super("If-Match header is required");
  }
}
