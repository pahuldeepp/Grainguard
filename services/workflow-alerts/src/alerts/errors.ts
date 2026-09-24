export class AlertNotFoundError extends Error {
  constructor() {
    super("alert not found");
  }
}

export class VersionConflictError extends Error {
  constructor(readonly currentVersion: bigint) {
    super(`alert is at version ${currentVersion}`);
  }
}

export class InvalidStateError extends Error {
  constructor(readonly state: string) {
    super(`alert is ${state} and cannot be acknowledged`);
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used for a different request");
  }
}

export class InvalidInputError extends Error {}
